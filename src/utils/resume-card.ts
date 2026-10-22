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
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface ContinuitySource {
  path: string;
  lines?: number;
  block?: string;
  label?: string;
}

export interface ContinuityDeclaration {
  sources: ContinuitySource[];
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
  /** block 일치 개수(2 이상이면 모호함) */
  matches?: number;
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

  const sources = (raw as { continuity?: { sources?: unknown } })?.continuity?.sources;
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
    out.sources.push({
      path: src.path,
      lines: src.lines as number | undefined,
      block: src.block as string | undefined,
      label: typeof src.label === 'string' && src.label.trim() ? src.label.slice(0, 80) : src.path,
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
  const base: CardItem = { label, path: src.path, outcome: 'unreadable' };
  const gate = denyReason(projectPath, src.path);
  if (gate.missing) return { ...base, outcome: 'missing', why: 'file not found' };
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
  for (const l of selected) {
    const need = l.length + (kept.length ? 1 : 0);
    if (used + need <= maxChars) {
      kept.push(l); used += need; shownTo++;
      continue;
    }
    const room = maxChars - used - (kept.length ? 1 : 0);
    if (room > 20) { kept.push(l.slice(0, room) + '…'); shownTo++; }
    truncated = true;
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
}

function renderItem(it: CardItem): string[] {
  if (it.outcome === 'ok') {
    const total = `of ${it.totalLines}${it.partialFile ? '+' : ''}`;
    const bits = [`sha1 ${it.sha}`];
    if (it.truncated) bits.push(`truncated — shown to line ${it.shownTo}`);
    if (it.matches && it.matches > 1) bits.push(`${it.matches} matches — first heading/item used`);
    const fence = fenceFor(it.excerpt ?? '');
    return [`### ${it.label} — \`${it.path}:${it.from}-${it.to}\` (${total}) · ${bits.join(' · ')}`, fence, it.excerpt ?? '', fence];
  }
  return [`### ${it.label} — \`${it.path}\` · ⚠ NOT READ (${it.why ?? it.outcome})`];
}

function renderCard(items: CardItem[], invalid: string[], maxInvalid: number): { text: string; anyRead: boolean } {
  // ★ 읽음 상태는 **실제로 출력에 들어간 발췌**로 정한다 — 머리글을 문자열에서 추정하지 않는다.
  const anyRead = items.some(i => i.outcome === 'ok');
  const out: string[] = [anyRead
    ? '## Resume card — repo source of truth (read this before the DB summary below)'
    : '## Resume card — ⚠ none of the declared sources could be read (the DB summary below is all there is)'];
  for (const it of items) out.push(...renderItem(it));
  if (invalid.length && maxInvalid > 0) {
    const shown = invalid.slice(0, maxInvalid).map(s => s.slice(0, 100));
    out.push(`⚠ ignored continuity entries: ${shown.join(', ')}${invalid.length > maxInvalid ? ` … +${invalid.length - maxInvalid}` : ''}`);
  } else if (invalid.length) {
    out.push(`⚠ ${invalid.length} continuity entr${invalid.length === 1 ? 'y' : 'ies'} ignored`);
  }
  return { text: out.join('\n'), anyRead };
}

export function buildResumeCard(projectPath: string, maxChars: number): ResumeCard | null {
  const decl = readContinuityDeclaration(projectPath);
  if (decl.sources.length === 0 && decl.invalid.length === 0) return null;

  const budget = clampCardChars(maxChars, 3200);
  // ★ 예산은 카드 **전체**(머리글·펜스·경고 포함)의 상한이다(reply-135 B5).
  const fit = Math.max(1, Math.floor(budget / (HEADER_RESERVE + 200)));
  const sources = decl.sources.slice(0, fit);
  const invalid = [...decl.invalid];
  for (const s of decl.sources.slice(fit)) invalid.push(`${s.path}: dropped — card budget ${budget} fits ${fit} source(s)`);

  let per = Math.max(60, Math.floor((budget - HEADER_RESERVE * sources.length) / Math.max(1, sources.length)));
  let items = sources.map(s => readSource(projectPath, s, per));
  let maxInvalid = 4;
  let card = renderCard(items, invalid, maxInvalid);

  // 1) 발췌를 줄인다
  for (let k = 0; k < 4 && card.text.length > budget && per > 60; k++) {
    per = Math.max(60, Math.floor(per * budget / card.text.length) - 20);
    items = sources.map(s => readSource(projectPath, s, per));
    card = renderCard(items, invalid, maxInvalid);
  }
  // 2) 경고 목록을 개수만 남긴다
  if (card.text.length > budget) { maxInvalid = 0; card = renderCard(items, invalid, maxInvalid); }
  // 3) 뒤쪽 원천부터 「예산 때문에 안 보임」 으로 바꾼다 — 구조로, 그리고 그 사실을 적는다
  for (let i = items.length - 1; i >= 0 && card.text.length > budget; i--) {
    if (items[i].outcome !== 'ok') continue;
    items = items.map((it, j) => j === i
      ? { label: it.label, path: it.path, outcome: 'empty' as CardOutcome, why: 'not shown — card budget too small', from: it.from, to: it.to, totalLines: it.totalLines, sha: it.sha }
      : it);
    card = renderCard(items, invalid, maxInvalid);
  }
  // 4) 그래도 넘치면(머리글만으로 넘침) 원천 줄을 뒤에서부터 뺀다
  while (card.text.length > budget && items.length > 0) {
    items = items.slice(0, -1);
    card = renderCard(items, [...invalid, 'some sources omitted — card budget too small'], 0);
  }
  return { text: card.text.slice(0, budget), items, invalid, anyRead: card.anyRead };
}
