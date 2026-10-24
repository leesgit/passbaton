/**
 * 선언 원천 직접 검색 (2.8 · Astra reply-174 PB174-300 「C1·C2 필수 계약」 C2 · reply-170 §4 · packet-170 §2-3).
 *
 * 무엇: 프로젝트 `.claude/passbaton.config.json` 에 **선언된** 원천만 그 자리에서 읽어 문구를 찾는다. 새 색인 DB 없음.
 *   결과마다 경로 · 절(제목 경로) · 줄 범위 · 실제 읽은 바이트의 sha256(파일 전체 + 범위 + 발췌) · 발췌 · Git 상태(보조) ·
 *   대체 관계(**명시된 절별 근거가 있을 때만** — 없으면 「대체 관계 미확인」).
 *
 * ⛔ 계약
 *   - 선언 밖은 읽지 않는다: `search.sources`(path 또는 glob) — 없으면 `continuity.sources` 의 경로. 레포 전체 훑기 없음.
 *     glob 은 프로젝트 안 상대 경로만(`..`·절대 경로 거부) · 다른 프로젝트(하위 폴더에 자기 `.claude/passbaton.config.json`
 *     이나 `.git` 이 있는 곳) 문서는 빼고 그렇다고 적는다 · 경계는 재개 카드와 같은 denyReason(실경로·텍스트·비밀 이름).
 *   - 대체 관계는 선언된 근거 표(`search.supersession` — 열 `대상 | 관계 | 근거`)의 **절을 명시한 행**에서만 온다.
 *     절 없는 행(파일·처분 전체)은 쓰지 않고 `ignoredEvidence` 로 낸다 — `reply-169 → reply-167 전체 폐기` 같은 관계를 만들지 않는다.
 *     근거가 없으면 유효·폐기 어느 쪽으로도 표시하지 않는다.
 *   - 정체는 실제 읽은 바이트의 sha256. Git 상태는 보조(비추적·수정 파일도 바이트로 식별).
 *   - 부작용 없음: DB·파일·설정을 만들거나 바꾸지 않는다. 결과는 권한 판정·처분 자동 적용 입력이 아니다(`authority`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { denyReason, MAX_CONFIG_BYTES } from './resume-card.js';

export const SEARCH_SCHEMA = 'passbaton.source-search/1';
export const UNKNOWN_SUPERSESSION = '대체 관계 미확인';
export const AUTHORITY_NOTE = 'none — lookup aid only; not an authority decision, not an auto-apply input; nothing was written';
export const MAX_SEARCH_FILES = 2000;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_EXCERPT_BYTES = 1200;
const MAX_HITS_SHOWN = 6;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
const gitBlobOf = (b: Buffer) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));
const posix = (p: string) => p.replace(/\\/g, '/');

// ───────────────────────── 선언 ─────────────────────────

export interface SearchSourceDecl { path?: string; glob?: string; block?: string; label?: string }
export interface SearchDeclaration {
  /** 어디서 온 선언인가 — search.sources · continuity.sources(대체) · 없음 */
  from: 'search.sources' | 'continuity.sources' | 'none';
  sources: SearchSourceDecl[];
  supersession: string[];
  invalid: string[];
  config: { path: string; present: boolean; sha256: string | null };
}

export function readSearchDeclaration(projectDir: string, configPath?: string): SearchDeclaration {
  const file = configPath ? path.resolve(configPath) : path.join(projectDir, '.claude', 'passbaton.config.json');
  const out: SearchDeclaration = { from: 'none', sources: [], supersession: [], invalid: [], config: { path: file, present: false, sha256: null } };
  let buf: Buffer;
  try {
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) { out.invalid.push('config larger than 64 KB — ignored'); return out; }
    buf = fs.readFileSync(file);
  } catch { return out; }
  out.config = { path: file, present: true, sha256: sha256(buf) };
  let raw: unknown;
  try { raw = JSON.parse(buf.toString('utf-8').replace(/^﻿/, '')); } catch { out.invalid.push('config is not valid JSON'); return out; }
  const obj = (raw ?? {}) as { search?: { sources?: unknown; supersession?: unknown }; continuity?: { sources?: unknown } };
  const str = (v: unknown) => typeof v === 'string' && v.trim() ? v : undefined;
  if (obj.search !== undefined) {
    const list = obj.search?.sources;
    if (!Array.isArray(list)) out.invalid.push('search.sources (not an array)');
    else {
      out.from = 'search.sources';
      for (const s of list) {
        const e = (s ?? {}) as Record<string, unknown>;
        const p = str(e.path), g = str(e.glob);
        if ((p ? 1 : 0) + (g ? 1 : 0) !== 1) { out.invalid.push(`search source needs exactly one of path/glob: ${JSON.stringify(s).slice(0, 60)}`); continue; }
        out.sources.push({ ...(p ? { path: p } : {}), ...(g ? { glob: g } : {}), ...(str(e.block) ? { block: str(e.block) } : {}), ...(str(e.label) ? { label: str(e.label) } : {}) });
      }
    }
    const sup = obj.search?.supersession;
    if (sup !== undefined) {
      if (!Array.isArray(sup)) out.invalid.push('search.supersession (not an array)');
      else for (const s of sup) {
        const p = typeof s === 'string' ? str(s) : str((s as Record<string, unknown> | null)?.path);
        if (p) out.supersession.push(p); else out.invalid.push(`search.supersession entry: ${JSON.stringify(s).slice(0, 60)}`);
      }
    }
    return out;
  }
  const cont = obj.continuity?.sources;
  if (Array.isArray(cont)) {
    out.from = 'continuity.sources';
    for (const s of cont) { const p = str((s as Record<string, unknown> | null)?.path); if (p) out.sources.push({ path: p }); }
  }
  return out;
}

// ───────────────────────── 원천 해석(glob · 경계) ─────────────────────────

function segRegex(seg: string): RegExp {
  const esc = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`, 'i');
}

/** 하위 폴더가 다른 프로젝트인가(자기 설정이나 .git) — 프로젝트 루트 자신은 아니다 */
function isOtherProjectRoot(abs: string, root: string): boolean {
  if (path.resolve(abs) === path.resolve(root)) return false;
  return fs.existsSync(path.join(abs, '.claude', 'passbaton.config.json')) || fs.existsSync(path.join(abs, '.git'));
}

/** rel(프로젝트 상대)이 다른 프로젝트 안에 있으면 그 폴더(상대) */
function otherProjectOf(root: string, rel: string): string | null {
  const segs = posix(rel).split('/');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    if (isOtherProjectRoot(cur, root)) return segs.slice(0, i + 1).join('/');
  }
  return null;
}

export interface Excluded { path: string; why: string }

function expandGlob(root: string, glob: string, excluded: Excluded[], limit: number): string[] {
  const segs = posix(glob).split('/').filter(s => s !== '' && s !== '.');
  const found: string[] = [];
  const walk = (dirRel: string, i: number) => {
    if (found.length >= limit) return;
    if (i >= segs.length) return;
    const dirAbs = path.join(root, dirRel);
    const seg = segs[i];
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    if (seg === '**') {
      walk(dirRel, i + 1);
      for (const e of ents) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
        const sub = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (isOtherProjectRoot(path.join(root, sub), root)) { excluded.push({ path: sub + '/', why: 'other project (own .claude/passbaton.config.json or .git)' }); continue; }
        walk(sub, i);
      }
      return;
    }
    const re = segRegex(seg);
    const last = i === segs.length - 1;
    for (const e of ents) {
      if (!re.test(e.name)) continue;
      const sub = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (last) { if (!e.isDirectory()) found.push(sub); continue; }
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      if (isOtherProjectRoot(path.join(root, sub), root)) { excluded.push({ path: sub + '/', why: 'other project (own .claude/passbaton.config.json or .git)' }); continue; }
      walk(sub, i + 1);
    }
  };
  walk('', 0);
  return found.sort();
}

interface ResolvedSource { rel: string; abs: string; block?: string; label?: string }

export function resolveSearchSources(projectDir: string, decl: SearchDeclaration): { files: ResolvedSource[]; excluded: Excluded[]; capped: boolean } {
  const root = path.resolve(projectDir);
  const excluded: Excluded[] = [];
  const seen = new Map<string, ResolvedSource>();
  let capped = false;
  const add = (rel: string, d: SearchSourceDecl) => {
    if (seen.size >= MAX_SEARCH_FILES) { capped = true; return; }
    const relP = posix(rel);
    const other = otherProjectOf(root, relP);
    if (other) { excluded.push({ path: relP, why: `other project (${other}/)` }); return; }
    const gate = denyReason(root, relP);
    if (gate.missing) { excluded.push({ path: relP, why: 'missing' }); return; }
    if (!gate.abs) { excluded.push({ path: relP, why: gate.why ?? 'denied' }); return; }
    if (!seen.has(gate.abs)) seen.set(gate.abs, { rel: relP, abs: gate.abs, ...(d.block ? { block: d.block } : {}), ...(d.label ? { label: d.label } : {}) });
  };
  for (const d of decl.sources) {
    const pat = d.path ?? d.glob ?? '';
    if (path.isAbsolute(pat) || /^[a-z]:/i.test(pat) || posix(pat).split('/').includes('..')) { excluded.push({ path: pat, why: 'outside the project (absolute or ..)' }); continue; }
    if (d.path) add(d.path, d);
    else for (const rel of expandGlob(root, pat, excluded, MAX_SEARCH_FILES + 1)) add(rel, d);
  }
  return { files: [...seen.values()], excluded, capped };
}

// ───────────────────────── 절 ─────────────────────────

export interface Section { title: string; level: number; num: number | null; line: number }

/** 마크다운 제목 + 줄 전체 굵은 글(`**1. 결정**`) — 번호 굵은 글은 7, 그 밖 굵은 글은 8 */
export function parseSections(lines: string[], markdown: boolean): Section[] {
  const out: Section[] = [];
  if (!markdown) return out;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    let m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) {
      const t = m[2].trim();
      const n = /^(\d+)[.)]\s/.exec(t);
      out.push({ title: t, level: m[1].length, num: n ? Number(n[1]) : null, line: i + 1 });
      continue;
    }
    // 굵은 제목 줄 — 짧고 안에 ** 가 없을 때만(굵은 문장 한 줄은 제목이 아니다)
    m = /^\*\*([^*]{1,80})\*\*\s*$/.exec(l);
    if (m) {
      const t = m[1].trim();
      const n = /^(\d+)[.)]\s/.exec(t);
      out.push({ title: t, level: n ? 7 : 8, num: n ? Number(n[1]) : null, line: i + 1 });
    }
  }
  return out;
}

/** 줄 n(1-based)이 속한 절 경로(바깥 → 안) */
function sectionPathAt(secs: Section[], n: number): Section[] {
  const stack: Section[] = [];
  for (const s of secs) {
    if (s.line > n) break;
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
    stack.push(s);
  }
  return stack;
}

/** block(제목 글) 영역: 그 제목 줄 다음부터 같은 수준 이상의 다른 제목 앞까지. 여러 개면 처음 것(같은 제목 반복은 끝으로 보지 않는다) */
function blockRange(secs: Section[], total: number, block: string): { from: number; to: number } | null {
  const i = secs.findIndex(s => s.title === block);
  if (i < 0) return null;
  const h = secs[i];
  const end = secs.slice(i + 1).find(s => s.level <= h.level && s.title !== block);
  return { from: h.line + 1, to: end ? end.line - 1 : total };
}

// ───────────────────────── 대체 관계 근거 ─────────────────────────

export interface SectionRef { ref: string; from: number; to: number; text: string }
export interface SupersessionRelation { relation: string; target: SectionRef; by: string; evidence: { path: string; line: number; sha256: string } }
export interface IgnoredEvidence { path: string; line: number; why: string; text: string }

const SECTION_REF = /((?:\d{4}-\d{2}-\d{2}-)?reply-\d+|[\w.-]+\.md)\s*(?:「[^」]*」\s*)?§\s*(\d+)(?:\s*[-–~]\s*§?\s*(\d+))?/;

export function parseSectionRef(cell: string): SectionRef | null {
  const m = SECTION_REF.exec(cell);
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  return { ref: m[1], from: Math.min(from, to), to: Math.max(from, to), text: m[0] };
}

/** 근거 표 파싱: 머리에 대상·관계 열이 있는 마크다운 표. 대상 칸에 절(§N)이 없는 행은 쓰지 않는다. */
export function parseSupersessionTable(rel: string, buf: Buffer): { relations: SupersessionRelation[]; ignored: IgnoredEvidence[] } {
  const lines = buf.toString('utf-8').split(/\r?\n/);
  const relations: SupersessionRelation[] = [];
  const ignored: IgnoredEvidence[] = [];
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  let cols: { target: number; relation: number; by: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) { cols = null; continue; }
    const c = cells(l);
    if (!cols) {
      const find = (...names: string[]) => c.findIndex(x => names.includes(x.replace(/\*/g, '').trim().toLowerCase()));
      const t = find('대상', 'target'), r = find('관계', 'relation'), b = find('근거', 'by', '대체한 쪽');
      if (t >= 0 && r >= 0) cols = { target: t, relation: r, by: b };
      continue;
    }
    if (c.every(x => /^:?-{2,}:?$/.test(x))) continue;
    const target = c[cols.target] ?? '';
    const relation = (c[cols.relation] ?? '').trim();
    const by = cols.by >= 0 ? (c[cols.by] ?? '').trim() : '';
    const ref = parseSectionRef(target);
    if (!ref) { ignored.push({ path: rel, line: i + 1, why: 'target names no section (§N) — whole-file/row-level relations are not used', text: l.trim().slice(0, 200) }); continue; }
    if (!relation) { ignored.push({ path: rel, line: i + 1, why: 'empty relation', text: l.trim().slice(0, 200) }); continue; }
    relations.push({ relation, target: ref, by, evidence: { path: rel, line: i + 1, sha256: sha256(l) } });
  }
  return { relations, ignored };
}

function refMatchesPath(ref: string, relPath: string): boolean {
  const base = path.posix.basename(posix(relPath)).toLowerCase();
  const r = ref.toLowerCase();
  if (r.endsWith('.md')) return base === r;
  return base === `${r}.md` || base.endsWith(`-${r}.md`);
}

// ───────────────────────── 검색 ─────────────────────────

export type GitState = 'clean' | 'modified' | 'untracked' | 'unknown';
export interface SearchResult {
  path: string;
  label?: string;
  section: string;
  sectionNo: number | null;
  lines: { from: number; to: number };
  hitLines: number[];
  file: { bytes: number; sha256: string };
  range: { from: number; to: number; sha256: string };
  excerpt: { from: number; to: number; text: string; sha256: string; truncated: boolean };
  git: { state: GitState; aux: true };
  supersession: { status: 'unknown'; label: typeof UNKNOWN_SUPERSESSION } | { status: 'explicit'; relations: SupersessionRelation[] };
  score: number;
}

export interface SearchReport {
  schema: typeof SEARCH_SCHEMA;
  project: string;
  query: string;
  terms: string[];
  declaration: { from: SearchDeclaration['from']; config: SearchDeclaration['config']; invalid: string[] };
  results: SearchResult[];
  totalMatches: number;
  excluded: Excluded[];
  ignoredEvidence: IgnoredEvidence[];
  stats: { filesRead: number; bytesRead: number; ms: number; capped: boolean };
  authority: typeof AUTHORITY_NOTE;
}

export interface SearchOptions { maxResults?: number; git?: boolean; configPath?: string }

function gitRead(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, '--no-optional-locks', ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 15000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
}

/** 보조 Git 상태 — HEAD 의 같은 경로 blob 과 실제 바이트 비교 · 색인에도 HEAD 에도 없으면 untracked */
function gitStates(root: string, files: { rel: string; buf: Buffer }[]): Map<string, GitState> {
  const m = new Map<string, GitState>();
  if (!files.length) return m;
  const inside = gitRead(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') { for (const f of files) m.set(f.rel, 'unknown'); return m; }
  const rels = files.map(f => f.rel);
  const head = new Map<string, string>();
  const tree = gitRead(root, ['ls-tree', '-r', 'HEAD', '--', ...rels]);
  const prefix = (gitRead(root, ['rev-parse', '--show-prefix']) ?? '').trim();
  for (const line of (tree ?? '').split('\n')) {
    const mm = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (mm) head.set(mm[2].startsWith(prefix) ? mm[2].slice(prefix.length) : mm[2], mm[1]);
  }
  const indexed = new Set((gitRead(root, ['ls-files', '--', ...rels]) ?? '').split('\n').map(s => s.trim()).filter(Boolean));
  for (const f of files) {
    const hb = head.get(f.rel);
    if (hb) m.set(f.rel, hb === gitBlobOf(f.buf) ? 'clean' : 'modified');
    else m.set(f.rel, indexed.has(f.rel) ? 'modified' : (tree === null ? 'unknown' : 'untracked'));
  }
  return m;
}

export function splitTerms(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

function excerptOf(lines: string[], from: number, to: number): { text: string; truncated: boolean } {
  const raw = lines.slice(from - 1, to).join('\n');
  if (Buffer.byteLength(raw, 'utf-8') <= MAX_EXCERPT_BYTES) return { text: raw, truncated: false };
  let t = raw;
  while (Buffer.byteLength(t, 'utf-8') > MAX_EXCERPT_BYTES) t = t.slice(0, Math.floor(t.length * 0.9));
  return { text: t, truncated: true };
}

/** 첫 맞은 줄 주변 창을 MAX_EXCERPT_BYTES 안으로 — 맞은 글이 긴 줄 뒤쪽이면 그 근처로 자른다 */
function hitExcerpt(lines: string[], hit: number, terms: string[]): { from: number; to: number; text: string; truncated: boolean } {
  const line = lines[hit - 1];
  const low = line.toLowerCase();
  if (Buffer.byteLength(line, 'utf-8') > MAX_EXCERPT_BYTES) {
    const at = Math.max(0, Math.min(...terms.map(t => low.indexOf(t)).filter(i => i >= 0)) - 120);
    const e = excerptOf([line.slice(at)], 1, 1);
    return { from: hit, to: hit, text: (at > 0 ? '…' : '') + e.text, truncated: true };
  }
  const from = Math.max(1, hit - 1);
  const to = Math.min(lines.length, hit + 1);
  return { from, to, ...excerptOf(lines, from, to) };
}

export function searchSources(projectDir: string, query: string, opts: SearchOptions = {}): SearchReport {
  const t0 = process.hrtime.bigint();
  const root = path.resolve(projectDir);
  const decl = readSearchDeclaration(root, opts.configPath);
  const terms = splitTerms(query);
  const { files, excluded, capped } = resolveSearchSources(root, decl);
  const maxResults = Math.max(1, Math.min(200, opts.maxResults ?? 20));
  let bytesRead = 0;
  let filesRead = 0;
  let totalCapped = capped;

  // 대체 관계 근거 — 선언된 근거 표만
  const relations: SupersessionRelation[] = [];
  const ignoredEvidence: IgnoredEvidence[] = [];
  for (const rel of decl.supersession) {
    const gate = posix(rel).split('/').includes('..') || path.isAbsolute(rel) ? { why: 'outside the project' } : denyReason(root, rel);
    const other = otherProjectOf(root, rel);
    if (other || !('abs' in gate) || !gate.abs) { excluded.push({ path: posix(rel), why: other ? `other project (${other}/)` : ('missing' in gate && gate.missing ? 'missing' : (gate.why ?? 'denied')) }); continue; }
    const b = fs.readFileSync(gate.abs);
    bytesRead += b.length; filesRead++;
    const p = parseSupersessionTable(posix(rel), b);
    relations.push(...p.relations); ignoredEvidence.push(...p.ignored);
  }

  const read: { rel: string; buf: Buffer }[] = [];
  const all: SearchResult[] = [];
  if (terms.length) {
    for (const f of files) {
      let size: number;
      try { size = fs.statSync(f.abs).size; } catch { excluded.push({ path: f.rel, why: 'unreadable' }); continue; }
      if (size > MAX_FILE_BYTES) { excluded.push({ path: f.rel, why: `larger than ${MAX_FILE_BYTES >> 20} MB — not read` }); continue; }
      if (bytesRead + size > MAX_TOTAL_BYTES) { totalCapped = true; excluded.push({ path: f.rel, why: 'total read budget reached — not read' }); continue; }
      const buf = fs.readFileSync(f.abs);
      bytesRead += buf.length; filesRead++;
      read.push({ rel: f.rel, buf });
      const text = buf.toString('utf-8');
      const lines = text.split(/\r?\n/);
      const md = /\.(md|markdown)$/i.test(f.rel);
      const secs = parseSections(lines, md);
      let lo = 1, hi = lines.length;
      if (f.block) {
        const r = blockRange(secs, lines.length, f.block);
        if (!r) { excluded.push({ path: f.rel, why: `block 「${f.block}」 not found — not searched` }); continue; }
        lo = r.from; hi = r.to;
      }
      // 잎 구간: 절 표시 줄 사이(block 안)
      const marks = secs.map(s => s.line).filter(n => n >= lo && n <= hi);
      const cuts = [lo, ...marks.filter(n => n > lo), hi + 1];
      const fileSha = sha256(buf);
      for (let k = 0; k < cuts.length - 1; k++) {
        const from = cuts[k], to = cuts[k + 1] - 1;
        if (to < from) continue;
        const seg = lines.slice(from - 1, to);
        const lowSeg = seg.map(s => s.toLowerCase());
        if (!terms.every(t => lowSeg.some(s => s.includes(t)))) continue;
        const hitLines: number[] = [];
        let together = 0;
        lowSeg.forEach((s, j) => {
          const n = terms.filter(t => s.includes(t)).length;
          if (n) hitLines.push(from + j);
          if (n === terms.length) together++;
        });
        const phrase = lowSeg.some(s => s.includes(terms.join(' ')));
        const stack = sectionPathAt(secs, from);
        const numbered = [...stack].reverse().find(s => s.num !== null) ?? null;
        const firstTogether = hitLines.find(n => terms.every(t => lines[n - 1].toLowerCase().includes(t))) ?? hitLines[0];
        const ex = hitExcerpt(lines, firstTogether, terms);
        const rangeText = seg.join('\n');
        const rels = relations.filter(r => numbered && refMatchesPath(r.target.ref, f.rel) && numbered.num! >= r.target.from && numbered.num! <= r.target.to);
        all.push({
          path: f.rel, ...(f.label ? { label: f.label } : {}),
          section: stack.map(s => s.title).join(' › ') || '(no heading)',
          sectionNo: numbered?.num ?? null,
          lines: { from, to }, hitLines: hitLines.slice(0, MAX_HITS_SHOWN),
          file: { bytes: buf.length, sha256: fileSha },
          range: { from, to, sha256: sha256(rangeText) },
          excerpt: { from: ex.from, to: ex.to, text: ex.text, sha256: sha256(ex.text), truncated: ex.truncated },
          git: { state: 'unknown', aux: true },
          supersession: rels.length ? { status: 'explicit', relations: rels } : { status: 'unknown', label: UNKNOWN_SUPERSESSION },
          score: (phrase ? 100 : 0) + together * 10 + hitLines.length,
        });
      }
    }
  }
  all.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lines.from - b.lines.from);
  const results = all.slice(0, maxResults);
  if (opts.git !== false && results.length) {
    const used = new Set(results.map(r => r.path));
    const st = gitStates(root, read.filter(r => used.has(r.rel)));
    for (const r of results) r.git = { state: st.get(r.path) ?? 'unknown', aux: true };
  }
  return {
    schema: SEARCH_SCHEMA, project: root, query, terms,
    declaration: { from: decl.from, config: decl.config, invalid: decl.invalid },
    results, totalMatches: all.length, excluded, ignoredEvidence,
    stats: { filesRead, bytesRead, ms: Number(process.hrtime.bigint() - t0) / 1e6, capped: totalCapped },
    authority: AUTHORITY_NOTE,
  };
}

/** 저장된 결과를 지금 바이트와 대조 — 문제 목록(빈 배열 = 일치). 원문 변경·삭제를 드러낸다. */
export function verifySearchReport(report: SearchReport): string[] {
  const bad: string[] = [];
  if (report.schema !== SEARCH_SCHEMA) bad.push(`schema ${String(report.schema)} ≠ ${SEARCH_SCHEMA}`);
  const cache = new Map<string, Buffer | null>();
  for (const r of report.results) {
    if (!cache.has(r.path)) {
      let b: Buffer | null = null;
      try { b = fs.readFileSync(path.resolve(report.project, r.path)); } catch { b = null; }
      cache.set(r.path, b);
    }
    const now = cache.get(r.path) ?? null;
    if (!now) { bad.push(`${r.path}: deleted or unreadable since the search`); continue; }
    if (sha256(now) !== r.file.sha256) bad.push(`${r.path}: file bytes changed since the search (sha256 ${sha256(now).slice(0, 12)} ≠ ${r.file.sha256.slice(0, 12)})`);
    const lines = now.toString('utf-8').split(/\r?\n/);
    if (sha256(lines.slice(r.range.from - 1, r.range.to).join('\n')) !== r.range.sha256) bad.push(`${r.path}:${r.range.from}-${r.range.to}: section bytes changed`);
  }
  return [...new Set(bad)];
}

// ───────────────────────── 정답표 측정 ─────────────────────────

export interface GoldExpect { path: string; section?: string; supersession?: string }
export interface GoldQuery { query: string; expect: GoldExpect[] }
export interface GoldTable { name?: string; queries: GoldQuery[] }

export interface GoldQueryScore {
  query: string;
  expected: number;
  found: number;
  misses: GoldExpect[];
  /** 누락마다 원인(측정 보조 — 합격 판정에 쓰지 않는다): 선언 밖 · 제외 · 순위 밖 · 그 절에 없는 낱말 */
  missWhy: string[];
  labelErrors: { expect: GoldExpect; got: string }[];
  extras: { path: string; section: string }[];
  results: number;
  ms: number;
  bytesRead: number;
  filesRead: number;
}
export interface GoldScore { name?: string; pass: boolean; queries: GoldQueryScore[]; totals: { expected: number; found: number; misses: number; labelErrors: number; extras: number; ms: number; bytesRead: number } }

export function supersessionLabel(r: Pick<SearchResult, 'supersession'>): string {
  return r.supersession.status === 'unknown' ? UNKNOWN_SUPERSESSION : r.supersession.relations.map(x => x.relation).join(' · ');
}

const expectMatches = (e: GoldExpect, r: Pick<SearchResult, 'path' | 'section'>) =>
  posix(r.path) === posix(e.path) && (e.section === undefined || r.section.includes(e.section));

/** 결과 개수가 아니라 (경로·절) 쌍과 대체 표시로 잰다. 모든 기대가 맞고 표시 오류 0 이어야 pass. */
export function scoreGoldQuery(q: GoldQuery, report: Pick<SearchReport, 'results' | 'stats'>): GoldQueryScore {
  const misses: GoldExpect[] = [];
  const labelErrors: GoldQueryScore['labelErrors'] = [];
  let found = 0;
  for (const e of q.expect) {
    const hits = report.results.filter(r => expectMatches(e, r));
    if (!hits.length) { misses.push(e); continue; }
    found++;
    if (e.supersession !== undefined) {
      const ok = hits.some(r => supersessionLabel(r) === e.supersession);
      if (!ok) labelErrors.push({ expect: e, got: hits.map(supersessionLabel).join(' | ') });
    }
  }
  const extras = report.results.filter(r => !q.expect.some(e => expectMatches(e, r))).map(r => ({ path: r.path, section: r.section }));
  return { query: q.query, expected: q.expect.length, found, misses, missWhy: [], labelErrors, extras, results: report.results.length, ms: report.stats.ms, bytesRead: report.stats.bytesRead, filesRead: report.stats.filesRead };
}

/** 누락 원인 — 같은 선언으로 다시 찾아 본다(측정 시간·바이트에 넣지 않는다) */
function diagnoseMiss(projectDir: string, q: GoldQuery, e: GoldExpect, first: SearchReport, opts: SearchOptions): string {
  const ex = first.excluded.find(x => posix(x.path) === posix(e.path));
  if (ex) return `excluded — ${ex.why}`;
  const decl = readSearchDeclaration(path.resolve(projectDir), opts.configPath);
  if (!resolveSearchSources(path.resolve(projectDir), decl).files.some(f => f.rel === posix(e.path))) return 'not a declared source';
  const wide = searchSources(projectDir, q.query, { ...opts, maxResults: 200, git: false });
  const rank = wide.results.findIndex(r => expectMatches(e, r));
  if (rank >= 0) return `ranked out — rank ${rank + 1} > max results ${first.results.length}`;
  const absent = splitTerms(q.query).filter(t => !searchSources(projectDir, t, { ...opts, maxResults: 200, git: false }).results.some(r => expectMatches(e, r)));
  return absent.length ? `terms absent in that section (top-200 per term): ${absent.join(", ")}` : 'terms split across sub-sections';
}

export function measureGold(projectDir: string, gold: GoldTable, opts: SearchOptions = {}): GoldScore {
  const queries = gold.queries.map(q => {
    const rep = searchSources(projectDir, q.query, opts);
    const sc = scoreGoldQuery(q, rep);
    sc.missWhy = sc.misses.map(e => diagnoseMiss(projectDir, q, e, rep, opts));
    return sc;
  });
  const sum = (f: (x: GoldQueryScore) => number) => queries.reduce((a, x) => a + f(x), 0);
  const totals = { expected: sum(x => x.expected), found: sum(x => x.found), misses: sum(x => x.misses.length), labelErrors: sum(x => x.labelErrors.length), extras: sum(x => x.extras.length), ms: sum(x => x.ms), bytesRead: sum(x => x.bytesRead) };
  return { ...(gold.name ? { name: gold.name } : {}), pass: totals.expected > 0 && totals.misses === 0 && totals.labelErrors === 0, queries, totals };
}
