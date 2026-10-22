/**
 * 컴팩션 직전 핸드오버 — PreCompact 의 순수 로직 (2.6.1 에 훅에서 떼어 냈다: 같은 스냅샷 보장과 단위 시험).
 */

import * as fs from 'fs';
import * as path from 'path';
import { humanTurn, requestLine } from './human-turn.js';
import { lastUuid, type TranscriptLine } from './compact-id.js';

export interface HandoverContext {
  /** 마지막 사람 요청(요청이지 결과가 아니다) */
  request: string | null;
  /** 그 요청 뒤에 Claude 의 글이 아직 없다 */
  pending: boolean;
  activeFile: string | null;
  keyFacts: string[];
  recentErrors: string[];
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

/**
 * 트랜스크립트 줄들(한 스냅샷)을 buildHandoverContext 가 받는 형태로 바꾼다.
 *
 * 2.6.1: user 줄은 **사람 요청만** 남긴다(humanText). 하네스 알림·메타 턴·컴팩션 요약·
 *   셸 입출력·도구 결과는 버린다 — 2026-10-22 에 `<task-notification>` 이 「하던 일」 이 됐다.
 *   assistant 줄은 글과 함께 **도구가 실제로 건드린 경로**(tool_use input.file_path)를 싣는다.
 */
export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 사람 요청인지 기계 줄인지 가를 수 없는 user 줄(닫히지 않은 봉투) */
  uncertain?: boolean;
  /** assistant 의 tool_use 가 다룬 파일 — 쓰기 도구가 앞, 읽기가 뒤 */
  toolPaths: { path: string; write: boolean }[];
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);

export function entriesToMessages(entries: TranscriptLine[]): TurnMessage[] {
  const out: TurnMessage[] = [];
  for (const entry of entries) {
    if (entry.__broken) continue;
    // Claude Code JSONL은 역할을 최상위 `type`으로 싣고, `message.role`은 없을 수 있다.
    const role = entry.message?.role || entry.role || entry.type;
    if (role === 'user') {
      const turn = humanTurn(entry);
      if (turn.uncertain) out.push({ role, content: '', toolPaths: [], uncertain: true });
      else if (turn.text.trim()) out.push({ role, content: turn.text, toolPaths: [] });
      continue;
    }
    if (role !== 'assistant') continue;
    const raw = entry.message?.content ?? entry.content;
    let content = '';
    const toolPaths: TurnMessage['toolPaths'] = [];
    if (typeof raw === 'string') {
      content = raw;
    } else if (Array.isArray(raw)) {
      content = raw
        .filter((b: { type?: string }) => b?.type === 'text')
        .map((b: { text?: string }) => b.text || '')
        .join('\n');
      for (const b of raw as Array<{ type?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown } }>) {
        if (b?.type !== 'tool_use' || !b.name) continue;
        const p = b.input?.file_path ?? b.input?.notebook_path;
        if (typeof p !== 'string' || !p) continue;
        if (WRITE_TOOLS.has(b.name)) toolPaths.push({ path: p, write: true });
        else if (READ_TOOLS.has(b.name)) toolPaths.push({ path: p, write: false });
      }
    }
    if (content.trim() || toolPaths.length > 0) out.push({ role, content, toolPaths });
  }
  return out;
}

/**
 * 텍스트에서 잡은 파일 후보는 **실제로 있는 파일**일 때만 쓴다.
 * `passbaton@2.6.0` 같은 패키지 이름·URL·디렉터리가 「작업 파일」 이 됐다(2026-10-22).
 */
function resolveTextFile(candidate: string, bases: string[]): string | null {
  if (!candidate || candidate.includes('://') || candidate.includes('@')) return null;
  for (const base of bases) {
    try {
      const abs = path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);
      if (fs.statSync(abs).isFile()) return candidate;
    } catch { /* 없음 */ }
  }
  return null;
}

export function buildHandoverContext(
  transcript: TurnMessage[],
  bases: string[] = [process.cwd()],
): HandoverContext {
  const context: HandoverContext = {
    request: null,
    pending: false,
    activeFile: null,
    keyFacts: [],
    recentErrors: []
  };

  const assistantMessages = transcript.filter(m => m.role === 'assistant' && m.content.trim());

  // 1. request: 마지막 **사람** 요청. ⛔ 결과가 아니다 — 저장·표시 모두 「요청」 으로만 다룬다.
  //    (2.6.0 까지는 창 안 첫 user 줄을 workSummary 로 삼아 current_state 를 덮었다)
  let lastHuman = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'user') { lastHuman = i; break; }
  }
  if (lastHuman >= 0) {
    const cleaned = requestLine(transcript[lastHuman].content)
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('|') && !l.startsWith('---'));
    if (cleaned.length > 0) context.request = stripMarkdown(cleaned[0]).slice(0, 200);
    // pending = 그 요청 **뒤에 assistant 글이 없다.** 그 이상의 뜻은 없다 — 「곧 하겠다」 한 줄도
    //   글이므로 pending 이 아니고, 그렇다고 작업이 끝났다는 증거도 아니다(Astra reply-140).
    //   기계 줄은 이미 빠졌으므로 알림이 마지막 줄이어도 이 판정은 바뀌지 않는다.
    context.pending = !transcript.slice(lastHuman + 1).some(m => m.role === 'assistant' && m.content.trim());
  }

  // 2. activeFile: 도구가 실제로 건드린 경로가 먼저(쓰기 > 읽기, 최근 것). 없을 때만 텍스트 후보.
  //   ⛔ 「지금 없음」 은 「삭제됨」 이 아니다 — 실패한 Write·원래 없던 Read·권한 오류도 stat 이
  //   실패한다. 삭제 증거를 보지 않으므로 삭제라고 쓰지 않는다(Astra reply-140 PB140-03).
  //   상대 경로는 훅 프로세스 cwd 가 아니라 **입력 cwd** 기준이다.
  const observed = transcript.flatMap(m => m.toolPaths);
  const pick = [...observed].reverse().find(p => p.write) ?? [...observed].reverse()[0];
  if (pick) {
    const abs = path.isAbsolute(pick.path) ? pick.path : path.resolve(bases[0], pick.path);
    let mark = '';
    try {
      if (!fs.statSync(abs).isFile()) mark = ' (not a file now)';
    } catch (e) {
      mark = (e as NodeJS.ErrnoException).code === 'ENOENT' ? ' (not found now)' : ' (could not check)';
    }
    context.activeFile = pick.path + mark;
  } else {
    const filePatterns = [
      /(?:file_path|파일)[:\s]*["']?([^\s"',]+\.\w{1,6})/,
      /(?:Edit|Write|Read|수정|생성|읽기)\s+.*?(\S+\.\w{1,6})/,
      /`([^`]+\.\w{1,6})`/,
    ];
    for (const msg of [...transcript.slice(-10)].reverse()) {
      for (const pattern of filePatterns) {
        const match = msg.content.match(pattern);
        const hit = match?.[1] ? resolveTextFile(match[1], bases) : null;
        if (hit) { context.activeFile = hit; break; }
      }
      if (context.activeFile) break;
    }
  }

  // 4. keyFacts: assistant 메시지에서 설정값, 포트, 버전 등 추출
  const factPatterns = [
    /(?:port|포트)\s*(?:is|=|:|→)\s*(\d{2,5})/gi,
    /(?:version|버전)\s*(?:is|=|:|→)\s*([\d.]+)/gi,
    /(?:IP|ip)\s*(?:is|=|:|→)\s*([\d.]+)/gi,
    /(?:using|사용)\s+([\w\s.-]+?\s+v[\d.]+)/gi,
  ];

  for (const msg of assistantMessages.slice(-10)) {
    for (const pattern of factPatterns) {
      pattern.lastIndex = 0;
      const match = msg.content.match(pattern);
      if (match) {
        context.keyFacts.push(stripMarkdown(match[0]).slice(0, 100));
      }
    }
  }
  context.keyFacts = [...new Set(context.keyFacts)].slice(0, 5);

  // 5. recentErrors: 에러 패턴 추출
  for (const msg of transcript.slice(-15)) {
    const errorMatch = msg.content.match(
      /(?:Error|error|ERROR|오류|실패|FAILED|Exception)[:\s](.{10,100})/
    );
    if (errorMatch) {
      const err = stripMarkdown(errorMatch[0]).slice(0, 100);
      if (!context.recentErrors.includes(err)) {
        context.recentErrors.push(err);
      }
    }
  }
  context.recentErrors = context.recentErrors.slice(0, 3);

  return context;
}

/** 핸드오버 창: 마지막 컴팩션 경계(또는 요약) **뒤**, 그중 마지막 MAX_WINDOW 줄. */
const MAX_WINDOW = 200;

export interface HandoverSnapshot {
  messages: TurnMessage[];
  handover: HandoverContext | null;
  /** 이 스냅샷의 마지막 uuid — 복구 행이 「이번 컴팩션」 의 것인지 SessionStart 가 대조한다 */
  preUuid: string | null;
}

/**
 * ★ 요청 내용과 pre_uuid 를 **같은 스냅샷**에서 만든다 (Astra reply-143 PB143-01).
 *   따로 두 번 읽으면 그 사이에 줄이 붙어 A 의 요청에 B 의 uuid 가 붙을 수 있다.
 * ★ 창은 마지막 컴팩션 경계 뒤에서 시작한다 (PB143-03). 트랜스크립트는 이어 쓰이므로
 *   「A 요청 → 경계·요약 → 알림」 에서 경계 앞의 A 를 다시 고르면 지난 창의 요청이 새 uuid 를 달고 나온다.
 */
export function snapshotHandover(entries: TranscriptLine[], bases: string[]): HandoverSnapshot {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.subtype === 'compact_boundary' || e.isCompactSummary) { start = i + 1; break; }
  }
  const window = entries.slice(start).slice(-MAX_WINDOW);
  const all = entriesToMessages(window);
  const messages = all.filter(m => !m.uncertain);
  // ★ 창 안에 읽지 못한 줄이 있으면 핸드오버를 만들지 않는다 — 버린 줄이 더 최근 요청일 수 있다.
  //   U 뒤만 보면 「A → 깨진 줄(B?) → U」 에서 A 가 이번 요청이 된다(Astra reply-144 PB144-01).
  // ★ 마지막 사람 요청 **뒤에** 가를 수 없는 user 줄이 있으면 그 앞의 요청을 「마지막」 으로 올리지 않는다(PB144-03).
  const lastHuman = all.map(m => m.role === 'user' && !m.uncertain).lastIndexOf(true);
  const lastUncertain = all.map(m => !!m.uncertain).lastIndexOf(true);
  const unreadable = window.some(e => e.__broken) || lastUncertain > lastHuman;
  return {
    messages,
    handover: !unreadable && messages.length > 0 ? buildHandoverContext(messages, bases) : null,
    preUuid: lastUuid(entries),
  };
}
