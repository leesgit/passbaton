/**
 * 「이 복구 행은 **이번** 컴팩션의 것인가」 를 트랜스크립트로 판정한다 (2.6.1 · Astra reply-142 PB142-01).
 *
 * ★ 왜 시각이 아닌가
 *   PreCompact 의 쓰기·지우기가 잠금으로 둘 다 실패하면 지난 컴팩션의 행 A 가 남는다. 30 분 TTL 은
 *   「A 가 30 분 안에 쓰였다」 만 보일 뿐 「이번 컴팩션의 것이다」 를 보이지 못한다.
 *
 * ★ 무엇으로 판정하나 — PreCompact 가 본 **마지막 uuid**(U)
 *   PreCompact 는 행에 U 를 같이 적는다. 컴팩션 직후 SessionStart(compact) 가 트랜스크립트를 열었을 때
 *     - U 가 없다                         → 판정 불가 → 내지 않는다
 *     - U 뒤에 사람·assistant 메시지가 있다 → 대화가 이어진 뒤의 컴팩션이다 → A 는 지난 것 → 내지 않는다
 *     - U 뒤에는 컴팩션 산물뿐이다          → 이번 것 → 낸다
 *   실측(2026-10-22, 이 PC 트랜스크립트 500 개): 컴팩션 16 건 모두 U 뒤 · SessionStart 앞에 오는 uuid 줄은
 *   compact_boundary · 컴팩션 요약(isCompactSummary) · attachment 뿐이었다. compact_boundary.logicalParentUuid 는
 *   16/16 U 와 같았다. 다만 SessionStart 의 기록 시각이 경계 줄보다 앞선 세션이 있어 경계 줄 자체에는 기대지 않는다.
 *   PreCompact 는 돌았는데 컴팩션이 일어나지 않은 경우(1 건)는 U 뒤에 대화가 이어져 「지난 것」 으로 맞게 걸러진다.
 *
 * uuid 를 쓰지 않는 호스트(Codex·Gemini 트랜스크립트)는 U 가 없으므로 복구 블록이 나오지 않는다 — 근거 없이 내지 않는다.
 */

import * as fs from 'fs';

/** 컴팩션 직후라 U 는 끝 근처에 있다. 요약·첨부가 커도 이 안에 든다. 못 찾으면 내지 않는다(닫힌 쪽 실패). */
const TAIL_BYTES = 8 * 1024 * 1024;

export interface TranscriptLine {
  uuid?: string;
  type?: string;
  subtype?: string;
  role?: string;
  content?: unknown;
  /** JSON 으로 읽지 못한 줄 — 「대화 없음」 의 증거가 아니다 */
  __broken?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  message?: { role?: string; content?: unknown };
}

export function readTailLines(transcriptPath: string | undefined, maxBytes = TAIL_BYTES): TranscriptLine[] {
  if (!transcriptPath) return [];
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift();   // 잘린 첫 줄
    const out: TranscriptLine[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      // 깨진 줄은 버리지 않고 표지를 남긴다 — U 뒤에 읽지 못한 구간이 있으면 판정하지 않는다(reply-143 PB143-01)
      try { out.push(JSON.parse(l)); } catch { out.push({ __broken: true }); }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* noop */ }
  }
}

export function lastUuid(lines: TranscriptLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const u = lines[i].uuid;
    if (typeof u === 'string' && u) return u;
  }
  return null;
}

/** 대화 메시지인가 — 컴팩션 요약·메타 턴·도구 결과만 든 user 줄은 대화가 아니다. */
function isConversation(e: TranscriptLine): boolean {
  if (e.type === 'assistant') return true;
  if (e.type !== 'user') return false;
  if (e.isCompactSummary || e.isVisibleInTranscriptOnly || e.isMeta) return false;
  const c = e.message?.content;
  if (Array.isArray(c) && c.length > 0 && c.every((b: { type?: string }) => b?.type === 'tool_result')) return false;
  return true;
}

export type CompactMatch = 'current' | 'stale' | 'unknown';

/** U(PreCompact 가 본 마지막 uuid) 기준으로 이 행이 이번 컴팩션의 것인지. */
export function matchCompaction(lines: TranscriptLine[], preUuid: string | null | undefined): CompactMatch {
  if (!preUuid) return 'unknown';
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].uuid === preUuid) { at = i; break; }
  }
  if (at < 0) return 'unknown';
  const after = lines.slice(at + 1);
  if (after.some(e => e.__broken)) return 'unknown';
  return after.some(isConversation) ? 'stale' : 'current';
}
