#!/usr/bin/env node
/**
 * UserPromptSubmit Hook - 매 프롬프트마다 관련 컨텍스트 자동 주입
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { logHookError, emitContext } from '../utils/logger.js';
import { tokenizeQuery } from '../utils/tokenize.js';

interface PromptInput {
  prompt?: string;
  cwd?: string;
  transcript_path?: string;
}

function detectWorkspaceRoot(cwd: string): string {
  let current = cwd;
  const root = path.parse(current).root;

  while (current !== root) {
    if (fs.existsSync(path.join(current, 'apps'))) return current;
    if (fs.existsSync(path.join(current, '.claude', 'sessions.db'))) return current;
    current = path.dirname(current);
  }

  return cwd;
}

function getProject(cwd: string, workspaceRoot: string): string | null {
  const appsDir = path.join(workspaceRoot, 'apps');

  // apps/ 하위인지 확인
  if (cwd.startsWith(appsDir + path.sep)) {
    const relative = path.relative(appsDir, cwd);
    return relative.split(path.sep)[0];
  }

  // apps/ 외부 하위 프로젝트 (hackathons/ 등)
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

  // 워크스페이스 루트 (모노레포 포함) → 폴더명 반환
  return path.basename(workspaceRoot);
}

// ===== 과거 참조 자동 감지 =====

const PAST_REFERENCE_PATTERNS: RegExp[] = [
  // 한국어 - 시간 참조
  /(?:저번에|전에|이전에|그때|지난번에|예전에|아까)\s+(.+?)(?:\s*(?:어떻게|뭐|무엇|왜|어디|언제))/,
  /(?:했던|했었던|만들었던|수정했던|구현했던|해결했던)\s*(.+)/,
  /(?:지난|이전|전)\s*(?:세션|작업|시간|번).*?(?:에서|때)\s*(.+)/,
  // 한국어 - 보유/기억 질문 ("내꺼 GCP 코인 정보 가지고 있나?")
  /(?:내|내꺼|우리)\s+(.+?)\s+(?:가지고\s*있|있어|있나|있지|있냐|남아|남았|저장)/,
  /(.+?)\s+(?:기억해|기억하고|기억나|알고\s*있|아는)/,
  /(?:저장한|기록한|적어둔|메모한|남긴)\s+(.+)/,
  // 영어
  /(?:last time|before|previously|earlier)\s+(?:.*?)\s*((?:how|what|why|where|when).*)/i,
  /(?:did we|did I|have we|have I)\s+(.+)\s+(?:before|last time|earlier)/i,
  /(?:remember when|recall when|do you remember|do you recall)\s+(.+)/i,
  /(?:do you have|do you know|got)\s+(.+?)\s+(?:info|information|saved|stored|record)/i,
];

function extractPastKeywords(prompt: string): string | null {
  for (const pattern of PAST_REFERENCE_PATTERNS) {
    const match = prompt.match(pattern);
    if (match?.[1]) {
      // 추출된 키워드에서 조사/의문사 제거, 핵심 단어만
      return match[1].trim().replace(/[?？\s]+$/g, '').slice(0, 50);
    }
  }
  return null;
}

/**
 * Prompt에서 의미 있는 한국어/영어 키워드 추출 (트리거용, 최대 5개)
 * 토큰화 로직은 utils/tokenize.ts로 공용화됨 (memory_search와 공유, 2026-07-09).
 * 트리거는 프롬프트 길이 5 미만이면 스킵.
 */
function extractTriggerKeywords(prompt: string): string[] {
  if (!prompt || prompt.length < 5) return [];
  return tokenizeQuery(prompt, 5);
}

/**
 * IDF 필터: 너무 흔한 토큰 제거
 * (2026-05-23: "commit and push" false positive 발견 — feat/commit/fix 같은
 *  커밋 메시지 토큰이 14/85 메모리에 등장해 IDF가 낮음)
 *
 * IDF = log(N / df), N = 총 메모리 수
 * 임계값 IDF >= 2.0 (= 흔한 토큰 약 13% 이상 등장 시 제외)
 * 실측: commit(idf 1.80), feat(1.96) 차단 + ec2(4.44), 서명키(4.44) 통과
 *
 * v1.14.3 (2026-05-23): df=0 토큰은 살리지 않고 제외 (이전엔 살림).
 * 이유: "check next session for live verification" 케이스에서 session/live/
 *      verification은 df=0인데 살아서 카운트만 채우고 실제 매칭은 next 단일
 *      토큰("Next.js")에 의해 false positive 발생. df=0 토큰은 FTS5 매칭에
 *      기여 0이므로 trigger 조건 자체에서 제외하는 게 맞음.
 *
 * @returns 살아남은 키워드 + 각 df (P1 audit-7 2026-07-08: df를 함께 반환해
 *          searchTriggeredMemories의 inCorpus 재쿼리 제거)
 */
function filterByIdf(db: Database.Database, keywords: string[]): Array<{ kw: string; df: number }> {
  if (keywords.length === 0) return [];

  try {
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    const N = Math.max(totalRow.n, 1);

    const survived: Array<{ kw: string; df: number }> = [];
    const stmt = db.prepare('SELECT COUNT(*) AS df FROM memories_fts WHERE memories_fts MATCH ?');

    for (const kw of keywords) {
      try {
        const ftsQ = `"${kw.replace(/"/g, '""')}"`;
        const row = stmt.get(ftsQ) as { df: number };
        const df = row.df;
        // v1.14.3 다시 정정: df=0 토큰은 살림 (한국어 부분일치/표기 차이 보완)
        // 예: 메모리에 "비번"으로 적혔지만 사용자가 "비밀번호" 입력 → df=0, 그러나
        //     같이 추출된 "서명키"가 매칭해주면 trigger 정상 작동
        if (df === 0) {
          survived.push({ kw, df: 0 });
          continue;
        }
        const idf = Math.log(N / df);
        if (idf >= 2.0) {
          survived.push({ kw, df });
        }
      } catch {
        survived.push({ kw, df: -1 });  // FTS5 구문 오류 시 보수적으로 살림 (df 불명=-1)
      }
    }
    return survived;
  } catch {
    return keywords.map(kw => ({ kw, df: -1 }));  // DF 측정 실패 시 원본 그대로
  }
}

/**
 * Proactive trigger: 추출된 키워드로 memories_fts + bm25 검색
 * 임계값: bm25 score < -2 (강한 매칭만, false positive 최소화)
 * + IDF 필터로 너무 흔한 토큰(commit/feat/fix 등) 제거
 *
 * @returns top 2 매칭 memories (or empty)
 */
function searchTriggeredMemories(
  db: Database.Database,
  keywords: string[],
  project: string | null
): Array<{ content: string; memory_type: string; score: number }> {
  // IDF 필터: 흔한 토큰 제거
  const meaningful = filterByIdf(db, keywords);
  if (meaningful.length < 2) return [];  // IDF 통과 토큰 2개 이상일 때만 trigger

  // P1 (2026-07-08): 실제 코퍼스에 존재하는(df>0) 토큰이 2개 이상일 때만 trigger.
  //   filterByIdf가 df=0 토큰(코퍼스에 없음)을 살려주는데, 그게 length>=2 게이트를
  //   우회시켜 실질 단일 토큰 매칭으로 trigger되던 오탐 차단.
  //   예: "gmail draft로 저장" → gmail(df=1) + draft로(df=0) → 실매칭 1개인데 trigger됐음.
  //   audit-7 2026-07-08: filterByIdf가 반환한 df를 재사용(중복 쿼리 제거).
  const inCorpus = meaningful.filter(m => m.df > 0);
  if (inCorpus.length < 2) return [];
  const meaningfulKws = meaningful.map(m => m.kw);

  try {
    const ftsQuery = meaningfulKws.map(k => `"${k.replace(/"/g, '""')}"`).join(' OR ');
    const projectFilter = project ? `AND (m.project = ? OR m.project IS NULL)` : '';
    const params: unknown[] = [ftsQuery];
    if (project) params.push(project);

    const rows = db.prepare(`
      SELECT m.content, m.memory_type, bm25(memories_fts) AS score
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ${projectFilter}
      AND m.importance >= 5
      AND (m.tags NOT LIKE '%auto-tracked%' OR m.tags IS NULL)
      ORDER BY score ASC
      LIMIT 5
    `).all(...params) as Array<{ content: string; memory_type: string; score: number }>;

    // bm25 score < -2 강한 매칭만 (낮을수록 관련도 높음)
    return rows.filter(r => r.score < -2).slice(0, 2);
  } catch {
    return [];
  }
}

interface PastWorkResult {
  sessions: Array<{ date: string; work: string }>;
  memories: Array<{ type: string; content: string }>;
  solutions: Array<{ signature: string; solution: string }>;
}

function searchPastWork(db: Database.Database, keyword: string): PastWorkResult {
  const result: PastWorkResult = { sessions: [], memories: [], solutions: [] };

  // C3 (2026-07-08): 다단어 구("GCP 코인 정보")를 통째 LIKE/MATCH하면
  //   조사·어순 때문에 거의 안 맞았음. 구를 토큰화해 OR 검색으로 커버.
  //   단, 흔한 토큰(이름/정보 등)은 IDF로 걸러야 오탐 방지 — "강아지 이름"의
  //   '이름'이 무관한 앱-이름 메모리와 매칭되던 문제.
  // 토큰화 결과가 비면 = 의미 토큰이 없는 질문(예: "내 정보 가지고 있나"의 '정보').
  // 원본 keyword로 폴백하면 흔한 단어로 아무 메모리나 잡으므로 검색 안 함.
  const rawTokens = extractTriggerKeywords(keyword);
  if (rawTokens.length === 0) return result;
  // IDF로 흔한 토큰 추가 제거. 남는 게 없으면(전부 흔함) 검색 안 함.
  // audit-7 2026-07-08: filterByIdf가 {kw,df} 반환하도록 바뀜 → kw만 추출.
  const searchTokens = filterByIdf(db, rawTokens).map(m => m.kw);
  if (searchTokens.length === 0) return result;

  // 1. sessions 검색 (최근 30일, 상위 3건) — 토큰 LIKE OR
  try {
    const likeClause = searchTokens.map(() => 'last_work LIKE ?').join(' OR ');
    const likeParams = searchTokens.map(t => `%${t}%`);
    const sessions = db.prepare(`
      SELECT last_work, timestamp FROM sessions
      WHERE (${likeClause})
        AND last_work != 'Session ended'
        AND last_work != 'Session work completed'
        AND last_work != 'Session started'
        AND last_work != ''
        AND timestamp > datetime('now', '-30 days')
      ORDER BY timestamp DESC LIMIT 3
    `).all(...likeParams) as Array<{ last_work: string; timestamp: string }>;

    for (const s of sessions) {
      const work = s.last_work.length > 80 ? s.last_work.slice(0, 80) + '...' : s.last_work;
      result.sessions.push({ date: s.timestamp?.slice(0, 10) || 'unknown', work });
    }
  } catch { /* ignore */ }

  // 2. memories FTS5 검색 (상위 2건) — 토큰 OR 쿼리
  try {
    const ftsQuery = searchTokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const memories = db.prepare(`
      SELECT m.content, m.memory_type FROM memories m
      JOIN memories_fts fts ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank LIMIT 2
    `).all(ftsQuery) as Array<{ content: string; memory_type: string }>;

    for (const m of memories) {
      const content = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
      result.memories.push({ type: m.memory_type, content });
    }
  } catch {
    // FTS5 매칭 실패 시 LIKE 폴백 (토큰 OR)
    try {
      const likeClause = searchTokens.map(() => 'content LIKE ?').join(' OR ');
      const likeParams = searchTokens.map(t => `%${t}%`);
      const memories = db.prepare(`
        SELECT content, memory_type FROM memories
        WHERE ${likeClause}
        ORDER BY importance DESC, created_at DESC LIMIT 2
      `).all(...likeParams) as Array<{ content: string; memory_type: string }>;

      for (const m of memories) {
        const content = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
        result.memories.push({ type: m.memory_type, content });
      }
    } catch { /* ignore */ }
  }

  // 3. solutions 검색 (상위 2건)
  try {
    const clause = searchTokens.map(() => '(error_signature LIKE ? OR solution LIKE ?)').join(' OR ');
    const params: string[] = [];
    for (const t of searchTokens) { params.push(`%${t}%`, `%${t}%`); }
    const solutions = db.prepare(`
      SELECT error_signature, solution FROM solutions
      WHERE ${clause}
      ORDER BY created_at DESC LIMIT 2
    `).all(...params) as Array<{ error_signature: string; solution: string }>;

    for (const s of solutions) {
      const sol = s.solution.length > 80 ? s.solution.slice(0, 80) + '...' : s.solution;
      result.solutions.push({ signature: s.error_signature, solution: sol });
    }
  } catch { /* ignore */ }

  return result;
}

function formatPastWork(pastWork: PastWorkResult): string | null {
  const { sessions, memories, solutions } = pastWork;
  if (sessions.length === 0 && memories.length === 0 && solutions.length === 0) return null;

  const lines: string[] = ['## Related Past Work (auto-detected from your question)\n'];

  if (sessions.length > 0) {
    lines.push('### Sessions');
    for (const s of sessions) {
      lines.push(`- [${s.date}] ${s.work}`);
    }
    lines.push('');
  }

  if (memories.length > 0) {
    const typeIcons: Record<string, string> = {
      observation: '👀', decision: '🎯', learning: '📚', error: '⚠️', pattern: '🔄'
    };
    lines.push('### Memories');
    for (const m of memories) {
      const icon = typeIcons[m.type] || '💭';
      lines.push(`- ${icon} [${m.type}] ${m.content}`);
    }
    lines.push('');
  }

  if (solutions.length > 0) {
    lines.push('### Solutions');
    for (const s of solutions) {
      lines.push(`- **${s.signature}**: ${s.solution}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ===== 사용자 지시사항 자동 추출 =====

const DIRECTIVE_PATTERNS: Array<{ pattern: RegExp; priority: 'high' | 'normal' }> = [
  { pattern: /(?:절대|never)\s+(.+)/i, priority: 'high' },
  { pattern: /(?:항상|always)\s+(.+)/i, priority: 'high' },
  { pattern: /(?:반드시|must)\s+(.+)/i, priority: 'high' },
  { pattern: /never\s+(?:use|modify|touch)\s+(.+)/i, priority: 'high' },
  { pattern: /always\s+(?:use|check|include)\s+(.+)/i, priority: 'high' },
  { pattern: /#(?:기억|remember)\s+(.+)/i, priority: 'normal' },
  { pattern: /(?:important|중요)[:\s]+(.+)/i, priority: 'normal' },
  { pattern: /(?:rule|규칙)[:\s]+(.+)/i, priority: 'normal' },
];

const MAX_DIRECTIVES = 20;

/**
 * directive 품질 게이트 (P4, 2026-07-08).
 * DIRECTIVE_PATTERNS의 `.+` 탐욕 캡처가, 사용자가 붙여넣은 어시스턴트 산출물
 * (JSON 평가지/스토리보드/코드)에서 '절대/반드시/must' 부분문자열 뒤를 통째로
 * 잡아 지시문으로 오추출했음(실측 45건 중 42건 오염, 30건이 200자 cap run-on).
 * 진짜 지시문은 짧고 자족적 — 데이터/코드 구문 냄새가 나면 거부.
 * 다국어(영어+한국어) 모두 커버.
 */
function isValidDirective(d: string): boolean {
  if (d.length > 120) return false;                                   // run-on 캡처
  if (/"\s*:\s*|"\s*\}|\{\s*"|"\},\{"|\}\]|\}\}/.test(d)) return false; // JSON 구조 구문
  if (/"(?:whatWorks|itemCode|weight|factor|impact|verdict|correction|role|path|purpose|problem|action|files)"/.test(d)) return false; // 평가지/JSON 키
  if (d.includes('`') || d.includes('**') || /\|.*\|.*\|/.test(d)) return false; // 코드/마크다운 표
  if ((d.match(/"/g) || []).length >= 4) return false;                // 따옴표 과다=구조화 데이터
  // 어시스턴트 산문 중간이 잘린 파편은 소문자 라틴 문자로 시작함
  // (진짜 영어 지시문은 대문자 명령형: "Never …", "Always …", "Do NOT …").
  // 한국어 지시문은 이 검사에 안 걸림(라틴 소문자로 시작 안 함).
  if (/^[a-z]/.test(d)) return false;
  return true;
}

function extractAndSaveDirectives(dbPath: string, project: string, prompt: string): void {
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // 다중 hook 프로세스 동시성 보장

    for (const { pattern, priority } of DIRECTIVE_PATTERNS) {
      const match = prompt.match(pattern);
      if (match && match[1]) {
        const directive = match[1].trim().slice(0, 200);
        if (directive.length < 5) continue;
        if (!isValidDirective(directive)) continue;

        // UPSERT directive
        db.prepare(`
          INSERT INTO user_directives (project, directive, context, source, priority)
          VALUES (?, ?, ?, 'explicit', ?)
          ON CONFLICT(project, directive) DO UPDATE SET
            priority = ?,
            created_at = CURRENT_TIMESTAMP
        `).run(project, directive, prompt.slice(0, 300), priority, priority);
      }
    }

    // P1-1 (2026-08-10): 90일 지난 지시문 정리.
    //   지시문은 memories와 달리 decay도 TTL도 없어 한 번 들어오면 영구 잔존했다.
    //   오탐으로 들어온 high 지시문이 매 SessionStart마다 🔴 CRITICAL로 재주입되는 걸 막는다.
    db.prepare(`
      DELETE FROM user_directives
      WHERE project = ? AND created_at < datetime('now', '-90 days')
    `).run(project);

    // MAX_DIRECTIVES 초과 시 가장 오래된 것 삭제
    // P1-1: priority='normal' 조건 제거 — high가 상한을 넘겨도 삭제 대상에서 원천
    //   제외돼 정상 지시문만 밀려나던 문제. 우선순위는 normal을 먼저 버리는 것으로 유지.
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM user_directives WHERE project = ?').get(project) as { cnt: number })?.cnt || 0;
    if (count > MAX_DIRECTIVES) {
      db.prepare(`
        DELETE FROM user_directives WHERE id IN (
          SELECT id FROM user_directives
          WHERE project = ?
          ORDER BY CASE priority WHEN 'high' THEN 1 ELSE 0 END ASC, created_at ASC
          LIMIT ?
        )
      `).run(project, count - MAX_DIRECTIVES);
    }

    db.close();
  } catch {
    // 테이블 미존재 등 무시
  }
}

async function main() {
  // 환경 변수로 비활성화 가능
  if (process.env.MCP_HOOKS_DISABLED === 'true') {
    process.exit(0);
  }

  try {
    // stdin에서 입력 읽기
    let inputData = '';
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    const input: PromptInput = inputData ? JSON.parse(inputData) : {};
    const cwd = input.cwd || process.cwd();
    const workspaceRoot = detectWorkspaceRoot(cwd);
    const project = getProject(cwd, workspaceRoot);

    if (!project) {
      process.exit(0);
    }

    const dbPath = path.join(workspaceRoot, '.claude', 'sessions.db');

    // 사용자 프롬프트에서 지시사항 추출 (DB 저장, 출력 0 토큰)
    if (input.prompt) {
      extractAndSaveDirectives(dbPath, project, input.prompt);
    }

    // 1. 명시적 과거 참조 ("저번에", "예전에" 등) — 기존 동작 유지
    if (input.prompt && fs.existsSync(dbPath)) {
      const keyword = extractPastKeywords(input.prompt);
      if (keyword) {
        try {
          const db = new Database(dbPath, { readonly: true });
          const pastWork = searchPastWork(db, keyword);
          const pastSection = formatPastWork(pastWork);
          db.close();
          if (pastSection) {
            emitContext(`\n<past-context project="${project}">\n${pastSection}\n</past-context>\n`, 'UserPromptSubmit', input.transcript_path);
          }
        } catch { /* ignore */ }
      } else {
        // 2. Proactive trigger: 명시적 참조 없어도 키워드 매칭으로 관련 메모리 inject
        // (P0+ 2026-05-22: 사용자 "트리거 매칭" 발상 구현)
        // 임계값: 추출 키워드 ≥2개 + bm25 score < -2 (강한 매칭만)
        try {
          const triggerKws = extractTriggerKeywords(input.prompt);
          if (triggerKws.length >= 2) {
            const db = new Database(dbPath, { readonly: true });
            const triggered = searchTriggeredMemories(db, triggerKws, project);
            db.close();
            if (triggered.length > 0) {
              const lines = ['## Triggered Memory (auto-matched from your prompt)'];
              for (const m of triggered) {
                const content = m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content;
                lines.push(`- [${m.memory_type}] ${content}`);
              }
              emitContext(`\n<triggered-context project="${project ?? 'global'}" keywords="${triggerKws.join(',')}">\n${lines.join('\n')}\n</triggered-context>\n`, 'UserPromptSubmit', input.transcript_path);
            }
          }
        } catch { /* ignore */ }
      }
    }

    process.exit(0);
  } catch (e) {
    logHookError('user-prompt-submit', e);
    process.exit(0);
  }
}

main();
