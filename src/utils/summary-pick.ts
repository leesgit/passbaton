/**
 * Stop 요약을 assistant 글에서 고르는 규칙 (2.10 · Astra P5 reply-5 C2 · Ashfall P5-05).
 *
 * 왜 바꿨나 (Ashfall 실제 DB 직접 재현 · 2026-11-06~07):
 *   - 「Astra의 총평」 같은 **제목형 문구**가 State 로 저장됐다(첫 제목 전략) — 상태가 아니다.
 *   - 완료 동사를 **문장 한가운데서** 잡고 첫 마침표에서 잘랐다 — 「fixed before committing**」,
 *     「updated row L-65 in the monorepo `docs/passbaton-ledger.」 처럼 주어가 빠진 조각이 결과처럼 보였다.
 *
 * 순서(앞이 우선 · 「마지막 단락 우선」 은 쓰지 않는다 — 마지막 단락도 질문·제안일 수 있다 · reply-5 기각):
 *   1. 구조화 마커 `<!--SESSION:{"done":"…"}-->`
 *   2. **명시적 상태 줄** — `현재 상태:`·`상태:`·`Status:` 다음, 차단 사유(`BLOCKED`·`차단:`)는 뒤에 붙인다.
 *      라벨은 원문 그대로 남긴다(무엇을 상태라고 썼는지 읽는 쪽이 본다).
 *   3. 첫 서술 문장(원문 순서) — 제목·인용(`>`)·질문·미래 계획·굵은 라벨만 있는 줄·표·코드는 건너뛴다.
 *      문장 전체(첫 마침표가 아니라 문장 끝까지). 문장 머리가 완료 표현이면 kind = completion(표시만 · 우선순위 아님).
 *      문장 **한가운데의** 동사는 보지 않는다.
 *   없으면 null — 호출부가 「결과 요약 없음」(no-result)으로 적는다 = 상태 추출 불가. 제목으로 메우지 않는다.
 *
 * ⛔ 이 규칙은 글이 **무엇을 주장하는지**를 고를 뿐이다. 주장이 참인지는 모른다(via assistant text).
 * ⛔ RALPH_STATUS 같은 기계 프로토콜 블록은 상태 줄로 쓰지 않는다(`STATUS: IN_PROGRESS` 는 사람이 읽을 결과가 아니다).
 */

export type PickKind = 'marker' | 'status' | 'completion' | 'sentence';

export interface SummaryPick {
  text: string;
  kind: PickKind;
  /** 원문 안 1-based 줄 번호(마커는 그 줄) */
  line: number;
}

const MAX = 200;

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .trim();
}

/** 줄마다 「건너뛸 줄」 표시 — 코드 펜스 안·기계 상태 블록 안 */
function skipMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: string | null = null;
  let machine = false;
  for (const l of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) { mask.push(true); if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; mask.push(true); continue; }
    if (/^\s*-{3}\s*RALPH_STATUS\s*-{3}\s*$/.test(l)) { machine = true; mask.push(true); continue; }
    if (machine) { mask.push(true); if (/^\s*-{3}\s*END_RALPH_STATUS\s*-{3}\s*$/.test(l)) machine = false; continue; }
    mask.push(false);
  }
  return mask;
}

const STATUS_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(현재 상태|상태|Current status|Status)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+)$/i;
const BLOCKED_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(BLOCKED|Blocked|차단 사유|차단)(?:\*\*)?\s*(?:[:：—-])\s*(.+)$/;

/** 줄 머리의 목록 기호·번호 · 완료 표시 ✅(2.7.3 까지의 요약도 벗겼다 — 글 그대로 비교되게) */
const bullet = (l: string) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^✅\s*/, '');

/** 질문 · 미래 계획 · 제안 — 현재 상태가 아니다 */
const QUESTION = /[?？]\s*$|(?:할까요|될까요|인가요|있나요|일까요)[.!]?\s*$/;
const FUTURE = /^(?:I'll|I will|I'm going to|I am going to|I plan to|Let me|Next,|Next I|Then I|We will|We'll|다음은|다음으로|이제 |앞으로)|(?:하겠습니다|할게요|할 예정입니다|할 예정|하려고 합니다|해 보겠습니다|진행하겠습니다)[.!]?\s*$/i;
/** 문장 머리의 완료 표현(문장 한가운데의 동사는 잡지 않는다) */
const COMPLETION_HEAD = /^(?:I've |I have |I |We've |We )?(?:successfully |also |just )?(?:completed|finished|implemented|fixed|created|added|updated|refactored|deployed|committed|merged)\b/i;
const COMPLETION_KO = /(?:배포 완료|구현 완료|작업 완료|수정 완료|테스트 통과|빌드 성공)/;

/** 마침표 뒤 공백에서 문장을 나눈다 — `ledger.md` 처럼 공백 없는 점은 문장 끝이 아니다 */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?。])\s+/).map(s => s.trim()).filter(Boolean);
}

function clip(s: string): string {
  return s.length <= MAX ? s : s.slice(0, MAX - 1) + '…';
}

export function pickSummary(content: string): SummaryPick | null {
  if (!content || content.length < 10) return null;

  const marker = /<!--SESSION:(.*?)-->/s.exec(content);
  if (marker?.[1]) {
    try {
      const parsed = JSON.parse(marker[1]) as { done?: unknown };
      if (typeof parsed.done === 'string' && parsed.done.length > 5) {
        return { text: clip(stripMarkdown(parsed.done)), kind: 'marker', line: content.slice(0, marker.index).split('\n').length };
      }
    } catch { /* 깨진 마커 — 아래로 */ }
  }

  const lines = content.split('\n');
  const skip = skipMask(lines);
  const usable = (i: number) => !skip[i] && !/^\s*\|/.test(lines[i]) && !/^\s*>/.test(lines[i]);

  // 2. 명시적 상태 줄(+ 차단 사유)
  let status: SummaryPick | null = null;
  let blocked: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!usable(i) || /^\s*#/.test(lines[i])) continue;
    const s = STATUS_LINE.exec(lines[i]);
    if (s && !status) {
      const value = stripMarkdown(s[2]);
      if (value.length >= 2 && !QUESTION.test(value)) status = { text: `${s[1]}: ${value}`, kind: 'status', line: i + 1 };
      continue;
    }
    const b = BLOCKED_LINE.exec(lines[i]);
    if (b && !blocked) blocked = `${b[1]}: ${stripMarkdown(b[2])}`;
  }
  if (status) return { ...status, text: clip(blocked && !status.text.includes(blocked) ? `${status.text} · ${blocked}` : status.text) };

  // 3. 첫 서술 문장 — 줄 단위로 훑되 문장 단위로 판정한다. 완료 문장이라고 뒤의 것을 앞으로 당기지 않는다
  //    (「I also updated …」 같은 덧붙임이 첫 보고문을 밀어냈다 — 명시적 상태가 아닌 것끼리는 원문 순서).
  for (let i = 0; i < lines.length; i++) {
    if (!usable(i)) continue;
    const raw = lines[i].trim();
    if (!raw || /^#/.test(raw) || /^-{3,}$/.test(raw)) continue;
    // 굵은 라벨만 있는 줄(「**What changed**」·「**검증**:」) — 단락 제목이다
    if (/^(?:\*\*[^*]+\*\*|__[^_]+__)\s*[:：]?\s*$/.test(raw)) continue;
    const ss = sentences(stripMarkdown(bullet(raw)));
    for (let k = 0; k < ss.length; k++) {
      let sent = ss[k];
      if (QUESTION.test(sent) || FUTURE.test(sent)) continue;
      // 짧은 첫 문장(「P5-04 is done.」)은 버리지 않고 같은 줄의 다음 서술 문장을 붙인다
      const next = ss[k + 1];
      if (sent.length < 40 && next && !QUESTION.test(next) && !FUTURE.test(next)) sent = `${sent} ${next}`;
      if (sent.length < 15) continue;
      return { text: clip(sent), kind: COMPLETION_HEAD.test(sent) || COMPLETION_KO.test(sent) ? 'completion' : 'sentence', line: i + 1 };
    }
  }
  return null;
}

/** 표시용 — 「status line L3 of the last reply」 */
export interface SummaryBasis {
  role: 'assistant';
  /** last = 마지막 응답 · recent-N = 마지막에서 N 번째 앞 · legacy = 옛 transcript 배열 */
  msg: string;
  kind: PickKind;
  line: number;
  turn: string | null;
}

const KIND_LABEL: Record<PickKind, string> = {
  marker: 'SESSION marker', status: 'status line', completion: 'completion sentence', sentence: 'first statement',
};

/** DB 칸(JSON)을 표시 한 조각으로. 모르면 null(표시 안 함 — 지어내지 않는다). */
export function basisLabel(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let b: Partial<SummaryBasis>;
  try { b = JSON.parse(raw) as Partial<SummaryBasis>; } catch { return null; }
  if (!b || typeof b.kind !== 'string' || !(b.kind in KIND_LABEL) || !Number.isInteger(b.line)) return null;
  const where = b.msg === 'last' || b.msg === 'recent-0' ? 'the last reply'
    : typeof b.msg === 'string' && /^recent-\d+$/.test(b.msg) ? `reply ${b.msg.slice(7)} before the last` : 'an earlier reply';
  return `${KIND_LABEL[b.kind as PickKind]} L${b.line} of ${where}`;
}
