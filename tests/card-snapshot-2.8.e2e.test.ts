// 2.8 — 공유 재개 카드 스냅샷 (Astra reply-174 PB174-200 「C1·C2 필수 계약」 C1 · §4)
//
// 계약: 부작용 없는 렌더(이름 붙인 출력 파일만 생성) · 해시·범위·카드가 **같은 바이트 버퍼**에서 · 원천 전체 sha256·실제 범위·
// 잘림/생략·바이트 · 렌더 버전·설정 식별 · 카드 전체 sha256 · Git 은 보조(같은 HEAD 의 작업 사본 변경도 바이트로 드러남).
// 음성 시험마다 적격 양성 대조를 둔다(§4) — 아무것도 안 내거나 전부 거부하는 구현은 통과하지 못한다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildResumeCard } from '../src/utils/resume-card.js';
import {
  renderCardSnapshot, verifyCardSnapshot, createSnapshotIo, CARD_RENDER_VERSION, CARD_META_SCHEMA,
  type CardMeta, type SnapshotIo,
} from '../src/utils/card-snapshot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../dist/cli-card.js');
const built = fs.existsSync(CLI);
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

const HANDOFF = '# 최신 절\n' + Array.from({ length: 40 }, (_, i) => `- 기록 ${i + 1}: 카드 스냅샷 시험 줄 — ${'가'.repeat(120)}`).join('\n') + '\n';
const PLAN = '# 계획\n\n## 지금 할 일\n- [ ] PB174-200 카드 결속\n- 정지: DEMO_STOP 유지\n\n## 이력\n- 옛 일\n';

function project(sources?: unknown[]) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-28card-')));
  roots.push(ws);
  const proj = path.join(ws, 'proj');
  const home = path.join(ws, 'home');
  const out = path.join(ws, 'out');
  for (const d of [path.join(proj, 'docs'), path.join(proj, '.claude'), path.join(proj, '.ralph'), home, out]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), HANDOFF);
  fs.writeFileSync(path.join(proj, '.ralph', 'fix_plan.md'), PLAN);
  fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'), JSON.stringify({
    continuity: {
      sources: sources ?? [
        { path: '.ralph/fix_plan.md', block: '지금 할 일', label: '지금 할 일', role: 'current-task' },
        { path: 'docs/HANDOFF.md', lines: 30, label: 'HANDOFF', role: 'history' },
        { path: 'docs/MISSING.md', lines: 5, label: '없는 원천' },
      ],
    },
  }));
  return { ws, proj, home, out };
}

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf-8' }).trim();
}

/** 디렉터리 트리 전체(경로 → sha256 · 폴더는 'dir') — 무엇이 생겼는지·바뀌었는지 */
function tree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { m.set(path.relative(root, p), 'dir'); walk(p); }
      else m.set(path.relative(root, p), sha256(fs.readFileSync(p)));
    }
  };
  walk(root);
  return m;
}

function cli(ws: { home: string; proj: string }, args: string[]) {
  const env = { ...process.env, HOME: ws.home, USERPROFILE: ws.home, APPDATA: path.join(ws.home, 'AppData'), PASSBATON_CARD_CHARS: '' };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ws.proj, env, encoding: 'utf-8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const readMeta = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as CardMeta;

describe.skipIf(!built)('C1 card CLI — side effects', () => {
  it('writes only the named card and meta files (whole temp tree incl. .git and HOME unchanged otherwise)', () => {
    const w = project();
    git(w.proj, 'init', '-q'); git(w.proj, 'add', '-A'); git(w.proj, 'commit', '-qm', 'base');
    const before = tree(w.ws);
    const card = path.join(w.out, 'card.md'), meta = path.join(w.out, 'card.meta.json');
    const r = cli(w, ['--project-dir', w.proj, '--out', card, '--meta', meta]);
    expect(r.code, r.err).toBe(0);
    const after = tree(w.ws);
    const added = [...after.keys()].filter(k => !before.has(k)).sort();
    const changed = [...before.keys()].filter(k => after.get(k) !== before.get(k));
    expect(added).toEqual([path.join('out', 'card.md'), path.join('out', 'card.meta.json')].sort());
    expect(changed).toEqual([]);
    // 양성 — 실제로 무언가를 냈다
    expect(fs.readFileSync(card, 'utf-8')).toContain('PB174-200 카드 결속');
  });

  it('without --meta, prints meta to stdout and writes only the card', () => {
    const w = project();
    const before = tree(w.ws);
    const card = path.join(w.out, 'c.md');
    const r = cli(w, ['--project-dir', w.proj, '--out', card]);
    expect(r.code, r.err).toBe(0);
    const m = JSON.parse(r.out) as CardMeta;
    expect(m.card.sha256).toBe(sha256(fs.readFileSync(card)));
    expect([...tree(w.ws).keys()].filter(k => !before.has(k))).toEqual([path.join('out', 'c.md')]);
  });

  it('refuses to overwrite an existing snapshot, to create folders, or to write a card without a declaration', () => {
    const w = project();
    const card = path.join(w.out, 'card.md'), meta = path.join(w.out, 'card.meta.json');
    expect(cli(w, ['--project-dir', w.proj, '--out', card, '--meta', meta]).code).toBe(0);   // 양성
    const keep = fs.readFileSync(card);
    fs.appendFileSync(path.join(w.proj, 'docs', 'HANDOFF.md'), 'x');
    const again = cli(w, ['--project-dir', w.proj, '--out', card, '--meta', meta]);
    expect(again.code).toBe(4);
    expect(fs.readFileSync(card).equals(keep)).toBe(true);
    const nodir = cli(w, ['--project-dir', w.proj, '--out', path.join(w.out, 'nope', 'card.md')]);
    expect(nodir.code).toBe(4);
    expect(fs.existsSync(path.join(w.out, 'nope'))).toBe(false);
    fs.rmSync(path.join(w.proj, '.claude', 'passbaton.config.json'));
    const before = tree(w.ws);
    const none = cli(w, ['--project-dir', w.proj, '--out', path.join(w.out, 'none.md'), '--meta', path.join(w.out, 'none.json')]);
    expect(none.code).toBe(3);
    expect([...tree(w.ws).keys()].filter(k => !before.has(k))).toEqual([]);
  });
});

describe('C1 card snapshot — same bytes, full identity', () => {
  it('card equals the normal resume card; meta hashes/ranges come from the bytes read', () => {
    const w = project();
    const snap = renderCardSnapshot(w.proj, { maxChars: 3200, git: false })!;
    expect(snap).not.toBeNull();
    expect(snap.text).toBe(buildResumeCard(w.proj, 3200)!.text);          // 같은 카드 함수 · 표시 불변
    const m = snap.meta;
    expect(m.schema).toBe(CARD_META_SCHEMA);
    expect(m.renderVersion).toBe(CARD_RENDER_VERSION);
    expect(m.card.sha256).toBe(sha256(Buffer.from(snap.text, 'utf-8')));
    expect(m.card.bytes).toBe(Buffer.byteLength(snap.text, 'utf-8'));
    expect(m.config.sha256).toBe(sha256(fs.readFileSync(path.join(w.proj, '.claude', 'passbaton.config.json'))));
    expect(m.claims).toBe('card-file-created-only');

    const [plan, handoff, missing] = m.sources;
    expect(plan.file!.sha256).toBe(sha256(fs.readFileSync(path.join(w.proj, '.ralph', 'fix_plan.md'))));
    expect(plan.range).toMatchObject({ from: 3, to: 6 });
    const planLines = PLAN.split('\n').slice(2, 6).join('\n');
    expect(plan.range!.sha256).toBe(sha256(planLines));
    expect(plan.range!.bytes).toBe(Buffer.byteLength(planLines));
    expect(snap.text).toContain(`sha1 ${plan.range!.displaySha1}`);
    expect(plan.delivery).toBe('full');
    expect(handoff.file!.bytes).toBe(Buffer.byteLength(HANDOFF));
    expect(handoff.range).toMatchObject({ from: 1, to: 30 });
    expect(handoff.delivery).toBe('partial');                              // 카드 예산 때문에 일부만 보였다
    expect(handoff.shown.truncated).toBe(true);
    expect(missing).toMatchObject({ outcome: 'missing', file: null, range: null, delivery: 'none' });
  });

  it('records sources the card omitted (budget) as not delivered', () => {
    const w = project(Array.from({ length: 6 }, (_, i) => ({ path: 'docs/HANDOFF.md', lines: 30, label: `H${i}` })));
    const m = renderCardSnapshot(w.proj, { maxChars: 400, git: false })!.meta;
    const omitted = m.sources.filter(s => !s.inCard);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every(s => s.outcome === 'omitted' && s.delivery === 'none')).toBe(true);
    expect(m.sources.filter(s => s.inCard).length).toBeGreaterThan(0);    // 양성 — 들어간 원천도 있다
  });

  it('a file changed between reads cannot mix into the card: every read of a path uses the first buffer', () => {
    const w = project([{ path: 'docs/HANDOFF.md', lines: 30, label: 'HANDOFF' }, { path: '.ralph/fix_plan.md', lines: 2, label: 'P' }]);
    const hf = path.join(w.proj, 'docs', 'HANDOFF.md');
    const orig = fs.readFileSync(hf);
    const inner = createSnapshotIo();
    const calls = new Map<string, number>();
    const io: SnapshotIo = {
      buffers: inner.buffers,
      read(abs) {
        const b = inner.read(abs);
        calls.set(abs, (calls.get(abs) ?? 0) + 1);
        if (abs === fs.realpathSync(hf) && calls.get(abs) === 1) fs.writeFileSync(hf, '# 바뀐 절\n- 다른 내용\n');   // 첫 읽기 직후 변경
        return b;
      },
    };
    const snap = renderCardSnapshot(w.proj, { maxChars: 3200, git: false, io })!;
    expect(calls.get(fs.realpathSync(hf))!).toBeGreaterThan(1);           // 렌더가 실제로 여러 번 읽었다(재분배 등)
    expect(snap.meta.sources[0].file!.sha256).toBe(sha256(orig));
    expect(snap.text).toContain('카드 스냅샷 시험 줄');
    expect(snap.text).not.toContain('다른 내용');
    expect(verifyCardSnapshot(snap.meta, snap.bytes)).toEqual([`docs/HANDOFF.md: source bytes differ since the card was made`]);
  });
});

describe('C1 card snapshot — negative tests with positive controls', () => {
  function made() {
    const w = project();
    const snap = renderCardSnapshot(w.proj, { maxChars: 3200, git: false })!;
    return { w, snap };
  }

  it('1-byte change in the card file → mismatch (unchanged → ok)', () => {
    const { snap } = made();
    expect(verifyCardSnapshot(snap.meta, snap.bytes)).toEqual([]);
    const b = Buffer.from(snap.bytes); b[b.length - 1] ^= 1;
    expect(verifyCardSnapshot(snap.meta, b).some(x => x.startsWith('card bytes differ'))).toBe(true);
  });

  it('1-byte change in a source or the config → mismatch', () => {
    const { w, snap } = made();
    const hf = path.join(w.proj, 'docs', 'HANDOFF.md');
    const b = fs.readFileSync(hf); b[b.length - 2] ^= 1; fs.writeFileSync(hf, b);
    expect(verifyCardSnapshot(snap.meta, snap.bytes)).toEqual(['docs/HANDOFF.md: source bytes differ since the card was made']);
    const cf = path.join(w.proj, '.claude', 'passbaton.config.json');
    fs.appendFileSync(cf, ' ');
    expect(verifyCardSnapshot(snap.meta, snap.bytes)).toContain('config bytes differ');
  });

  it('working-copy change under the same git HEAD → different sha256, git state modified; untracked → identified by bytes', () => {
    const w = project();
    git(w.proj, 'init', '-q'); git(w.proj, 'add', '-A'); git(w.proj, 'commit', '-qm', 'base');
    const a = renderCardSnapshot(w.proj, { maxChars: 3200 })!.meta;
    expect(a.sources[1].git).toMatchObject({ state: 'clean' });          // 양성
    const hf = path.join(w.proj, 'docs', 'HANDOFF.md');
    const b0 = fs.readFileSync(hf); b0[5] ^= 1; fs.writeFileSync(hf, b0);
    fs.writeFileSync(path.join(w.proj, 'docs', 'MISSING.md'), '# 새 파일\n- 비추적\n');
    const b = renderCardSnapshot(w.proj, { maxChars: 3200 })!.meta;
    expect(b.git!.head).toBe(a.git!.head);
    expect(b.sources[1].file!.sha256).not.toBe(a.sources[1].file!.sha256);
    expect(b.sources[1].git).toMatchObject({ state: 'modified' });
    expect(b.sources[2].file!.sha256).toBe(sha256('# 새 파일\n- 비추적\n'));
    expect(b.sources[2].git).toMatchObject({ state: 'not-in-head', headBlob: null });
    // 저장된 a 카드는 같은 HEAD 인데도 불일치로 드러난다
    expect(verifyCardSnapshot(a, renderCardSnapshot(w.proj, { maxChars: 3200 })!.bytes).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!built)('C1 card CLI — verify', () => {
  it('--verify: ok for the untouched snapshot, mismatch after a 1-byte card edit', () => {
    const w = project();
    const card = path.join(w.out, 'card.md'), meta = path.join(w.out, 'card.meta.json');
    expect(cli(w, ['--project-dir', w.proj, '--out', card, '--meta', meta]).code).toBe(0);
    expect(readMeta(meta).card.path).toBe(card);
    const ok = cli(w, ['--verify', meta]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('CARD-VERIFY ok');
    const b = fs.readFileSync(card); b[0] ^= 1; fs.writeFileSync(card, b);
    const bad = cli(w, ['--verify', meta]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('card bytes differ');
  });
});
