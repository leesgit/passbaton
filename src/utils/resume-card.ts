/**
 * 재개 카드 — 레포에 있는 **정본**을 그대로 발췌해 세션 시작에 보여 준다.
 *
 * 왜 필요한가 (2026-10-22 Ashfall 실측 · Astra reply-133):
 *   이 레포의 연속성은 passbaton DB 가 아니라 `docs/HANDOFF.md`(맨 위가 최신) ·
 *   `.ralph/fix_plan.md`(「지금 할 일」 블록) 같은 **사람·에이전트가 같이 고치는 문서**로
 *   굴러간다. DB 요약은 그 문서를 모르고, 그래서 세션 8 건이 모두 workDone=null 이었다.
 *   ⇒ passbaton 은 정본을 대신하지 않는다. **정본의 어느 부분을 먼저 읽을지**를 가리키고,
 *      그 발췌가 언제의 내용인지(줄 범위 + 내용 해시) 함께 적는다.
 *
 * ★ 발췌는 매번 파일에서 다시 읽는다. 캐시하지 않는다 — 문서가 앞에 덧붙여지는 구조라
 *   줄 번호가 매 루프 밀린다. 해시는 「지난번 본 것과 같은가」 를 사람이 비교하라고 준다.
 * ★ 못 읽은 원천은 숨기지 않고 「NOT READ」 로 낸다. 빠진 카드가 「변경 없음」 처럼 보이면 안 된다.
 *
 * ⛔ 경계 (2.6.0 검토 — 보안 리뷰가 정션으로 프로젝트 밖 비밀 파일을 카드에 띄웠다):
 *   - 실제 경로(realpath)가 프로젝트 안이어야 한다 — 문자열 비교만으로는 심볼릭 링크·정션을 못 막는다
 *   - 일반 파일만 · 텍스트 확장자(.md .txt .markdown .rst · 확장자 없음)만
 *   - 비밀이 흔히 사는 이름은 선언해도 읽지 않는다(.env* · .git · .ssh · .aws · .npmrc · *.pem · id_* …)
 *   - 앞에서 최대 MAX_READ_BYTES 만 읽는다(1.7 MB HANDOFF 도 통째로 안 읽는다)
 *
 * 선언 — `<project>/.claude/passbaton.config.json`:
 * ```json
 * {
 *   "continuity": {
 *     "sources": [
 *       { "path": "docs/HANDOFF.md", "lines": 40, "label": "HANDOFF (최신 절)" },
 *       { "path": ".ralph/fix_plan.md", "block": "지금 할 일", "label": "지금 할 일" }
 *     ]
 *   }
 * }
 * ```
 *   - `lines`: 파일 맨 위 N 줄 (기본 40 · 최대 200)
 *   - `block`: 이 문자열을 담은 제목(`#`) 또는 목록 항목(`- `) 줄부터, 같은 깊이 이상의 다음
 *     제목·항목 직전까지 (최대 120 줄). 제목을 목록보다 먼저 찾는다 · 코드 펜스 안과 링크 텍스트는
 *     보지 않는다 · 여러 개면 첫 것을 쓰고 개수를 적는다 · 못 찾으면 NOT READ
 *   - 경로는 프로젝트 폴더 기준
 *   - `role` (2.7.3 · 선택): `"current-task"` = 이 원천이 「현재 작업」 이다. 첫 current-task 원천이
 *     `no_block`·`missing`·읽기 실패·빈 범위면 카드 **첫 줄**에 경고한다(reply-153 PR-5 · reply-154 PB154-D).
 *     명시적 「없음 — 사람 결과 대기」 블록은 읽힌 블록(ok)이라 경고가 아니다. 예산 때문에 못 보인 것은
 *     경고(⚠)가 아니라 안내(ℹ)로 따로 적는다 — 실패·대기·예산을 같은 뜻으로 만들지 않는다.
 *     지정이 없으면 경고도 없다(기존 동작).
 *     `"history"` = 최신 기록(HANDOFF 류) — 아래 loop 최소 카드에서 본문을 뺄 원천.
 *   - `continuity.loopCard: "minimal"` (2.7.3 · 기본 꺼짐 · reply-154 PB154-C): 실행 출처가 **loop 이고** 이 opt-in 이
 *     있을 때만, role 이 current-task·history 인 원천의 **본문만** 뺀다(경로·범위·해시·상태 줄은 남긴다).
 *     role 이 없는 원천(정지 사유·처분 색인)은 그대로 싣는다 — 명시하지 않은 것은 숨기지 않는다.
 *     원천 검사는 생략하지 않는다: 본문을 뺄 원천도 매번 읽어 상태·해시를 낸다(no_block 경고 유지).
 *   - `optional: true` (2.7.3 · 선택 · reply-165 PB165-100): **파일이 없을 때만** ⚠ NOT READ 대신 중립 줄
 *     「file absent (optional source)」 로 낸다(`.ralph/DEMO_STOP`·요청 대기 파일처럼 없는 것이 정상인 원천).
 *     ⛔ 경로 경계 거부·비밀 이름·일반 파일 아님·읽기 실패·블록 없음·빈 범위·잘림은 optional 이어도 그대로 보인다.
 *     없는 선택 원천은 「읽음」(anyRead)으로 세지 않는다. 불리언이 아닌 값은 원천을 살리고 optional 만 버린다.
 */

import type { RunOrigin } from './run-origin.js';

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export type SourceRole = 'current-task' | 'history';
const ROLES: ReadonlySet<string> = new Set<SourceRole>(['current-task', 'history']);
const isRole = (v: unknown): v is SourceRole => typeof v === 'string' && ROLES.has(v);

export interface ContinuitySource {
  path: string;
  lines?: number;
  block?: string;
  label?: string;
  role?: SourceRole;
  /** 없는 것이 정상인 원천(2.7.3 PB165-100) — 명시적 true 일 때만 「파일 없음」 을 중립으로 낸다 */
  optional?: boolean;
}

export interface ContinuityDeclaration {
  sources: ContinuitySource[];
  /** loop 실행에서만 쓰는 최소 카드 opt-in(2.7.3 PB154-C). 없으면 언제나 전체 카드. */
  loopCard?: 'minimal';
  /** 모양이 틀려 버린 항목. 조용히 무시하면 사용자는 선언이 먹은 줄 안다. */
  invalid: string[];
}

export type CardOutcome = 'ok' | 'missing' | 'no_block' | 'unreadable' | 'denied' | 'empty';

export interface CardItem {
  label: string;
  path: string;
  outcome: CardOutcome;
  /** 선택한 범위(1-based, 포함) — 해시는 이 범위의 것이다 */
  from?: number;
  to?: number;
  /** 실제로 보여 준 마지막 줄(잘렸으면 to 보다 작거나, 그 줄의 앞부분만) */
  shownTo?: number;
  totalLines?: number;
  /** 파일이 MAX_READ_BYTES 보다 커서 앞부분만 읽었다 — totalLines 는 하한이다 */
  partialFile?: boolean;
  sha?: string;
  excerpt?: string;
  truncated?: boolean;
  /** 마지막 줄을 **프로그램이** 잘라 「…」 를 붙였다 — 원문의 「…」 와 구별한다(2.7.2 재분배의 원문 보존 비교) */
  sliced?: boolean;
  /** 이 원천의 본문 몫이 바닥나 더 보여 줄 수 있는데 멈췄다(블록 상한·읽기 상한 때문이 아니다) */
  budgetLimited?: boolean;
  /** block 일치 개수(2 이상이면 모호함) */
  matches?: number;
  /** 읽었지만 카드 예산 때문에 본문을 못 보였다(실패가 아니다 · 2.7.3 PB154-D) */
  budgetHidden?: boolean;
  /** 선언에서 optional: true 였다(2.7.3 PB165-100) — outcome 이 missing 일 때만 표시가 달라진다 */
  optional?: boolean;
  why?: string;
}

const DEFAULT_LINES = 40;
const MAX_LINES = 200;
const MAX_BLOCK_LINES = 120;
const MAX_SOURCES = 8;
export const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
/** 원천 하나의 머리글·펜스 몫(대략). 예산을 원천 수로 나눌 때 뺀다. */
const HEADER_RESERVE = 140;
const MIN_CARD_CHARS = 400;
const MAX_CARD_CHARS = 20000;

const TEXT_EXT = new Set(['', '.md', '.markdown', '.txt', '.rst']);
// 경로 조각 하나라도 걸리면 읽지 않는다.
const DENY_SEGMENT = /^(?:\.env.*|\.git|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|\.pgpass|id_[a-z0-9]+(?:\.pub)?|credentials.*|secrets?(?:\..*)?|.*\.(?:pem|key|pfx|p12|crt|cer|jks|keystore))$/i;

/** 카드 전체 글자 예산을 받아들일 수 있는 정수로. NaN·음수·문자열이면 기본값. */
export function clampCardChars(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_CARD_CHARS, Math.max(MIN_CARD_CHARS, Math.floor(n)));
}

export function readContinuityDeclaration(projectPath: string): ContinuityDeclaration {
  const out: ContinuityDeclaration = { sources: [], invalid: [] };
  const file = path.join(projectPath, '.claude', 'passbaton.config.json');

  let text: string;
  try {
    if (!fs.statSync(file).isFile()) return out;
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) {
      out.invalid.push(`.claude/passbaton.config.json is larger than ${MAX_CONFIG_BYTES >> 10} KB — ignored`);
      return out;
    }
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return out;                                    // 파일 없음 = 선언 없음
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // 깨진 설정을 「선언 없음」 으로 숨기지 않는다. 파서 메시지는 원문 조각을 담을 수 있어 쓰지 않는다.
    out.invalid.push('.claude/passbaton.config.json is not valid JSON');
    return out;
  }

  const cont = (raw as { continuity?: { sources?: unknown; loopCard?: unknown } })?.continuity;
  const sources = cont?.sources;
  if (cont?.loopCard !== undefined) {
    if (cont.loopCard === 'minimal') out.loopCard = 'minimal';
    else if (cont.loopCard !== 'full') out.invalid.push(`continuity.loopCard ${JSON.stringify(cont.loopCard).slice(0, 30)} ignored (use "minimal")`);
  }
  if (sources === undefined) return out;
  if (!Array.isArray(sources)) {
    out.invalid.push('continuity.sources (not an array)');
    return out;
  }

  for (const s of sources) {
    const src = s as Record<string, unknown>;
    if (typeof src !== 'object' || src === null || typeof src.path !== 'string' || !src.path.trim()) {
      out.invalid.push(JSON.stringify(s).slice(0, 60));
      continue;
    }
    if (src.lines !== undefined && (typeof src.lines !== 'number' || !Number.isInteger(src.lines) || src.lines < 1)) {
      out.invalid.push(`${src.path}: lines`);
      continue;
    }
    if (src.block !== undefined && (typeof src.block !== 'string' || !src.block.trim())) {
      out.invalid.push(`${src.path}: block`);
      continue;
    }
    if (out.sources.length >= MAX_SOURCES) {
      out.invalid.push(`${src.path}: more than ${MAX_SOURCES} sources`);
      continue;
    }
    // 모르는 role 은 원천을 버리지 않고 role 만 버린다 — 오타 하나로 정지 사유 같은 원천이 사라지면 안 된다
    if (src.role !== undefined && !isRole(src.role)) out.invalid.push(`${src.path}: role ${JSON.stringify(src.role).slice(0, 30)} ignored`);
    // optional 도 같다 — "true" 같은 문자열은 불리언이 아니다. 버리면 기본(없음 = ⚠)으로 돌아가 부재를 숨기지 않는다
    if (src.optional !== undefined && typeof src.optional !== 'boolean') out.invalid.push(`${src.path}: optional ${JSON.stringify(src.optional).slice(0, 30)} ignored`);
    out.sources.push({
      path: src.path,
      lines: src.lines as number | undefined,
      block: src.block as string | undefined,
      label: typeof src.label === 'string' && src.label.trim() ? src.label.slice(0, 80) : src.path,
      ...(isRole(src.role) ? { role: src.role } : {}),
      ...(src.optional === true ? { optional: true } : {}),
    });
  }
  return out;
}

/** 읽어도 되는 파일인가. 이유를 돌려주면 거부. ⚠ 내용은 절대 보지 않는다. */
function denyReason(projectPath: string, rel: string): { abs?: string; why?: string; missing?: boolean } {
  let base: string;
  try { base = fs.realpathSync(projectPath); } catch { return { why: 'project folder unreadable' }; }
  const lexical = path.resolve(projectPath, rel);
  const lexBase = path.resolve(projectPath);
  const inside = (p: string, b: string) => {
    const r = path.relative(b, p);
    return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  };
  if (!inside(lexical, lexBase)) return { why: 'outside the project' };
  const segs = path.relative(lexBase, lexical).split(/[\\/]/);
  if (segs.some(s => DENY_SEGMENT.test(s))) return { why: 'name looks like a secret — not read' };
  if (!TEXT_EXT.has(path.extname(lexical).toLowerCase())) return { why: 'not a text source (.md .txt .markdown .rst or no extension)' };
  if (!fs.existsSync(lexical)) return { missing: true };
  let real: string;
  try { real = fs.realpathSync(lexical); } catch { return { why: 'unresolvable path' }; }
  if (!inside(real, base)) return { why: 'link points outside the project' };
  const realSegs = path.relative(base, real).split(/[\\/]/);
  if (realSegs.some(s => DENY_SEGMENT.test(s))) return { why: 'link target looks like a secret — not read' };
  if (!TEXT_EXT.has(path.extname(real).toLowerCase())) return { why: 'link target is not a text source' };
  try {
    if (!fs.statSync(real).isFile()) return { why: 'not a regular file' };
  } catch { return { why: 'unreadable' }; }
  return { abs: real };
}

/** 앞에서 최대 maxBytes 만 읽는다. 잘렸으면 마지막의 덜 읽힌 줄은 버린다. */
function readHead(abs: string, maxBytes: number): { text: string; partial: boolean } {
  const fd = fs.openSync(abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, maxBytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    let text = buf.toString('utf-8');
    const partial = size > maxBytes;
    if (partial) {
      const nl = text.lastIndexOf('\n');
      text = nl >= 0 ? text.slice(0, nl) : '';
    }
    return { text, partial };
  } finally {
    fs.closeSync(fd);
  }
}

function splitLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();   // 끝 개행은 줄이 아니다
  return lines;
}

/** 코드 펜스 안인지 표시. */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let open: string | null = null;
  for (const l of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (open) {
      mask.push(true);
      if (m && m[1][0] === open[0] && m[1].length >= open.length) open = null;
    } else if (m) {
      open = m[1];
      mask.push(true);
    } else {
      mask.push(false);
    }
  }
  return mask;
}

/** 제목은 # 개수(1~6), 목록은 100 + 들여쓰기(제목보다 깊다). 아니면 null. */
function depthOf(line: string): number | null {
  const h = /^(#{1,6})\s/.exec(line);
  if (h) return h[1].length;
  const li = /^(\s*)[-*]\s/.exec(line);
  if (li) return 100 + li[1].length;
  return null;
}

/** 링크 텍스트·주소는 지운다 — 목차의 「[지금 할 일](#x)」 가 블록으로 잡혔다. */
const stripLinks = (l: string) => l.replace(/\[[^\]]*\]\([^)]*\)/g, '');

function findBlock(lines: string[], needle: string): { from: number; to: number; hitCap: boolean; matches: number } | null {
  const inFence = fenceMask(lines);
  const cands: Array<{ i: number; d: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const d = depthOf(lines[i]);
    if (d === null || !stripLinks(lines[i]).includes(needle)) continue;
    cands.push({ i, d });
  }
  if (cands.length === 0) return null;
  const pick = cands.find(c => c.d < 100) ?? cands[0];      // 제목 우선
  let j = pick.i + 1;
  let hitCap = false;
  while (j < lines.length) {
    if (j - pick.i >= MAX_BLOCK_LINES) { hitCap = true; break; }
    const dj = inFence[j] ? null : depthOf(lines[j]);
    if (dj !== null && dj <= pick.d) break;
    j++;
  }
  return { from: pick.i + 1, to: j, hitCap, matches: cands.length };   // 1-based, 포함
}

export function readSource(projectPath: string, src: ContinuitySource, maxChars: number): CardItem {
  const label = src.label ?? src.path;
  const base: CardItem = { label, path: src.path, outcome: 'unreadable', ...(src.optional === true ? { optional: true } : {}) };
  const gate = denyReason(projectPath, src.path);
  if (gate.missing) {
    // 끊어진 링크는 「없음」 이 아니라 가리키는 곳을 못 따라간 것이다 — optional 이어도 중립으로 내지 않는다
    let dangling = false;
    if (base.optional) { try { fs.lstatSync(path.resolve(projectPath, src.path)); dangling = true; } catch { /* 정말 없음 */ } }
    if (dangling) { const { optional: _o, ...b } = base; return { ...b, outcome: 'missing', why: 'file not found (dangling link)' }; }
    return { ...base, outcome: 'missing', why: 'file not found' };
  }
  if (!gate.abs) return { ...base, outcome: 'denied', why: gate.why };

  let text: string, partial: boolean;
  try {
    ({ text, partial } = readHead(gate.abs, MAX_READ_BYTES));
  } catch {
    return { ...base, outcome: 'unreadable', why: 'unreadable' };
  }
  const lines = splitLines(text);

  let from = 1;
  let to: number;
  let hitCap = false;
  let matches: number | undefined;
  if (src.block) {
    const b = findBlock(lines, src.block);
    if (!b) return { ...base, outcome: 'no_block', why: partial ? `block not found in the first ${MAX_READ_BYTES >> 20} MB` : 'block not found', totalLines: lines.length };
    ({ from, to, hitCap, matches } = b);
  } else {
    to = Math.min(lines.length, Math.min(src.lines ?? DEFAULT_LINES, MAX_LINES));
  }

  const selected = lines.slice(from - 1, to);
  const slice = selected.join('\n');
  const sha = createHash('sha1').update(slice).digest('hex').slice(0, 10);
  if (!slice.trim()) {
    return { ...base, outcome: 'empty', why: 'selected range is empty', from, to, totalLines: lines.length, partialFile: partial, sha };
  }

  // 줄 단위로 넣다가, 넘치는 줄은 남은 예산만큼 글자로 잘라 넣고 끝낸다.
  // (긴 첫 줄 하나에 막혀 본문이 통째로 비던 문제)
  const kept: string[] = [];
  let used = 0;
  let shownTo = from - 1;
  let truncated = hitCap;
  let sliced = false;
  let budgetLimited = false;
  for (const l of selected) {
    const need = l.length + (kept.length ? 1 : 0);
    if (used + need <= maxChars) {
      kept.push(l); used += need; shownTo++;
      continue;
    }
    const room = maxChars - used - (kept.length ? 1 : 0);
    // ⛔ 표 행(`|` 로 시작)은 자르지 않는다(2.7 · reply-147 PB139-13). 결정 색인의 한 행이 「재개 조건」 칸 앞에서
    //    잘리면 반쪽 처분이 온전한 결정처럼 읽힌다. 통째로 빼고 「truncated」 로만 알린다.
    if (room > 20 && !/^\s*\|/.test(l)) { kept.push(l.slice(0, room) + '…'); shownTo++; sliced = true; }
    truncated = true;
    budgetLimited = true;
    break;
  }

  const excerpt = kept.join('\n');
  // ⚠ 자를 때 붙이는 「…」 는 본문이 아니다 — 공백 + 「…」 만 남은 발췌를 읽었다고 하면 안 된다.
  if (!excerpt.replace(/…$/, '').trim()) {
    // 범위에는 본문이 있는데 예산 안에 보인 것이 공백뿐 — 읽었다고 하면 안 된다.
    return { ...base, outcome: 'empty', why: 'nothing but blank lines fits in the card budget', from, to, totalLines: lines.length, partialFile: partial, sha };
  }
  return {
    ...base, outcome: 'ok', from, to, shownTo, totalLines: lines.length, partialFile: partial,
    sha, excerpt, truncated, matches,
    ...(sliced ? { sliced } : {}), ...(budgetLimited ? { budgetLimited } : {}),
  };
}

/** 발췌 안의 백틱 열보다 긴 펜스 — 문서의 ``` 가 카드의 펜스를 깨지 않게. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(s => s.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export interface ResumeCard {
  text: string;
  items: CardItem[];
  invalid: string[];
  /** 하나라도 실제 발췌가 있는가 — 없으면 「정본이 우선」 이라고 말하면 안 된다 */
  anyRead: boolean;
  /** 남는 예산 재분배 기록(2.7.2) — 측정·시험용. applied=false 면 카드는 C0 그대로다 */
  redistribution?: { spare: number; targets: number; extraReads: number; applied: boolean; why?: string };
  /** 첫 「현재 작업」 원천의 상태(2.7.3 PB154-D) — role 지정이 없으면 undefined */
  taskStatus?: TaskStatus;
  /** loop 최소 카드로 냈다(2.7.3 PB154-C) — 호출부는 Recent Sessions 도 뺀다 */
  minimal?: boolean;
}

function renderItem(it: CardItem, omitBody = false): string[] {
  if (it.outcome === 'ok' && omitBody) {
    // 본문만 뺀다 — 무엇을 어디서 읽어야 하는지(경로·범위·해시·상태)는 남긴다
    return [`### ${it.label} — \`${it.path}:${it.from}-${it.to}\` (of ${it.totalLines}${it.partialFile ? '+' : ''}) · sha1 ${it.sha} · ok · body omitted (loop card) — read the source directly`];
  }
  if (it.outcome === 'ok') {
    const total = `of ${it.totalLines}${it.partialFile ? '+' : ''}`;
    const bits = [`sha1 ${it.sha}`];
    if (it.truncated) bits.push(`truncated — shown to line ${it.shownTo}`);
    if (it.matches && it.matches > 1) bits.push(`${it.matches} matches — first heading/item used`);
    const fence = fenceFor(it.excerpt ?? '');
    return [`### ${it.label} — \`${it.path}:${it.from}-${it.to}\` (${total}) · ${bits.join(' · ')}`, fence, it.excerpt ?? '', fence];
  }
  // 2.7.3 (PB165-100): 선언이 optional 이고 **파일이 없을 때만** 중립 — 거부·읽기 실패·블록 없음은 아래 ⚠ 그대로
  if (it.outcome === 'missing' && it.optional === true) return [`### ${it.label} — \`${it.path}\` · file absent (optional source — not an error)`];
  return [`### ${it.label} — \`${it.path}\` · ⚠ NOT READ (${it.why ?? it.outcome})`];
}

/** 「현재 작업」 원천의 상태(2.7.3 PB154-D). budget = 읽었거나 읽을 수 있었지만 카드 예산 때문에 못 보였다. */
export type TaskStatus = CardOutcome | 'budget';

/** 첫 current-task 원천의 선언 위치(decl.sources 안). 없으면 경고도 없다. */
interface TaskWatch { index: number; src: ContinuitySource }

function taskStatusOf(items: CardItem[], task: TaskWatch | null): TaskStatus | undefined {
  if (!task) return undefined;
  const it = items[task.index];
  if (!it) return 'budget';                                   // 원천 수 상한·머리글 넘침으로 생략됨
  if (it.outcome === 'empty' && it.budgetHidden) return 'budget';
  // 블록 제목만 있고 본문이 비었다 — 명시적 대기 문구도 작업도 없다. 잘렸다면 본문이 있었다는 뜻이라 여기 안 온다.
  if (it.outcome === 'ok' && task.src.block && !it.truncated && !(it.excerpt ?? '').split('\n').slice(1).some(l => l.trim())) return 'empty';
  return it.outcome;
}

/** 카드 첫 줄. ⚠ = 추출 실패(작업을 모른다) · ℹ = 예산 때문에 안 보임(실패 아님) · ok·잘림 = 줄 없음. */
function taskLine(status: TaskStatus | undefined, task: TaskWatch | null): string | null {
  if (!task || status === undefined || status === 'ok') return null;
  const p = `\`${task.src.path.slice(0, 120)}\``;
  const what = task.src.block ? `block "${task.src.block.slice(0, 40)}"` : 'source';
  switch (status) {
    case 'budget':
      return `ℹ CURRENT TASK not shown in this card (card budget — not a failure) — read ${p} directly`;
    case 'no_block':
      return `⚠ CURRENT TASK UNKNOWN — ${what} not found in ${p} (this is not an explicit "none — waiting"). Read the source before picking work.`;
    case 'missing':
      return `⚠ CURRENT TASK UNKNOWN — ${p} not found. Read/restore the source before picking work.`;
    case 'empty':
      return `⚠ CURRENT TASK UNKNOWN — ${what} in ${p} is empty. Read the source before picking work.`;
    default:
      return `⚠ CURRENT TASK UNKNOWN — ${p} could not be read (${status}). Read the source before picking work.`;
  }
}

interface RenderCtx {
  task: TaskWatch | null;
  /** loop 최소 카드 — strip[i] 원천은 본문을 뺀다 */
  minimal: boolean;
  strip: boolean[];
}

function renderCard(items: CardItem[], invalid: string[], maxInvalid: number, ctx: RenderCtx): { text: string; anyRead: boolean } {
  const { task } = ctx;
  // ★ 읽음 상태는 **실제로 출력에 들어간 발췌**로 정한다 — 머리글을 문자열에서 추정하지 않는다.
  const anyRead = items.some(i => i.outcome === 'ok');
  const first = taskLine(taskStatusOf(items, task), task);
  const out: string[] = first ? [first] : [];
  out.push(ctx.minimal
    ? '## Resume card — loop minimal (statuses are from a fresh check · omitted bodies: read each source directly)'
    : anyRead
    ? '## Resume card — repo source of truth (read this before the DB summary below)'
    : '## Resume card — ⚠ none of the declared sources could be read (the DB summary below is all there is)');
  items.forEach((it, i) => out.push(...renderItem(it, ctx.minimal && ctx.strip[i])));
  if (invalid.length && maxInvalid > 0) {
    const shown = invalid.slice(0, maxInvalid).map(s => s.slice(0, 100));
    out.push(`⚠ ignored continuity entries: ${shown.join(', ')}${invalid.length > maxInvalid ? ` … +${invalid.length - maxInvalid}` : ''}`);
  } else if (invalid.length) {
    out.push(`⚠ ${invalid.length} continuity entr${invalid.length === 1 ? 'y' : 'ies'} ignored`);
  }
  return { text: out.join('\n'), anyRead };
}

export interface BuildCardOptions {
  /** false = 재분배 없이 C0 만(비교·측정용) */
  redistribute?: boolean;
  /** 재분배의 추가 읽기 — 시험이 두 읽기 사이 파일 변경을 넣을 때만 바꾼다 */
  readExtra?: typeof readSource;
  /** 이번 실행의 출처(2.7.3) — loop 이고 설정이 loopCard: "minimal" 일 때만 최소 카드. 기본 unknown = 전체 카드 */
  origin?: RunOrigin;
}

export function buildResumeCard(projectPath: string, maxChars: number, opts: BuildCardOptions = {}): ResumeCard | null {
  const decl = readContinuityDeclaration(projectPath);
  if (decl.sources.length === 0 && decl.invalid.length === 0) return null;

  const budget = clampCardChars(maxChars, 3200);
  // ★ 예산은 카드 **전체**(머리글·펜스·경고 포함)의 상한이다(reply-135 B5).
  const fit = Math.max(1, Math.floor(budget / (HEADER_RESERVE + 200)));
  const sources = decl.sources.slice(0, fit);
  const invalid = [...decl.invalid];
  for (const s of decl.sources.slice(fit)) invalid.push(`${s.path}: dropped — card budget ${budget} fits ${fit} source(s)`);
  // 2.7.3 (PB154-D): 첫 「현재 작업」 원천. 지정이 없으면 null — 경고 없음(기존 동작).
  const taskIndex = decl.sources.findIndex(s => s.role === 'current-task');
  const task: TaskWatch | null = taskIndex >= 0 ? { index: taskIndex, src: decl.sources[taskIndex] } : null;
  // 2.7.3 (PB154-C): 출처만으로 줄이지 않는다 — loop **그리고** 명시적 opt-in 일 때만
  const minimal = opts.origin === 'loop' && decl.loopCard === 'minimal';
  const ctx: RenderCtx = { task, minimal, strip: decl.sources.map(s => s.role === 'current-task' || s.role === 'history') };

  let per = Math.max(60, Math.floor((budget - HEADER_RESERVE * sources.length) / Math.max(1, sources.length)));
  let items = sources.map(s => readSource(projectPath, s, per));
  let maxInvalid = 4;
  let card = renderCard(items, invalid, maxInvalid, ctx);

  // 1) 발췌를 줄인다
  for (let k = 0; k < 4 && card.text.length > budget && per > 60; k++) {
    per = Math.max(60, Math.floor(per * budget / card.text.length) - 20);
    items = sources.map(s => readSource(projectPath, s, per));
    card = renderCard(items, invalid, maxInvalid, ctx);
  }
  // 2) 경고 목록을 개수만 남긴다
  if (card.text.length > budget) { maxInvalid = 0; card = renderCard(items, invalid, maxInvalid, ctx); }
  // 3) 뒤쪽 원천부터 「예산 때문에 안 보임」 으로 바꾼다 — 구조로, 그리고 그 사실을 적는다
  for (let i = items.length - 1; i >= 0 && card.text.length > budget; i--) {
    if (items[i].outcome !== 'ok') continue;
    items = items.map((it, j) => j === i
      ? { label: it.label, path: it.path, outcome: 'empty' as CardOutcome, budgetHidden: true, why: 'not shown — card budget too small', from: it.from, to: it.to, totalLines: it.totalLines, sha: it.sha }
      : it);
    card = renderCard(items, invalid, maxInvalid, ctx);
  }
  // 4) 그래도 넘치면(머리글만으로 넘침) 원천 줄을 뒤에서부터 뺀다
  let shownInvalid = invalid;
  while (card.text.length > budget && items.length > 0) {
    items = items.slice(0, -1);
    shownInvalid = [...invalid, 'some sources omitted — card budget too small'];
    maxInvalid = 0;
    card = renderCard(items, shownInvalid, maxInvalid, ctx);
  }
  const c0: ResumeCard = { text: card.text.slice(0, budget), items, invalid, anyRead: card.anyRead, taskStatus: taskStatusOf(items, task), ...(minimal ? { minimal } : {}) };

  // 5) 남는 예산을 **한 번** 잘린 원천에 똑같이 나눈다 (2.7.2 · Astra reply-150 PB150-01 계약 1~6)
  //   ★ 균등 몫은 없는 원천(NOT READ 한 줄)·짧은 원천의 몫을 그냥 버렸다 — Ashfall 실측 3200 중 2390 만 썼다.
  //   기준 = 위 1~4 를 끝낸 C0. 남는 몫 R = budget − C0 길이(머리 예약 잉여를 따로 더하면 이중 계산).
  //   대상 = 본문 몫 때문에 멈춘 원천만(블록 상한·생략된 원천·못 읽은 원천은 되살리지 않는다).
  //   새 발췌는 C0 발췌를 그대로 앞에 두어야 하고(프로그램이 붙인 「…」 만 빼고 비교), 선택 범위·해시가 같아야 한다.
  //   실제로 렌더해 상한을 넘거나 어느 조건이든 깨지면 **C0 전체로** 돌아간다 — 다른 원천을 줄여 맞추지 않는다.
  const spare = budget - c0.text.length;
  // 최소 카드에서 본문을 뺀 원천은 재분배 대상이 아니다(보이지 않는 본문을 늘리지 않는다)
  const targets = items.map((it, i) => ({ it, i })).filter(({ it, i }) => it.outcome === 'ok' && it.budgetLimited && !(minimal && ctx.strip[i]));
  if (opts.redistribute === false || spare <= 0 || targets.length === 0) return { ...c0, redistribution: { spare: Math.max(0, spare), targets: 0, extraReads: 0, applied: false } };
  const share = Math.floor(spare / targets.length);
  let extraReads = 0;
  const grown = [...items];
  for (const { it, i } of targets) {
    const shownBody = (it.excerpt ?? '').length - (it.sliced ? 1 : 0);
    const next = (opts.readExtra ?? readSource)(projectPath, sources[i], shownBody + share);
    extraReads++;
    const kept = it.sliced ? (it.excerpt ?? '').slice(0, -1) : (it.excerpt ?? '');
    const same = next.outcome === 'ok' && next.sha === it.sha && next.from === it.from && next.to === it.to
      && (next.excerpt ?? '').startsWith(kept);
    if (!same) return { ...c0, redistribution: { spare, targets: targets.length, extraReads, applied: false, why: `${it.path} changed or shrank between reads` } };
    grown[i] = next;
  }
  const out = renderCard(grown, shownInvalid, maxInvalid, ctx);
  if (out.text.length > budget) return { ...c0, redistribution: { spare, targets: targets.length, extraReads, applied: false, why: 'rendered card would exceed the budget' } };
  return { text: out.text, items: grown, invalid, anyRead: out.anyRead, taskStatus: taskStatusOf(grown, task), ...(minimal ? { minimal } : {}), redistribution: { spare, targets: targets.length, extraReads, applied: true } };
}
