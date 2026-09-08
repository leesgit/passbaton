#!/usr/bin/env node
/**
 * SessionEnd Hook (Stop 이벤트) - 세션 종료 시 자동 저장
 *
 * Claude Code 세션 종료 시 자동으로 컨텍스트를 저장합니다.
 *
 * Stop 이벤트 입력 필드:
 * - session_id, cwd, permission_mode, hook_event_name, stop_hook_active
 * - transcript_path: JSONL 파일 경로 (전체 대화 기록)
 * - last_assistant_message: 마지막 assistant 메시지 텍스트
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { logHookError, isCodexHost, isGeminiHost } from '../utils/logger.js';
import { isEnabled } from '../utils/config.js';
import { detectWorkspaceRoot } from '../utils/workspace.js';
import { filterTrackedPaths, partitionTrackedPaths, displayName } from '../utils/paths.js';
import { migrateSchema } from '../db/migrate.js';

/**
 * 결과를 뽑지 못했을 때 last_work 에 적는 값.
 *
 * 빈 문자열도, 사용자 프롬프트도 아니다. **모른다는 것을 아는 상태**를 기록한다 —
 * 읽는 쪽이 「이 턴은 결과가 안 잡혔다」와 「이 턴은 이런 일을 했다」를 구분할 수
 * 있어야 하고, 나중에 추출기를 고쳤을 때 개선폭을 셀 수 있어야 한다.
 */
const NO_OUTCOME = '(결과 요약 없음)';

interface SessionEndInput {
  cwd?: string;
  session_id?: string;
  // 호스트가 주는 턴 식별자. Claude Code = prompt_id, Codex = turn_id.
  // 둘 다 실측했고(2026-09-08), PostToolUse 도 같은 값을 받는 것을 확인했다.
  // 이 값이 있으면 「같은 턴인가」를 텍스트 유사도로 추측할 필요가 없다.
  prompt_id?: string;
  turn_id?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  // Stop 이벤트가 중첩 호출되는 경우 true (Claude Code 플랫폼 동작)
  stop_hook_active?: boolean;
  // 레거시: 이전 버전 호환
  transcript?: Array<{
    role: string;
    content: string;
  }>;
}

function getDbPath(cwd: string): string {
  const workspaceRoot = detectWorkspaceRoot(cwd);
  const claudeDir = path.join(workspaceRoot, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  return path.join(claudeDir, 'sessions.db');
}

function detectProject(cwd: string): string {
  const workspaceRoot = detectWorkspaceRoot(cwd);
  const appsDir = path.join(workspaceRoot, 'apps');

  if (cwd.startsWith(appsDir + path.sep)) {
    const relative = path.relative(appsDir, cwd);
    return relative.split(path.sep)[0];
  }

  if (cwd !== workspaceRoot) {
    let current = cwd;
    while (current !== workspaceRoot && current !== path.parse(current).root) {
      const pkgPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return pkg.name || path.basename(current);
        } catch {
          return path.basename(current);
        }
      }
      current = path.dirname(current);
    }
  }

  return path.basename(workspaceRoot);
}

/**
 * 마크다운 문법 제거 — 순수 텍스트로 변환
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*(.+?)\*/g, '$1')        // *italic* → italic
    .replace(/`([^`]+)`/g, '$1')        // `code` → code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [link](url) → link
    .replace(/#{1,6}\s*/g, '')           // ## heading → heading
    .trim();
}

/**
 * 텍스트 행이 "노이즈"인지 판별
 */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 15) return true;               // 너무 짧음
  if (trimmed.startsWith('|')) return true;             // 마크다운 테이블 행
  if (trimmed.startsWith('```')) return true;           // 코드 블록 경계
  if (trimmed.startsWith('---')) return true;           // 구분선
  if (/^[-*+]\s*$/.test(trimmed)) return true;          // 빈 리스트
  if (/^#+\s*$/.test(trimmed)) return true;             // 빈 헤딩
  if (/^\s*```/.test(trimmed)) return true;             // 들여쓴 코드 블록
  if (/^(Sources?|참고|Note|주의)[:\s]/i.test(trimmed)) return true; // 메타 텍스트
  return false;
}

/**
 * 단일 텍스트(last_assistant_message 등)에서 의미있는 요약 추출
 *
 * 우선순위:
 * 1. 구조화 마커 <!--SESSION:{"done":"..."}-->
 * 2. 완료 문장 패턴 (I've completed..., 구현 완료 등)
 * 3. 첫 의미있는 단락 (테이블/코드블록/리스트 제외)
 */
function extractSummaryFromText(content: string): string {
  if (!content || content.length < 10) return '';

  // 전처리: 테이블 행, 코드블록 제거 → 순수 텍스트
  const cleanedContent = content
    .replace(/```[\s\S]*?```/g, '')              // 코드블록 제거
    .split('\n')
    .filter(line => !line.trim().startsWith('|') && !line.trim().startsWith('---'))
    .join('\n');

  // 전략 1: 구조화 마커 (CLAUDE.md 규칙을 따르는 경우)
  const markerMatch = content.match(/<!--SESSION:(.*?)-->/s);
  if (markerMatch?.[1]) {
    try {
      const parsed = JSON.parse(markerMatch[1]);
      if (parsed.done && parsed.done.length > 5) return stripMarkdown(parsed.done).slice(0, 200);
    } catch { /* malformed JSON, fall through */ }
  }

  // 전략 2: 완료/성과 문장 추출 (정제된 텍스트에서)
  const completionMatch = cleanedContent.match(
    /(?:I've |I have |Successfully |completed |finished |implemented |fixed |created |added |updated |refactored |deployed |배포 완료|구현 완료|작업 완료|수정 완료|테스트 통과|빌드 성공)([^.!?\n]{5,150}[.!?]?)/i
  );
  if (completionMatch) {
    const sentence = stripMarkdown(completionMatch[0]).trim();
    if (sentence.length > 15) return sentence.slice(0, 200);
  }

  // 전략 3: ✅ 마커 뒤 텍스트 (정제된 텍스트에서)
  const checkMatch = cleanedContent.match(/✅\s*(.+)/);
  if (checkMatch?.[1]) {
    const cleaned = stripMarkdown(checkMatch[1]).trim();
    if (cleaned.length > 10) return cleaned.slice(0, 200);
  }

  // 전략 4: 첫 헤딩 제목 — 단, 일반적인 섹션 헤딩은 제외
  const headingMatch = cleanedContent.match(/^#{1,3}\s+(.+)$/m);
  if (headingMatch?.[1]) {
    const title = stripMarkdown(headingMatch[1]).trim();
    // "결과 요약", "평가", "분석" 같은 일반 헤딩은 의미없는 요약이므로 건너뜀
    const genericHeadings = /^(결과|요약|분석|평가|결론|테스트|현재|문제|핵심|다음|참고|MCP|Overview|Summary|Result|Analysis|Test)/i;
    if (title.length > 5 && !genericHeadings.test(title)) return title.slice(0, 200);
  }

  // 전략 5: 첫 의미있는 단락 (노이즈 라인 건너뜀)
  const lines = cleanedContent.split('\n');
  for (const line of lines) {
    if (isNoiseLine(line)) continue;
    const cleaned = stripMarkdown(line).trim();
    if (cleaned.length > 20) return cleaned.slice(0, 200);
  }

  return '';
}

/**
 * 다음 할 일 추출 (텍스트에서)
 */
function extractNextTasks(content: string): string[] {
  const nextTasks: string[] = [];

  const cleaned = content
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('|'))
    .join('\n');

  const nextPatterns = [
    /(?:next steps?|todo|remaining|다음 (?:단계|작업|할 일)|남은 작업|해야 할)[:\s]*([^.!?\n]{10,})/gi,
    // P1-2 (2026-08-10): 위 패턴은 영어 리포트체를 가정해 한국어 구어체에 0/18 히트였다.
    // 실제 대화에서 다음 작업이 표현되는 형태를 추가한다.
    /(?:남음|남은 것|다음은|이어서|아직)[:\s]*([^.!?\n]{10,})/gi,
    /([^.!?\n]{10,}?)(?:해야 (?:한다|함|합니다)|필요하다|필요함|필요합니다|하면 된다|하면 됩니다)/gi,
    /(?:^|\n)\s*(?:[-*]|\d+\.)\s*\[\s\]\s*([^\n]{10,})/gm,
  ];

  for (const pattern of nextPatterns) {
    let match;
    while ((match = pattern.exec(cleaned)) !== null) {
      if (match[1]) {
        const task = stripMarkdown(match[1]).trim().slice(0, 100);
        if (task.length > 10) nextTasks.push(task);
      }
    }
  }

  return nextTasks;
}

/**
 * 사용자 메시지를 유효한 요청인지 필터링
 */
function parseUserText(entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } }): string {
  // 슬래시 커맨드 확장으로 주입된 메타 턴은 사용자 요청이 아님
  // (예: "# /work - 프로젝트 작업 메인 명령어 (v2)…" 커맨드 본문 전체가 여기 들어옴)
  if (entry.isMeta === true) return '';

  const content = entry.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }

  // 슬래시 커맨드 실행 시 실제 사용자 요청은 <command-args> 안에 있음 → 삭제 말고 추출
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch && argsMatch[1].trim().length >= 3) {
    return argsMatch[1].trim();
  }

  // system-reminder, local-command 태그 제거
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  // Codex support (2026-07-09): Codex injects <environment_context> into the first user message -> strip it
  text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
  // Gemini support (2026-07-10): Gemini injects <session_context> into the first user message -> strip it
  text = text.replace(/<session_context>[\s\S]*?<\/session_context>/g, '').trim();
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim();
  text = text.replace(/<command-name>[\s\S]*?<\/command-name>/g, '').trim();
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>/g, '').trim();
  text = text.replace(/<command-args>[\s\S]*?<\/command-args>/g, '').trim();
  text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '').trim();
  if (text.length < 5) return '';

  // 시스템/메타 메시지 스킵
  if (text.startsWith('[Request interrupted')) return '';
  if (text.startsWith('This session is being continued')) return '';
  if (text.startsWith('No response requested')) return '';

  return text;
}

/**
 * 메시지 content에서 텍스트 추출 (assistant/human 공통)
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  return '';
}

/**
 * Codex support (2026-07-09): normalize a Codex CLI rollout JSONL line into the
 * Claude transcript entry shape, so the rest of parseTranscriptSinglePass
 * (role/content/timestamp/commit/user-request extraction) can be reused as-is.
 *
 * Codex format: {timestamp, type, payload}
 *   - payload.type=message, role=user/assistant, content[].text (input_text/output_text)
 *   - payload.type=function_call, arguments={command:["zsh","-lc","git commit..."]}
 *   - payload.type=session_meta (first line, ignored)
 *   - reasoning/token_count etc. are ignored
 * Returns a Claude-shaped entry ({type, timestamp, message:{content:[...]}}) or null (skip).
 */
function normalizeCodexLine(codexEntry: {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    arguments?: string;
  };
}): { type: string; timestamp?: string; message: { content: unknown } } | null {
  const p = codexEntry.payload;
  if (!p) return null;
  const ts = codexEntry.timestamp;

  // 1. user/assistant message -> text block
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = (p.content || [])
      .filter(c => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
      .map(c => c.text || '')
      .join('\n');
    if (!text) return null;
    return {
      type: p.role === 'user' ? 'user' : 'assistant',
      timestamp: ts,
      message: { content: [{ type: 'text', text }] },
    };
  }

  // 2. function_call(shell) -> tool_use block (for git commit extraction).
  //    Codex passes command as an argv array (["zsh","-lc","git commit -m ..."]).
  if (p.type === 'function_call' && p.arguments) {
    let cmd = '';
    try {
      const args = JSON.parse(p.arguments) as { command?: string[] };
      if (Array.isArray(args.command)) {
        // Codex uses ["zsh","-lc","<actual cmd>"]. The commit regex requires
        // "^git" or "&& git", so strip the shell wrapper (zsh/bash -lc/-c)
        // and keep only the actual command.
        const a = args.command;
        cmd = (a.length >= 3 && /^(zsh|bash|sh)$/.test(a[0]) && /^-[lc]+$/.test(a[1]))
          ? a.slice(2).join(' ')
          : a.join(' ');
      }
    } catch { /* arguments not JSON -> skip */ }
    if (!cmd) return null;
    return {
      type: 'assistant',
      timestamp: ts,
      message: { content: [{ type: 'tool_use', input: { command: cmd } }] },
    };
  }

  return null;  // skip reasoning/token_count/session_meta etc.
}

type ClaudeEntry = { type: string; timestamp?: string; message: { content: unknown } };
type GeminiMsg = { type?: string; role?: string; timestamp?: string; content?: Array<{ text?: string }> };

/** One Gemini message object -> Claude entry (or null to skip). */
function geminiMsgToEntry(m: GeminiMsg): ClaudeEntry | null {
  const t = m.type || m.role;  // some builds use role
  if (t !== 'user' && t !== 'gemini' && t !== 'model' && t !== 'assistant') return null;
  const text = (m.content || []).map(c => c.text || '').filter(Boolean).join('\n');
  if (!text) return null;
  return {
    type: t === 'user' ? 'user' : 'assistant',
    timestamp: m.timestamp,
    message: { content: [{ type: 'text', text }] },
  };
}

/**
 * Normalize a Gemini CLI transcript line into Claude entries (2026-07-10).
 * REAL Gemini format has two shapes (verified against actual ~/.gemini transcripts —
 * the docs claimed only the flat shape, but older sessions use the $set diff shape):
 *  A) flat:  {type:"user"|"gemini", content:[{text}], timestamp}
 *  B) diff:  {"$set":{"messages":[ {type/role, content:[{text}]}, ... ]}}
 * Top-level type:"info" lines and message_update patches are skipped.
 * Returns an array (shape B can carry multiple messages per line).
 */
function normalizeGeminiLine(raw: unknown): ClaudeEntry | ClaudeEntry[] | null {
  const entry = raw as { '$set'?: { messages?: GeminiMsg[] } } & GeminiMsg;
  // Shape B: $set.messages array
  const setMsgs = entry?.['$set']?.messages;
  if (Array.isArray(setMsgs)) {
    const out = setMsgs.map(geminiMsgToEntry).filter((e): e is ClaudeEntry => e !== null);
    return out.length ? out : null;
  }
  // Shape A: flat message line
  return geminiMsgToEntry(entry);
}

interface TranscriptData {
  commitMessages: string[];
  errorsSolved: string[];
  decisions: string[];
  userRequests: { firstRequest: string; allRequests: string[] };
  recentAssistantMessages: string[];
  errorFixPairs: Array<{ error: string; fix: string }>;
  firstTimestamp: string | null; // 세션 시작 시각 (transcript 첫 entry)
  lastTimestamp: string | null;  // 세션 종료 시각 (transcript 마지막 entry)
}

/**
 * Single-Pass Transcript Parser
 * JSONL을 1회 스트림으로 읽으며 모든 데이터를 동시 추출
 */
async function parseTranscriptSinglePass(transcriptPath: string): Promise<TranscriptData> {
  const result: TranscriptData = {
    commitMessages: [],
    errorsSolved: [],
    decisions: [],
    userRequests: { firstRequest: '', allRequests: [] },
    recentAssistantMessages: [],
    errorFixPairs: [],
    firstTimestamp: null,
    lastTimestamp: null,
  };

  if (!transcriptPath || !fs.existsSync(transcriptPath)) return result;

  // Host detection: Codex uses ~/.codex/sessions/...rollout-*.jsonl,
  // Gemini uses ~/.gemini/tmp/.../chats/*.jsonl, Claude uses ~/.claude/projects/...
  const isCodex = isCodexHost(transcriptPath);   // shared detection (argv marker or path)
  const isGemini = isGeminiHost(transcriptPath);

  // commit 추출용 패턴
  const commitPatterns = [
    /git commit.*?-m\s*"\$\(cat <<'?EOF'?\n(.+?)(?:\n\n|\nCo-Authored|\nEOF)/s,
    /git commit.*?-m\s*["']([^"'\n]{10,150})["']/,
  ];

  // decision 추출용 패턴
  const decisionPatterns = [
    /(?:chose|using|switched to|went with)\s+(.{10,80})\s+(?:because|since|instead of|over)/gi,
    /(?:instead of|rather than)\s+(.{10,60})/gi,
    /(.{10,60})(?:으로|로)\s+(?:결정|변경|전환)(?:했|함|합니다)/g,
    /(.{10,60})(?:대신|말고)\s+(.{10,60})(?:사용|적용)/g,
  ];

  // error-fix 추출용
  const recentEntries: Array<{ role: string; text: string }> = [];
  const commitSet = new Set<string>();
  const decisionSet = new Set<string>();

  try {
    const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rawEntry = JSON.parse(line);
        // Normalize per host into Claude entry shape. Gemini's $set line can yield
        // multiple entries, so unify everything into an array and process each.
        const normalized = isCodex ? normalizeCodexLine(rawEntry)
          : isGemini ? normalizeGeminiLine(rawEntry)
          : rawEntry;
        if (!normalized) continue;
        const entries = Array.isArray(normalized) ? normalized : [normalized];
        for (const entry of entries) {
        const role = entry.type || entry.role || '';
        const content = entry.message?.content;

        // === 0. Timestamp 추출 (세션 duration 계산용) ===
        if (entry.timestamp) {
          if (!result.firstTimestamp) result.firstTimestamp = entry.timestamp;
          result.lastTimestamp = entry.timestamp;
        }

        // === 1. Commit 추출 (tool_use 블록에서) ===
        if (line.includes('git commit') && Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_use') continue;
            const cmd = block.input?.command as string;
            if (!cmd || !cmd.includes('-m')) continue;
            if (!/(?:^|&&\s*)git\s+commit/.test(cmd)) continue;

            for (const pattern of commitPatterns) {
              const match = cmd.match(pattern);
              if (match?.[1]) {
                const msg = match[1].trim().split('\n')[0];
                if (msg.length > 10 && !msg.startsWith('Co-Authored')) {
                  commitSet.add(msg.slice(0, 150));
                }
                break;
              }
            }
          }
        }

        // === 2. User Requests 추출 ===
        if (role === 'human' || role === 'user') {
          const text = parseUserText(entry);
          if (text) {
            const planMatch = text.match(/^Implement the following plan:\s*\n+#\s*(.+)/);
            const cleaned = planMatch
              ? planMatch[1].trim().slice(0, 100)
              : stripMarkdown(text.split('\n')[0].trim()).slice(0, 100);

            if (cleaned && cleaned.length >= 3) {
              if (!result.userRequests.firstRequest) result.userRequests.firstRequest = cleaned;
              result.userRequests.allRequests.push(cleaned);
            }
          }
        }

        // === 3. Assistant 메시지 수집 (decisions + recentMessages) ===
        if (role === 'assistant') {
          const text = extractTextFromContent(content);
          if (text.length > 10) {
            // 최근 10개만 유지 (decision 추출용)
            result.recentAssistantMessages.push(text);
            if (result.recentAssistantMessages.length > 10) {
              result.recentAssistantMessages.shift();
            }
          }
        }

        // === 4. Error-Fix pair용 entries 수집 (최근 30개) ===
        const text = extractTextFromContent(content);
        if (text.length > 5) {
          recentEntries.push({ role, text: text.slice(0, 500) });
          if (recentEntries.length > 30) recentEntries.shift();
        }
        }  // end for (entry of entries)

      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  // === Post-processing ===

  // Commits
  result.commitMessages = [...commitSet].slice(0, 5);

  // Decisions (최근 assistant 메시지에서)
  for (const msg of result.recentAssistantMessages) {
    for (const pattern of decisionPatterns) {
      pattern.lastIndex = 0;
      const matches = msg.match(pattern);
      if (matches) {
        for (const m of matches.slice(0, 1)) {
          decisionSet.add(stripMarkdown(m).slice(0, 150));
        }
      }
    }
  }
  result.decisions = [...decisionSet].slice(0, 3);

  // Error-Fix pairs (한국어 패턴 보강)
  // P3 (2026-07-08): '충돌' 제거 — 영상 파이프라인 "충돌(collision) 컷" 잡담이
  // 에러로 오분류되던 주 원인. 진짜 conflict 에러는 라틴 토큰으로 매칭됨.
  const errorRe = /(?:error|Error|ERROR|오류|에러|버그|예외|실패|FAILED|Exception|TypeError|ReferenceError|SyntaxError|crash|crashed|문제)[:\s](.{5,80})/;
  const fixRe = /(?:fixed|resolved|patched|수정|해결|고침|처리|완료|변경|적용|반영|커밋|Added|수정 완료|문제 해결|해결됨|되돌림)/i;
  const pairSet = new Set<string>();

  for (let i = 0; i < recentEntries.length - 1; i++) {
    const errorMatch = recentEntries[i].text.match(errorRe);
    if (errorMatch) {
      for (let j = i + 1; j < Math.min(i + 4, recentEntries.length); j++) {
        if (recentEntries[j].role === 'assistant' && fixRe.test(recentEntries[j].text)) {
          const errorStr = stripMarkdown(errorMatch[0]).slice(0, 80);
          const fixLine = recentEntries[j].text.split('\n').find(l => fixRe.test(l));
          const fixStr = fixLine ? stripMarkdown(fixLine).slice(0, 80) : 'resolved';
          const pairKey = `${errorStr} → ${fixStr}`;
          if (!pairSet.has(pairKey)) {
            pairSet.add(pairKey);
            result.errorFixPairs.push({ error: errorStr, fix: fixStr });
          }
          break;
        }
      }
    }
  }
  result.errorsSolved = [...pairSet].slice(0, 3);

  // recentAssistantMessages → 최근 5개만 유지 (lastWork 폴백용)
  result.recentAssistantMessages = result.recentAssistantMessages.slice(-5);

  return result;
}

/**
 * 슬래시 커맨드 prefix 제거 — "/mcp-dev 측정해줘" → "측정해줘"
 * 첫 토큰이 `/`로 시작하면 다음 의미 토큰까지 스킵
 * 슬래시뿐이면 빈 문자열 반환 (호출자가 폴백 처리)
 */
function stripSlashPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return trimmed;
  // 첫 줄에서 슬래시 토큰을 제거
  const firstLine = trimmed.split('\n')[0];
  const tokens = firstLine.split(/\s+/);
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith('/')) i++;
  const rest = tokens.slice(i).join(' ').trim();
  if (rest.length >= 3) return rest;
  // 다음 줄에 의미 있는 본문이 있으면 사용
  const lines = trimmed.split('\n').slice(1).map(l => l.trim()).filter(l => l.length >= 3 && !l.startsWith('/'));
  return lines[0] || '';
}

/**
 * Jaccard 유사도 (토큰 단위) — 0~1 사이
 * 동일하면 1, 완전 다르면 0
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t.length >= 2)
  );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * URL 정규화: 같은 도메인 + path는 같은 노이즈로 취급
 * (P1-3, 2026-05-22) Google Forms ID, AdMob app ID 같은 동적 segment 제거
 *
 * 예: https://docs.google.com/forms/d/e/1FAIpQLScm.../viewform
 *  →  https://docs.google.com/forms/...
 */
function normalizeUrls(text: string): string {
  if (!text) return text;
  return text.replace(/(https?:\/\/[^\s]+)/gi, (match) => {
    try {
      const url = new URL(match);
      // path의 첫 1~2 segment만 유지, 나머지(ID/토큰)는 '...'로 축약
      const segments = url.pathname.split('/').filter(s => s);
      const keepCount = segments.length <= 2 ? segments.length : 2;
      const truncated = segments.slice(0, keepCount).join('/');
      return `${url.protocol}//${url.host}/${truncated}${segments.length > keepCount ? '/...' : ''}`;
    } catch {
      return match;
    }
  });
}

/**
 * 사용자 메시지들을 세션 요약으로 압축
 * 예: ["MCP 테스트해줘", "개선해줘", "npm 배포하고 커밋해줘"] → "MCP 테스트 + 개선 + npm 배포/커밋"
 */
function summarizeUserRequests(requests: string[]): string {
  if (requests.length === 0) return '';

  // 슬래시 커맨드 도움말 본문(/work, /clone-pro 등이 첫 줄에 박히는 케이스) 제외
  // → 36건 동일 last_work 누적 문제 해결
  const meaningful = requests
    .map(r => stripSlashPrefix(r))
    .filter(r => {
      if (!r) return false;
      if (/^[A-Z][a-z]+\s+(skill|command):/i.test(r)) return false;
      return r.length > 0;
    });
  const source = meaningful.length > 0 ? meaningful : requests;

  if (source.length === 1) return source[0];

  // 중복/유사 요청 제거 (앞 20글자 기준)
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const req of source) {
    const key = req.slice(0, 20).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(req);
    }
  }

  // 긴 세션: 첫 요청 + 마지막 2개 요청으로 세션 흐름 표현
  if (unique.length > 5) {
    const first = unique[0];
    const last2 = unique.slice(-2);
    const summary = `${first} ... ${last2.join(' + ')}`;
    return summary.length > 250 ? summary.slice(0, 250) : summary;
  }

  // 짧은 세션: 전부 연결
  const summary = unique.join(' + ');
  return summary.length > 250 ? summary.slice(0, 250) : summary;
}

async function main() {
  try {
    let inputData = '';
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    const input: SessionEndInput = inputData ? JSON.parse(inputData) : {};

    // 중복 호출 가드 1: stop_hook_active 플래그 (Claude Code 공식 플래그)
    if (input.stop_hook_active === true) {
      process.exit(0);
    }

    const cwd = input.cwd || process.cwd();
    const project = detectProject(cwd);
    const dbPath = getDbPath(cwd);

    // 중복 호출 가드 2: transcript_path 해시 기반 5초 윈도우 파일락
    // Phase 3: session_id 5초 락 도입 (sid 있는 호출만 차단됨)
    // Phase 5: 실측에서 모든 stop이 [sid 있는 호출 + sid 없는 호출] 페어로 들어옴
    //          → transcript_path 해시를 우선 키로 사용해야 같은 페어가 같은 락을 공유
    //          → transcript_path 없을 때만 session_id 폴백
    const lockKey = input.transcript_path
      ? crypto.createHash('md5').update(input.transcript_path).digest('hex').slice(0, 16)
      : (input.session_id || null);
    if (lockKey) {
      const lockPath = path.join(path.dirname(dbPath), `.session-end-${lockKey}.lock`);
      const now = Date.now();
      try {
        // Phase 5: atomic `wx` (존재 시 EEXIST throw) → 두 hook 인스턴스가 거의 동시에 진입하는 race 차단
        // 베이스라인: id=1606/1607이 ~500ms 차이로 동시 INSERT 됨 (debug.log 13:26:51.205 + 13:26:51.702)
        fs.writeFileSync(lockPath, String(now), { flag: 'wx' });
      } catch (e: unknown) {
        // 파일이 이미 존재 (다른 hook 인스턴스가 처리 중) → mtime 확인 후 5초 내면 차단
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          try {
            const lockMtime = fs.statSync(lockPath).mtimeMs;
            if (now - lockMtime < 5000) {
              process.exit(0); // 5초 내 재발화 차단
            }
            // 5초 지난 stale 락 → 덮어쓰기 (이 호출이 새 작업)
            fs.writeFileSync(lockPath, String(now));
          } catch {
            // stat/write 실패는 fail-soft
          }
        }
        // 그 외 락 파일 에러는 무시 (fail-soft)
      }
    }

    // 디버그 로그
    const debugLogPath = path.join(path.dirname(dbPath), 'session-end-debug.log');
    const inputKeys = Object.keys(input);
    const lastMsgLen = input.last_assistant_message?.length || 0;
    // P2 (audit-7 2026-07-20): log the resolved workspace root + whether it fell
    // back to cwd. A wrong root reads the wrong config/db, so a user's `config set`
    // can silently no-op. This makes that observable instead of fail-silent.
    const wsRoot = detectWorkspaceRoot(cwd);
    const wsFallback = wsRoot === cwd
      && !fs.existsSync(path.join(cwd, 'apps'))
      && !fs.existsSync(path.join(cwd, '.claude', 'sessions.db'));
    const debugLine = `[${new Date().toISOString()}] project=${project} sid=${input.session_id?.slice(0,8) || 'none'} keys=[${inputKeys.join(',')}] transcript_path=${input.transcript_path || 'none'} last_msg_len=${lastMsgLen} ws_root=${wsRoot}${wsFallback ? ' (fallback=cwd, config/db may be off-target)' : ''}\n`;
    fs.appendFileSync(debugLogPath, debugLine);

    if (!fs.existsSync(dbPath)) {
      console.log('[SessionEnd] No DB found, skipping');
      process.exit(0);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // 다중 hook 프로세스 동시성 보장

    // === 추출 시작 ===
    let lastWork = '';
    let nextTasks: string[] = [];
    let commitMessages: string[] = [];
    let errorsSolved: string[] = [];
    let decisions: string[] = [];

    // Single-pass transcript 파싱 (1회 스트림)
    let transcript: TranscriptData = {
      commitMessages: [], errorsSolved: [], decisions: [],
      userRequests: { firstRequest: '', allRequests: [] },
      recentAssistantMessages: [],
      errorFixPairs: [],
      firstTimestamp: null,
      lastTimestamp: null,
    };
    if (input.transcript_path) {
      transcript = await parseTranscriptSinglePass(input.transcript_path);
      commitMessages = transcript.commitMessages;
      errorsSolved = transcript.errorsSolved;
      decisions = transcript.decisions;
    }

    // === last_work 는 「무엇을 했는가」다. 요청이 아니다. ===
    //
    // ★ 옛 사다리는 사용자 프롬프트를 결과인 척 승격시켰다. 실측(최근 50행):
    //   프롬프트 원문 22 / 실제 결과 요약 **3** / 슬래시·기계 토큰 오염 25.
    //   그리고 누적이었다 — `firstRequest ... 직전 + 최신` 구조라 237행 중 94.1% 에
    //   `' + '`, 83.1% 에 `' ... '` 가 들어 있고, 한 문장이 4일간 21행의 머리에
    //   고착했다. 꼬리만 매번 달라지므로 COUNT(DISTINCT) 중복률은 「좋아졌는데」
    //   실제 정보 중복은 오히려 늘었다.
    //
    // ⛔ 그래서 (1) 턴 사이 연결을 없애고, (2) 요청은 last_work 가 아니라 별도
    //   컬럼(user_intent)에 넣고, (3) 결과를 못 뽑으면 **「결과 없음」이라고 적는다.**
    //   요청으로 대체하지 않는다 — 그게 지금까지 44% 를 만든 동작이다.
    //
    // 누적기(summarizeUserRequests)는 지우지 않고 남긴다: user_intent 가 여러 요청을
    // 담아야 할 때 쓸 수 있고, 무엇이 왜 폐기됐는지 코드에 남는 편이 낫다.
    const { allRequests } = transcript.userRequests;

    // 이 턴의 요청 = 트랜스크립트의 마지막 사용자 발화. 슬래시 prefix 는 벗긴다.
    const rawIntent = allRequests.length > 0 ? allRequests[allRequests.length - 1] : '';
    const userIntent = rawIntent ? (stripSlashPrefix(rawIntent) || rawIntent).slice(0, 250) : null;

    // 2a: 커밋 메시지 — 이 턴에 실제로 일어난 일 중 가장 강한 증거
    if (commitMessages.length > 0) {
      lastWork = commitMessages.slice(0, 3).join('; ');
    }

    // P1-2 (2026-08-10): nextTasks 추출을 `!lastWork` 폴백 밖으로 분리.
    //   기존에는 아래 2d/2c 폴백 안에서만 호출돼, 2a/2b/2c가 lastWork를 채우는
    //   정상 세션(대부분)에서는 도달조차 못 했다 — 실측 최근30일 376건 중 1건만 저장됨.
    //   lastWork 결정과 무관하게 항상 시도한다.
    if (input.last_assistant_message) {
      nextTasks = extractNextTasks(input.last_assistant_message);
    }
    if (nextTasks.length === 0 && transcript.recentAssistantMessages.length > 0) {
      for (let i = transcript.recentAssistantMessages.length - 1; i >= 0 && nextTasks.length === 0; i--) {
        nextTasks = extractNextTasks(transcript.recentAssistantMessages[i]);
      }
    }

    // 2d: last_assistant_message에서 추출
    if (!lastWork && input.last_assistant_message) {
      lastWork = extractSummaryFromText(input.last_assistant_message);
    }

    // 2c: transcript에서 최근 assistant 메시지 스캔 (이미 파싱됨)
    if (!lastWork && transcript.recentAssistantMessages.length > 0) {
      for (let i = transcript.recentAssistantMessages.length - 1; i >= 0; i--) {
        lastWork = extractSummaryFromText(transcript.recentAssistantMessages[i]);
        if (lastWork) break;
      }
    }

    // 2d: 액션 동사 기반 폴백 (이미 파싱된 메시지에서)
    if (!lastWork && transcript.recentAssistantMessages.length > 0) {
      const actionVerbs = /(?:created|modified|added|removed|fixed|updated|implemented|deployed|configured|refactored|만들|수정|추가|삭제|구현|배포|설정|완료)/i;
      for (const msg of [...transcript.recentAssistantMessages].reverse()) {
        const lines = msg.split('\n').filter(l => !isNoiseLine(l));
        for (const line of lines) {
          if (actionVerbs.test(line) && line.length > 20) {
            const cleaned = stripMarkdown(line).trim();
            if (cleaned.length > 15) { lastWork = cleaned.slice(0, 200); break; }
          }
        }
        if (lastWork) break;
      }
    }

    // 2e: 레거시 transcript 배열
    if (!lastWork && input.transcript) {
      const assistantMsgs = input.transcript.filter(m => m.role === 'assistant');
      if (assistantMsgs.length < 2) {
        console.log(`[SessionEnd] Skipping empty session for ${project}`);
        db.close();
        process.exit(0);
      }
      for (let i = assistantMsgs.length - 1; i >= Math.max(0, assistantMsgs.length - 5); i--) {
        lastWork = extractSummaryFromText(assistantMsgs[i].content);
        if (lastWork) break;
      }
    }

    // === modified_files ===
    //
    // ★ 우선순위는 「이 턴에 이 세션이 고친 것」 > 「프로젝트 최근 스냅샷」이다.
    // 뒤엣것은 프로젝트당 하나뿐이라 동시에 붙은 세션들이 서로를 덮었고, 그래서
    // 같은 payload 가 여러 행에 복제되고 남의 %TEMP% 스크래치패드가 「내가 고친
    // 파일」로 들어왔다(30일 창 2,896항목 중 520개, 18.0%).
    //
    // ★ session_id 가 없으면 예전 스냅샷으로 떨어진다. 훅 페이로드에 그 키가
    // 온다는 것은 선언일 뿐이므로, 없더라도 동작이 후퇴하지 않아야 한다.
    let modifiedFiles: string[] = [];
    let filesFromSession = false;

    const sessionId = input.session_id || null;

    if (sessionId) {
      try {
        // ★ 「행이 0개」와 「테이블이 없다」를 반드시 구분한다.
        //   행 0개 = 이 턴에 아무것도 안 고쳤다 → **빈 목록이 정답**이다.
        //   테이블 없음 = 이 호스트/DB 가 아직 턴 추적을 안 한다 → 폴백해야 한다.
        //   이걸 뭉개고 「비었으면 폴백」으로 두면, 아무것도 안 고친 턴이 옆
        //   세션의 파일 목록을 빌려온다 — 고치려던 그 증상 그대로다.
        const hasTable = db.prepare(`
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_files'
        `).get() as { 1: number } | undefined;

        if (hasTable) {
          const rows = db.prepare(`
            SELECT file_path FROM session_files
            WHERE session_id = ? AND project = ?
            ORDER BY updated_at DESC
          `).all(sessionId, project) as Array<{ file_path: string }>;

          modifiedFiles = rows.map(r => r.file_path);
          filesFromSession = true;
        }
      } catch { /* 조회 실패 → 폴백 */ }
    }

    if (!filesFromSession) {
      try {
        const activeCtx = db.prepare('SELECT recent_files FROM active_context WHERE project = ?').get(project) as { recent_files: string } | undefined;
        if (activeCtx?.recent_files) {
          modifiedFiles = JSON.parse(activeCtx.recent_files);

          // ⚠ 이건 이 세션의 편집이 아니다. active_context.recent_files 는
          //   프로젝트당 한 칸이라 **누가 만졌든** 최근 것이 들어 있다. 구버전
          //   호스트에서 아무것도 없는 것보다는 낫지만, 「이 턴의 편집」인 척하면
          //   안 된다 — 그게 처음부터 고치려던 증상이다.
          if (modifiedFiles.length > 0) {
            console.log(`[SessionEnd] modified_files is DEGRADED for ${project}: `
              + `no turn-scoped record, using the project-wide snapshot `
              + `(${modifiedFiles.length} path(s), attribution unknown)`);
          }
        }
      } catch { /* active_context may not exist */ }
    }

    // 과거에 쌓인 경로에도 같은 규칙을 적용한다 — 폴백 경로로 들어온 목록에는
    // 필터가 배포되기 전의 스크래치패드 항목이 그대로 남아 있다.
    //
    // 버린 개수를 찍는다. 이 규칙의 근거는 커버리지 실측이지 정밀도가 아니므로,
    // 오탐이 생겼을 때 조용히 사라지지 않아야 한다.
    {
      const part = partitionTrackedPaths(modifiedFiles);
      modifiedFiles = part.kept;
      if (part.excluded.length > 0) {
        console.log(`[SessionEnd] ${part.excluded.length} path(s) excluded from tracking `
          + `(e.g. ${displayName(part.excluded[0])})`);
      }
    }

    // last_work 최종 폴백: 파일 목록 기반
    if (!lastWork && modifiedFiles.length > 0) {
      const fileNames = modifiedFiles.slice(0, 5).map(f => displayName(f)).join(', ');
      lastWork = `Modified files: ${fileNames}`;
    }

    // Phase 5: 모든 last_work 결정 경로에 stripSlashPrefix 강제 적용
    // 베이스라인: 2a 경로(firstRequest)만 stripSlashPrefix 적용되고 2c~2e 폴백은 미적용
    //          → 같은 transcript에서 두 hook 인스턴스가 서로 다른 경로로 들어가
    //            한쪽은 "측정", 한쪽은 "/mcp-dev 측정"으로 분기 → Jaccard 0.85 미달로 둘 다 통과
    //          stripSlashPrefix가 빈 문자열을 반환하면 원본 유지 (의미 토큰이 없는 경우)
    if (lastWork) {
      const stripped = stripSlashPrefix(lastWork);
      if (stripped) lastWork = stripped;
    }

    // ★ 결과를 못 뽑았다면 그렇게 적는다. 요청으로 메우지 않는다.
    //
    // 단 아무 증거도 없는 턴(요청도·파일도·커밋도 없음)은 여전히 건너뛴다 — 그건
    // 「결과 없음」이 아니라 「기록할 것이 없음」이다.
    if (!lastWork) {
      const hasAnything = Boolean(userIntent) || modifiedFiles.length > 0
        || commitMessages.length > 0 || decisions.length > 0 || errorsSolved.length > 0;

      if (!hasAnything) {
        console.log(`[SessionEnd] Skipping empty session for ${project} (no evidence at all)`);
        db.close();
        process.exit(0);
      }

      lastWork = NO_OUTCOME;
    }

    // 스키마 확장 — 세션·턴 식별자와 요청을 컬럼으로 갖는다.
    // 훅은 서버의 initDatabase 를 거치지 않고 DB 를 직접 열므로 여기서 보강한다.
    // 이미 있으면 ALTER 가 던지고 그게 정상이다.
    const turnId = input.prompt_id || input.turn_id || null;
    let hasTurnColumns = false;
    try {
      migrateSchema(db);
      const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
        .map(c => c.name);
      hasTurnColumns = cols.includes('session_id') && cols.includes('prompt_id') && cols.includes('user_intent');
    } catch { /* 보강 실패 → 구스키마로 동작 */ }

    // ★ 턴 식별자가 있으면 그것이 정체성이다. 유사도로 추측하지 않는다.
    //
    // 옛 3단계 dedup(exact 24h → URL 정규화 → Jaccard ≥ 0.85)은 「같은 사건인가」를
    // **텍스트가 비슷한가**로 대신 판정했다. 그래서 둘 다 틀렸다:
    //   • 다른 턴인데 문장이 비슷하면 삼켰다 — 하루 19발화 → 9행
    //   • 같은 턴의 재발화인데 문장이 달라지면 통과시켰다
    // 그리고 last_work 가 결과 요약으로 바뀌면서 「(결과 요약 없음)」이 여러 턴에
    // 반복되므로, 텍스트 기준을 그대로 두면 정상 턴이 통째로 사라진다.
    //
    // 식별자가 없는 호스트에서는 아래 옛 경로가 그대로 돈다 — 후퇴시키지 않는다.
    if (turnId && hasTurnColumns) {
      const already = db.prepare(`
        SELECT id FROM sessions
        WHERE project = ? AND session_id IS ? AND prompt_id = ?
        LIMIT 1
      `).get(project, sessionId, turnId);

      if (already) {
        console.log(`[SessionEnd] Skipping re-fire of the same turn (${turnId.slice(0, 8)}) for ${project}`);
        db.close();
        process.exit(0);
      }
    }

    // 중복 저장 방지 — 3단계 dedup (턴 식별자가 없을 때만)
    // P1-3 (2026-05-22): Q8에서 발견된 3 클러스터(25 세션) 분석 결과
    //   • Google Forms URL × 12 (1h~2h 간격) — URL 정규화 + 24h 윈도우로 해결
    //   • IAP "이어서 진행해줘" × 8 (5h 분포, 동일 텍스트) — 24h exact로 해결
    //   • AdMob URL × 5 — URL 정규화로 해결
    // 1단계: 24시간 내 exact 일치 차단 (이전 1h → 24h, 동일 last_work 반복 막음)
    // 2단계: URL 정규화 후 exact 일치 (Forms/AdMob ID 무시)
    // 3단계: stripSlashPrefix 정규화 후 Jaccard >= 0.85 (1h 윈도우)
    // 턴 식별자가 없는 호스트에서만 도는 옛 경로. 위 정체성 검사가 성립하면
    // 이 유사도 판정은 정상 턴을 삼키기만 한다.
    if (!(turnId && hasTurnColumns)) {
      const recentExact = db.prepare(`
        SELECT id FROM sessions
        WHERE project = ? AND last_work = ? AND timestamp > datetime('now', '-24 hour')
        LIMIT 1
      `).get(project, lastWork);
      if (recentExact) {
        console.log(`[SessionEnd] Skipping duplicate (exact, 24h) for ${project}`);
        db.close();
        process.exit(0);
      }

      // 2단계: URL 정규화 후 exact (24h 윈도우)
      const normalizedLastWorkUrl = normalizeUrls(lastWork);
      if (normalizedLastWorkUrl !== lastWork) {
        const recent24h = db.prepare(`
          SELECT last_work FROM sessions
          WHERE project = ? AND timestamp > datetime('now', '-24 hour')
          ORDER BY timestamp DESC LIMIT 20
        `).all(project) as Array<{ last_work: string }>;
        for (const row of recent24h) {
          if (!row.last_work) continue;
          if (normalizeUrls(row.last_work) === normalizedLastWorkUrl) {
            console.log(`[SessionEnd] Skipping URL-normalized duplicate for ${project}`);
            db.close();
            process.exit(0);
          }
        }
      }

      // 3단계: Jaccard 유사도 (24h 윈도우)
      // P2 (2026-07-08): 1h 윈도우가 너무 좁아 시간 넘는 near-dup이 통과했음.
      //   실측: /mcp-dev 클러스터 60건이 수 시간~수일 간격으로 반복 저장됨.
      //   1·2단계(exact/URL)가 이미 24h이므로 Jaccard만 1h인 건 불일치 → 24h로 통일.
      //   임계값 0.85는 매우 높아 "진짜 다른 작업"은 24h로 넓혀도 통과(Phase 4 검증).
      const recentRows = db.prepare(`
        SELECT last_work FROM sessions
        WHERE project = ? AND timestamp > datetime('now', '-24 hour')
        ORDER BY timestamp DESC LIMIT 30
      `).all(project) as Array<{ last_work: string }>;
      for (const row of recentRows) {
        if (!row.last_work) continue;
        const normalizedCurrent = stripSlashPrefix(lastWork) || lastWork;
        const normalizedRow = stripSlashPrefix(row.last_work) || row.last_work;
        if (jaccardSimilarity(normalizedCurrent, normalizedRow) >= 0.85) {
          console.log(`[SessionEnd] Skipping near-duplicate (jaccard >= 0.85) for ${project}`);
          db.close();
          process.exit(0);
        }
      }
    }

    // 구조화 메타데이터 (issues 컬럼 활용)
    const metadata = {
      commits: commitMessages,
      decisions,
      errorsSolved
    };
    const hasMetadata = commitMessages.length > 0 || decisions.length > 0 || errorsSolved.length > 0;

    // P3 (2026-07-08): duration_minutes 계산 폐기.
    // transcript first↔last 차이는 resume/continue 시 벽시계 경과(최대 30일)를 담아
    // 실측 33%가 24h 초과로 신뢰 불가였고, 이 필드를 읽는 소비처가 코드 전체에 없음.
    // 컬럼은 스키마에 유지(NULL로 남김), INSERT만 중단.

    // 세션 기록 저장 — 원자적 조건부 INSERT로 페어 race 차단.
    // P2b (2026-07-08): 두 hook 인스턴스가 같은 초에 동시 발화하면(transcript 락을
    //   우회한 sid-less 페어) 앞 단계 dedup은 서로의 미커밋 행을 못 봐 둘 다 통과 →
    //   id 897/898처럼 동일 last_work+timestamp 2행 저장(실측 재현).
    //   INSERT ... WHERE NOT EXISTS로 "최근 10초 내 동일 project+last_work"를 원자적
    //   단일 문장에서 재확인 → race 윈도우 제거. 10초 초과 정당한 재작업은 통과.
    // ★ 읽기 → 조건부 INSERT → 회수를 **한 트랜잭션 안에서** 한다.
    //
    // 앞쪽(=== modified_files ===)의 읽기는 last_work 폴백 문구를 만들기 위한 것이고,
    // 그 지점과 여기 사이에는 Jaccard dedup 질의 3개가 끼어 있다. 그 창에 PostToolUse
    // 가 파일 b 를 기록하면 다음이 벌어졌다:
    //
    //     Stop: session_files 읽음 → [a]
    //     PostToolUse: b 기록
    //     Stop: modified_files=[a] 로 INSERT
    //     Stop: DELETE ... WHERE session_id=? AND project=?     ← b 까지 지운다
    //     → b 는 어느 행에도 실리지 못하고 사라진다
    //
    // 그래서 (1) 권위 있는 읽기를 트랜잭션 안으로 옮기고, (2) 삭제를 **실제로 실은
    // 경로들로 한정**한다. BEGIN IMMEDIATE 로 쓰기 예약을 읽기 전에 잡아, 동시
    // Stop 은 기다리거나 busy 로 떨어진다. 커밋 전 크래시는 INSERT 와 DELETE 를 함께
    // 되돌린다.
    //
    // ⚠ 다만 이것으로 「행 = 정확히 한 턴」이 되지는 않는다. dedup 에 걸려 INSERT 가
    //   0행이면 파일을 남기므로, 그때 modified_files 의 의미는 「이 턴」이 아니라
    //   **「마지막으로 기록된 행 이후」**다. 유사도로 턴을 버리면서 정확한 턴 귀속을
    //   동시에 주장할 수는 없다. dedup 키 자체(project + 유사 텍스트)는 이 수정의
    //   범위 밖이고 별도 결정이 필요하다.
    // ★ 원자적 조건부 INSERT. 조건도 턴 식별자가 있으면 그것으로 건다 —
    //   같은 초에 두 인스턴스가 발화해도 같은 턴이면 하나만 들어간다.
    const insertStmt = turnId && hasTurnColumns
      ? db.prepare(`
          INSERT INTO sessions
            (project, last_work, next_tasks, modified_files, issues, session_id, prompt_id, user_intent)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE project = ? AND session_id IS ? AND prompt_id = ?
          )
        `)
      : db.prepare(`
          INSERT INTO sessions (project, last_work, next_tasks, modified_files, issues)
          SELECT ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE project = ? AND last_work = ?
              AND timestamp > datetime('now', '-10 seconds')
          )
        `);

    const commit = db.transaction((): { changes: number; files: string[] } => {
      // 권위 있는 재읽기 — 앞쪽 읽기 이후에 들어온 편집까지 이 행에 싣는다.
      let files = modifiedFiles;

      if (sessionId && filesFromSession) {
        const rows = db.prepare(`
          SELECT file_path FROM session_files
          WHERE session_id = ? AND project = ?
          ORDER BY updated_at DESC
        `).all(sessionId, project) as Array<{ file_path: string }>;
        files = filterTrackedPaths(rows.map(r => r.file_path));
      }

      const shipped = files.slice(0, 15);

      const common = [
        project,
        lastWork,
        JSON.stringify([...new Set(nextTasks)].slice(0, 5)),
        JSON.stringify(shipped),
        hasMetadata ? JSON.stringify(metadata) : null,
      ];

      const res = turnId && hasTurnColumns
        ? insertStmt.run(...common, sessionId, turnId, userIntent, project, sessionId, turnId)
        : insertStmt.run(...common, project, lastWork);

      // 회수 — 행이 실제로 들어갔을 때만, 그리고 **실은 경로들만** 지운다.
      // 15개 상한에 잘려 나간 나머지는 남겨 다음 행에 실리게 한다.
      if (res.changes > 0 && sessionId && filesFromSession && shipped.length > 0) {
        const del = db.prepare(
          'DELETE FROM session_files WHERE session_id = ? AND project = ? AND file_path = ?'
        );
        for (const f of shipped) del.run(sessionId, project, f);
      }

      return { changes: res.changes, files };
    });

    let sessionInsert = { changes: 0 };
    try {
      const r = commit.immediate();
      sessionInsert = { changes: r.changes };
      modifiedFiles = r.files;
    } catch (e) {
      // SQLITE_BUSY 등 — 다른 Stop 이 같은 순간에 잡고 있다. 이 턴의 파일은 남으므로
      // 다음 턴 행에 실린다. 유실이 아니라 지연이다.
      logHookError('session-end/commit', e);
    }

    // 활성 컨텍스트 업데이트
    db.prepare(`
      INSERT OR REPLACE INTO active_context (project, current_state, recent_files, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(
      project,
      lastWork,
      JSON.stringify(modifiedFiles.slice(0, 15))
    );

    // 에러→솔루션 자동 기록 (solutions 테이블)
    // P1-4 (2026-05-22): 품질 필터 + 동일 solution 텍스트 dedup 추가
    let solutionsRecorded = 0;
    // wsRoot는 위(디버그 로그)에서 이미 detectWorkspaceRoot(cwd)로 계산됨 — 재사용.
    // solutionCapture 토글 (기본 on = 하위호환, v1부터 있던 기능).
    // off면 error→fix 자동기록 자체를 건너뜀 (세션저장은 유지).
    const solutionCaptureOn = isEnabled('solutionCapture', wsRoot);
    // strictSolutionGate 토글 (기본 off = 하위호환, 기존 라틴문자 게이트 유지).
    // on일 때만 audit-7 P0 엄격 게이트(노이즈 80%→~50%, 단 일부 진짜에러 false-neg 가능).
    const strictGate = isEnabled('strictSolutionGate', wsRoot);
    if (solutionCaptureOn && transcript.errorFixPairs.length > 0) {
      try {
        for (const pair of transcript.errorFixPairs) {
          const errSig = pair.error?.trim() || '';
          const sol = pair.fix?.trim() || '';

          // 품질 필터: stub/짧음/footer 거부
          if (sol.length < 30) continue;
          if (/^(\[이미\s*완료\]|✅\s*완료|✅\s*푸시\s*완료|done|완료)\s*$/i.test(sol)) continue;
          if (sol.includes('Co-Authored-By:')) continue;
          if (errSig.length < 5) continue;

          if (!strictGate) {
            // ── 기본(off): 기존 라틴문자 게이트 (v2.0.0 하위호환) ──
            const hasErrorSignal =
              /[A-Za-z]/.test(errSig) ||
              /(실패|오류|누락|초과|깨짐|깨진|중단|크래시|안 ?됨|불가|타임아웃|한도)/.test(errSig);
            if (!hasErrorSignal) continue;
          } else {
          // ── strict(on): audit-7 P0 재설계 게이트 ──
          // P0 (2026-07-18, audit-7): error_signature 품질 게이트 재설계.
          // 이전 게이트('라틴문자 1자라도 있으면 통과')는 82% 노이즈 직통로였음
          // (실측 last-50 진짜에러 ~10/50). 라틴 통과가 tool/hook 자기출력·스킬목록·
          // 대화파편을 전부 흘려보냄. 3단계로 교체:
          //   (1) 자기출력/메타 블랙리스트 거부 (X 실측 노이즈 실제 패턴)
          //   (2) 문장중간 잘린 파편 거부 (한글 서술 조사로 시작/끝나는 것)
          //   (3) 진짜 에러 구조신호 요구 (영어 에러클래스/스택/코드/경로 OR 한국어 에러표현)
          // 회귀 방지: 한국어 진짜에러 통과율 유지가 목표(임베딩 필터 false-neg 전례).

          // (1) 자기출력/메타 노이즈 블랙리스트 — passbaton hook 출력, 툴 스키마,
          //     스킬 목록, 에이전트 설명이 시그니처로 새던 실측 패턴.
          const NOISE_BLACKLIST = /(Solutions auto-recorded|Errors?\s*:\s*\d|is_error|auto-recorded|스킬|어시스턴트|logic errors|potential root cause|FEASIBLE|BLOCKED|CONFIRMED|verdict|findings|The problem|README)/i;
          if (NOISE_BLACKLIST.test(errSig)) continue;

          // (2) 스킬/커맨드 목록 파편 (`/fix - ...`, `/algo`, `/work` 등) 거부.
          if (/^\/?[a-z][a-z-]{1,20}\s*[-–]\s/i.test(errSig)) continue;

          // (3) 잘린 대화 파편: 한글 종결/연결 조사로 끝나거나 닫는 괄호로 시작.
          if (/(습니다|했습니다|봅니다|됩니다|합니다|았다|었다|한다|이다|진행|경우|때문|이니까|으니|주세요|보입니다|입니다)[.)\s]*$/.test(errSig)) continue;
          if (/^[)\]}]/.test(errSig.trim())) continue;

          // (3b) 내레이션 문장 거부: 한글 서술 어미/조사가 문장 중간에 다수 출현하면
          //      에러 시그니처(짧은 명사구/코드)가 아니라 대화 서술문. errorRe가
          //      "에러 상태 + 재시도...", "실패 시 사용자는..." 같은 내 설명을
          //      '에러'/'실패' 단어만 보고 잡아낸 것 → 실측 노이즈 대다수가 이 유형.
          const koreanNarrationMarkers = (errSig.match(/(습니다|봅니다|합니다|됩니다|입니다|해요|어요|아요|는데|니까|면서|하면|해서|처럼|같은|이제|먼저|그다음|여기)/g) || []).length;
          if (koreanNarrationMarkers >= 2) continue;

          // (4) 진짜 에러 구조신호 요구.
          //   - 영어: 에러클래스/빌드실패/스택프레임/에러코드/경로:줄
          //   - 한국어: 구체적 에러 표현 (단, 내레이션은 위에서 이미 걸러짐)
          const hasStructuredError =
            /(TypeError|ReferenceError|SyntaxError|RangeError|Error:|Exception|Traceback|ENOENT|ECONN|EADDR|EEXIST|MODULE_NOT_FOUND|undefined|null|NaN|failed|Failed|cannot|Cannot|at \w+ \(|:\d+:\d+|\.\w{1,4}:\d+)/.test(errSig);
          const hasKoreanError =
            /(실패|오류|에러|누락|초과|깨짐|깨진|중단|크래시|안 ?됨|불가|타임아웃|한도|충돌|먹통|리셋|무한|폭주|ANR|누수|롤백)/.test(errSig);
          if (!hasStructuredError && !hasKoreanError) continue;
          } // ── end strict gate ──

          // 1차 dedup: 동일 error_signature
          const existingByError = db.prepare(
            'SELECT id FROM solutions WHERE project = ? AND error_signature = ? LIMIT 1'
          ).get(project, errSig);
          if (existingByError) continue;

          // 2차 dedup: 동일 solution 텍스트 (다른 error라도 같은 해법은 중복)
          const existingBySol = db.prepare(
            'SELECT id FROM solutions WHERE project = ? AND solution = ? LIMIT 1'
          ).get(project, sol);
          if (existingBySol) continue;

          db.prepare(
            'INSERT INTO solutions (project, error_signature, solution) VALUES (?, ?, ?)'
          ).run(project, errSig, sol);
          solutionsRecorded++;
        }
      } catch { /* solutions table may not exist */ }
    }

    // architecture_decisions 자동 누적 (세션에서 추출된 결정사항 병합)
    if (decisions.length > 0) {
      try {
        const existing = db.prepare(
          'SELECT architecture_decisions FROM project_context WHERE project = ?'
        ).get(project) as { architecture_decisions: string } | undefined;

        let existingDecisions: string[] = [];
        if (existing?.architecture_decisions) {
          try { existingDecisions = JSON.parse(existing.architecture_decisions); } catch { /* ignore */ }
        }

        // 중복 제거 후 병합 (최대 20개 유지)
        const merged = [...new Set([...existingDecisions, ...decisions])].slice(-20);
        db.prepare(`
          INSERT INTO project_context (project, architecture_decisions)
          VALUES (?, ?)
          ON CONFLICT(project) DO UPDATE SET architecture_decisions = ?
        `).run(project, JSON.stringify(merged), JSON.stringify(merged));
      } catch { /* project_context table may not exist */ }
    }

    // 고품질 자동 메모리 추출 (v1.10 노이즈 제거 정책 유지하면서 가치 있는 것만)
    // - decisions: 의미있는 의사결정 (importance=7)
    // - commits: feat/fix만 (importance=6)
    // - 동일 content 중복 방지 (검색해서 없을 때만 INSERT)
    try {
      const memoryDupCheck = db.prepare(
        'SELECT id FROM memories WHERE project = ? AND content = ? LIMIT 1'
      );
      const memoryInsert = db.prepare(`
        INSERT INTO memories (content, memory_type, tags, project, importance)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const decision of decisions) {
        if (decision.length < 15) continue;
        if (!memoryDupCheck.get(project, decision)) {
          memoryInsert.run(decision, 'decision', JSON.stringify(['auto-extracted']), project, 7);
        }
      }

      // feat/fix 커밋만 (chore, docs, style은 학습 가치 낮음)
      for (const commit of commitMessages) {
        if (!/^(feat|fix)(\(.+\))?:/i.test(commit)) continue;
        if (commit.length < 20) continue;
        if (!memoryDupCheck.get(project, commit)) {
          memoryInsert.run(commit, 'learning', JSON.stringify(['auto-extracted', 'commit']), project, 6);
        }
      }
    } catch { /* memories table issue, skip */ }

    // 세션 임베딩 사전 생성 (search_sessions 성능 최적화)
    try {
      const lastSession = db.prepare(
        'SELECT id FROM sessions WHERE project = ? ORDER BY timestamp DESC LIMIT 1'
      ).get(project) as { id: number } | undefined;

      if (lastSession && lastWork) {
        // 간단한 임베딩은 동기적으로 시도하지 않고 DB에 표시만 남김
        // MCP 서버의 generateEmbedding이 search 시 캐시 miss에서 lazy 생성
        // session-end 훅은 transformers 모델 로드 오버헤드가 크므로 skip
      }
    } catch { /* ignore */ }

    db.close();

    console.log(`[SessionEnd] Saved session for ${project}`);
    console.log(`  Last work: ${lastWork.slice(0, 80)}`);
    console.log(`  Commits: ${commitMessages.length}, Decisions: ${decisions.length}, Errors: ${errorsSolved.length}`);
    console.log(`  Solutions auto-recorded: ${solutionsRecorded}`);
    console.log(`  Modified files: ${modifiedFiles.length}`);
    console.log(`  Next tasks: ${nextTasks.length}`);

    process.exit(0);
  } catch (e) {
    logHookError('session-end', e);
    process.exit(0);
  }
}

main();
