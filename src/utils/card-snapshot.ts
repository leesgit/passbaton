/**
 * 공유 재개 카드 스냅샷 (2.8 · Astra reply-174 PB174-200 「C1·C2 필수 계약」 C1 · reply-170 §4 C1+N2).
 *
 * 무엇: `buildResumeCard`(순수 함수)를 **원천마다 한 번 읽은 바이트 버퍼**로 돌려 카드를 만들고, 그 같은 버퍼에서
 *   원천 전체 sha256·바이트 수·실제 선택 범위·잘림/생략 상태를 잰다. 카드 본문 전체 sha256·렌더 버전·설정 식별
 *   (passbaton.config.json 바이트의 sha256)을 함께 낸다. 같은 카드 파일을 Claude 와 Astra 양쪽 입력에 쓴다.
 *
 * ⛔ 계약
 *   - 부작용 없음: DB·hook-trace·설정·다른 파일을 만들거나 바꾸지 않는다. 쓰는 것은 호출자가 이름 붙인 출력 파일뿐(cli-card.ts).
 *   - 해시·범위·카드는 같은 버퍼에서 — 원천을 두 번 읽어 그 사이 변경이 섞이면 안 된다(재분배의 추가 읽기 포함).
 *   - 카드에 보이는 10 자 sha1 은 그대로 둔다(표시용). 전체 해시는 메타에만 있다.
 *   - Git 커밋·blob 은 **보조 정보**다. 정체는 실제 읽은 바이트의 sha256 — 비추적·수정 파일도 그것으로 식별한다.
 *   - 이 메타는 「카드 파일이 만들어졌다」 까지만 말한다. 입력 포함·호출 성공·모델이 읽음은 전달하는 쪽(프로젝트)이 따로 기록한다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  buildResumeCard, readContinuityDeclaration, selectedTextOf, MAX_READ_BYTES,
  type CardIo, type CardItem, type ResumeCard,
} from './resume-card.js';
import type { RunOrigin } from './run-origin.js';

/** 카드 렌더 규칙의 식별. resume-card.ts 의 출력 규칙을 바꾸면 올린다. */
export const CARD_RENDER_VERSION = 'passbaton-resume-card/2.10.0';
export const CARD_META_SCHEMA = 'passbaton.card-meta/1';
/** 스냅샷은 원천 전체를 읽어 전체 해시를 낸다 — 이보다 크면 읽지 않는다(NOT READ) */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');
/** git 이 같은 바이트에 줄 blob id(보조 대조용 — git 을 부르지 않고 바이트로 계산) */
const gitBlobOf = (b: Buffer) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));

export interface SnapshotIo extends CardIo {
  /** 실제로 읽은 원천(실경로 → 그때의 바이트). 같은 경로는 한 번만 읽는다. */
  readonly buffers: Map<string, Buffer>;
}

export function createSnapshotIo(): SnapshotIo {
  const buffers = new Map<string, Buffer>();
  return {
    buffers,
    read(abs: string): Buffer {
      const hit = buffers.get(abs);
      if (hit) return hit;
      const size = fs.statSync(abs).size;
      if (size > MAX_SNAPSHOT_BYTES) throw new Error(`larger than ${MAX_SNAPSHOT_BYTES >> 20} MB`);
      const b = fs.readFileSync(abs);
      buffers.set(abs, b);
      return b;
    },
  };
}

export type SourceDelivery = 'full' | 'partial' | 'none';

export interface CardMetaSource {
  index: number;
  label: string;
  path: string;
  role?: string;
  optional?: boolean;
  /** 카드에 원천 줄이 있는가 — false = 원천 수·예산 때문에 카드에서 빠졌다 */
  inCard: boolean;
  outcome: CardItem['outcome'] | 'omitted';
  why?: string;
  /** 읽은 바이트 전체(카드를 만든 그 버퍼) — 못 읽었으면 null */
  file: { bytes: number; sha256: string; gitBlob: string } | null;
  /** 카드가 고른 범위(1-based 포함) · 그 범위 글의 바이트·sha256 · 카드에 보인 10 자 sha1 */
  range: { from: number; to: number; totalLines?: number; partialFile: boolean; bytes: number; sha256: string; displaySha1?: string } | null;
  shown: { toLine?: number; truncated: boolean; sliced: boolean; budgetLimited: boolean; budgetHidden: boolean; bodyOmitted: boolean };
  /** full = 고른 범위 전부가 카드에 보였다 · partial = 일부만 · none = 본문 없음(못 읽음·생략·예산) */
  delivery: SourceDelivery;
  /** 2.10 need 판정(선언했을 때만) · 잘렸을 때 생략량 */
  need?: CardItem['need'];
  omitted?: CardItem['omitted'];
  /** 보조: HEAD 의 같은 경로 blob 과 비교(git 없음·비추적이면 그렇다고 적는다) */
  git?: { headBlob: string | null; state: 'clean' | 'modified' | 'not-in-head' | 'unknown' };
}

export interface CardMeta {
  schema: typeof CARD_META_SCHEMA;
  renderVersion: string;
  packageVersion: string | null;
  project: string;
  generatedAt: string;
  maxChars: number;
  origin: RunOrigin;
  config: { path: string; present: boolean; bytes: number | null; sha256: string | null };
  card: { path: string | null; bytes: number; chars: number; sha256: string; anyRead: boolean; minimal: boolean; taskStatus: string | null; insufficient?: string[] };
  sources: CardMetaSource[];
  invalid: string[];
  redistribution: ResumeCard['redistribution'] | null;
  git: { aux: true; head: string | null; note: string } | null;
  /** 이 메타가 말하는 범위 — 파일 생성까지. 전달·호출·모델 확인은 아니다. */
  claims: 'card-file-created-only';
}

export interface SnapshotOptions {
  maxChars: number;
  origin?: RunOrigin;
  /** 보조 git 대조(HEAD blob) — 기본 켬. 읽기 전용 명령만(GIT_OPTIONAL_LOCKS=0) */
  git?: boolean;
  /** 기록할 카드 경로(메타에 적기만 한다) */
  cardPath?: string | null;
  /** 바이트 공급(기본 createSnapshotIo()) — 같은 버퍼 계약을 시험할 때 감싼 것을 넘긴다 */
  io?: SnapshotIo;
}

export interface CardSnapshot {
  text: string;
  bytes: Buffer;
  meta: CardMeta;
}

function packageVersion(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pj = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf-8')) as { version?: unknown };
    return typeof pj.version === 'string' ? pj.version : null;
  } catch { return null; }
}

function gitRead(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, '--no-optional-locks', ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10000,
    }).trim();
  } catch { return null; }
}

/** 카드 + 메타. 선언이 없으면 null(카드 없음). 파일을 쓰지 않는다. */
export function renderCardSnapshot(projectDir: string, opts: SnapshotOptions): CardSnapshot | null {
  const project = path.resolve(projectDir);
  const io = opts.io ?? createSnapshotIo();
  const origin: RunOrigin = opts.origin ?? 'unknown';
  // 2.10 ages — 카드의 경과와 메타 generatedAt 이 같은 시각에서 나온다
  const now = Date.now();
  const card = buildResumeCard(project, opts.maxChars, { origin, io, now });
  if (!card) return null;
  // 선언도 같은 버퍼에서 다시 해석한다(캐시 적중 — 다시 읽지 않는다)
  const decl = readContinuityDeclaration(project, io);
  const cfgPath = path.join(project, '.claude', 'passbaton.config.json');
  const cfgBuf = io.buffers.get(cfgPath) ?? null;
  const bytes = Buffer.from(card.text, 'utf-8');
  const strip = (role?: string) => role === 'current-task' || role === 'history';

  const head = opts.git === false ? null : gitRead(project, ['rev-parse', 'HEAD']);
  const sources: CardMetaSource[] = decl.sources.map((src, index) => {
    const it: CardItem | undefined = card.items[index];
    let abs: string | null = null;
    try { abs = fs.realpathSync(path.resolve(project, src.path)); } catch { abs = null; }
    const buf = abs ? io.buffers.get(abs) ?? null : null;
    const bodyOmitted = Boolean(card.minimal && strip(src.role) && it?.outcome === 'ok');
    const base = {
      index, label: src.label ?? src.path, path: src.path,
      ...(src.role ? { role: src.role } : {}), ...(src.optional ? { optional: true } : {}),
    };
    const file = buf ? { bytes: buf.length, sha256: sha256(buf), gitBlob: gitBlobOf(buf) } : null;
    let range: CardMetaSource['range'] = null;
    if (buf && it && it.from !== undefined && it.to !== undefined) {
      const sel = selectedTextOf(buf, it.from, it.to);
      // 같은 버퍼인지 스스로 확인한다 — 카드의 10 자 sha1 이 이 버퍼의 범위에서 나와야 한다
      if (it.sha !== undefined && sha1(sel).slice(0, 10) !== it.sha) throw new Error(`internal: ${src.path} range hash differs from the card (not the same bytes)`);
      range = {
        from: it.from, to: it.to, ...(it.totalLines !== undefined ? { totalLines: it.totalLines } : {}),
        partialFile: buf.length > MAX_READ_BYTES, bytes: Buffer.byteLength(sel, 'utf-8'), sha256: sha256(sel),
        ...(it.sha ? { displaySha1: it.sha } : {}),
      };
    }
    const shown = {
      ...(it?.shownTo !== undefined ? { toLine: it.shownTo } : {}),
      truncated: Boolean(it?.truncated), sliced: Boolean(it?.sliced), budgetLimited: Boolean(it?.budgetLimited),
      budgetHidden: Boolean(it?.budgetHidden), bodyOmitted,
    };
    const delivery: SourceDelivery = it?.outcome === 'ok' && !bodyOmitted ? (it.truncated || (range?.partialFile ?? false) ? 'partial' : 'full') : 'none';
    let git: CardMetaSource['git'];
    if (opts.git !== false) {
      if (!head || !file) git = { headBlob: null, state: 'unknown' };
      else {
        const ls = gitRead(project, ['ls-tree', 'HEAD', '--', src.path.replace(/\\/g, '/')]);
        const m = ls ? /^\d+ blob ([0-9a-f]{40})\t/.exec(ls) : null;
        git = ls === null ? { headBlob: null, state: 'unknown' }
          : !m ? { headBlob: null, state: 'not-in-head' }
          : { headBlob: m[1], state: m[1] === file.gitBlob ? 'clean' : 'modified' };
      }
    }
    return {
      ...base, inCard: Boolean(it), outcome: it ? it.outcome : 'omitted', ...(it?.why ? { why: it.why } : {}),
      file, range, shown, delivery,
      ...(it?.need ? { need: it.need } : src.need && (src.need.rows !== undefined || src.need.items !== undefined) ? { need: { met: false, why: it ? 'not checked' : 'source omitted from the card' } } : {}),
      ...(it?.omitted ? { omitted: it.omitted } : {}),
      ...(git ? { git } : {}),
    };
  });

  const meta: CardMeta = {
    schema: CARD_META_SCHEMA,
    renderVersion: CARD_RENDER_VERSION,
    packageVersion: packageVersion(),
    project,
    generatedAt: new Date(now).toISOString(),
    maxChars: opts.maxChars,
    origin,
    config: { path: cfgPath, present: cfgBuf !== null, bytes: cfgBuf ? cfgBuf.length : null, sha256: cfgBuf ? sha256(cfgBuf) : null },
    card: {
      path: opts.cardPath ?? null, bytes: bytes.length, chars: card.text.length, sha256: sha256(bytes),
      anyRead: card.anyRead, minimal: Boolean(card.minimal), taskStatus: card.taskStatus ?? null,
      ...(card.insufficient ? { insufficient: card.insufficient } : {}),
    },
    sources,
    invalid: card.invalid,
    redistribution: card.redistribution ?? null,
    git: opts.git === false ? null : { aux: true, head, note: 'auxiliary only — identity is the sha256 of the bytes actually read' },
    claims: 'card-file-created-only',
  };
  return { text: card.text, bytes, meta };
}

/**
 * 저장된 카드·메타를 지금 바이트와 대조한다. 문제 목록(빈 배열 = 일치).
 * 카드 파일 바이트 · 설정 바이트 · 원천마다 전체 sha256. 「같은 Git HEAD」 는 일치 근거가 아니다.
 */
export function verifyCardSnapshot(meta: CardMeta, cardBytes: Buffer): string[] {
  const bad: string[] = [];
  if (meta.schema !== CARD_META_SCHEMA) bad.push(`meta schema ${String(meta.schema)} ≠ ${CARD_META_SCHEMA}`);
  if (sha256(cardBytes) !== meta.card.sha256 || cardBytes.length !== meta.card.bytes) bad.push(`card bytes differ (sha256 ${sha256(cardBytes).slice(0, 12)} ≠ ${String(meta.card.sha256).slice(0, 12)})`);
  let cfg: Buffer | null = null;
  try { cfg = fs.readFileSync(meta.config.path); } catch { cfg = null; }
  if ((cfg ? sha256(cfg) : null) !== meta.config.sha256) bad.push('config bytes differ');
  for (const s of meta.sources) {
    if (!s.file) continue;
    let now: Buffer | null = null;
    try { now = fs.readFileSync(fs.realpathSync(path.resolve(meta.project, s.path))); } catch { now = null; }
    if (!now) bad.push(`${s.path}: source no longer readable`);
    else if (sha256(now) !== s.file.sha256) bad.push(`${s.path}: source bytes differ since the card was made`);
  }
  return bad;
}
