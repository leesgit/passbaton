#!/usr/bin/env node
// PB154-M1 — 같은 고정 입력에서 전체 카드 vs loop 최소 카드 비교 (Astra reply-154 §2 M1 · §3 · §4 M0·M1 행)
//
// 사용: npm run build && node scripts/m1-card-compare.mjs <fixture-dir> [--runs N]
//   <fixture-dir>/manifest.json 의 sha256 와 사본이 하나라도 다르면 「비교 무효」 로 끝낸다(결과를 내지 않는다).
//   사본은 레포에 넣지 않는다(다른 프로젝트의 원문이다) — 해시만 docs/ 결과 문서에 남긴다.
//
// 재는 것: 카드·SessionStart 주입의 문자 수·줄 수(⛔ 토큰으로 환산하지 않는다) · 정보 보존(정지 원천 상태 · 처분 색인 행 ·
//   현재 작업 경고 · 각 원천의 경로·sha1) · 실행 시간(중앙값) · 변형 입력(DEMO_STOP 생김 · 작업 절 소실 · 활성 처분 추가)에서
//   변화가 최소 카드에 보이는지.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist');
const { buildResumeCard } = await import(new URL(`file:///${path.join(DIST, 'utils/resume-card.js').replace(/\\/g, '/')}`).href);
const SESSION_START = path.join(DIST, 'hooks/session-start.js');

const FIX = process.argv[2];
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 30;
if (!FIX) { console.error('usage: node scripts/m1-card-compare.mjs <fixture-dir> [--runs N]'); process.exit(2); }

const sha256 = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf-8'));
function verify() {
  const bad = Object.entries(manifest.sha256).filter(([rel, h]) => !fs.existsSync(path.join(FIX, rel)) || sha256(path.join(FIX, rel)) !== h).map(([rel]) => rel);
  return bad;
}
const before = verify();
if (before.length) {
  console.log(JSON.stringify({ verdict: 'INVALID — fixture hash mismatch (비교 무효)', mismatched: before }, null, 2));
  process.exit(3);
}

const PROJ_REL = 'ws/apps/kenshi-fantasy';
const BUDGET = 3200;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const lines = t => t.split(/\r?\n/).length;

/** 고정 사본을 임시 폴더로 복사하고 변형을 적용한다 — 사본 자체는 건드리지 않는다 */
function variant(name, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pb-m1-${name}-`));
  fs.cpSync(path.join(FIX, 'ws'), path.join(dir, 'ws'), { recursive: true });
  const proj = path.join(dir, 'ws', 'apps', 'kenshi-fantasy');
  mutate?.(proj);
  return { dir, ws: path.join(dir, 'ws'), proj };
}

const indexRows = t => t.split(/\r?\n/).filter(l => /^\|/.test(l) && !/^\|[-|\s:]+\|$/.test(l));

function compare(name, mutate) {
  const v = variant(name, mutate);
  const full = buildResumeCard(v.proj, BUDGET, { origin: 'unknown' });
  const min = buildResumeCard(v.proj, BUDGET, { origin: 'loop' });
  const okItems = full.items.filter(i => i.outcome === 'ok');
  const idxFull = full.items.find(i => i.path === 'docs/astra/INDEX.md');
  const idxMin = min.items.find(i => i.path === 'docs/astra/INDEX.md');
  const stopFull = full.items.find(i => i.path === '.ralph/DEMO_STOP');
  const stopMin = min.items.find(i => i.path === '.ralph/DEMO_STOP');
  const rowsFull = indexRows(idxFull?.excerpt ?? '');
  const res = {
    variant: name,
    full: { chars: full.text.length, lines: lines(full.text), taskStatus: full.taskStatus, firstLine: full.text.split(/\r?\n/)[0].slice(0, 100) },
    minimal: { chars: min.text.length, lines: lines(min.text), taskStatus: min.taskStatus, firstLine: min.text.split(/\r?\n/)[0].slice(0, 100), applied: min.minimal === true },
    preserved: {
      stopStatusSame: stopFull?.outcome === stopMin?.outcome && (stopFull?.outcome !== 'ok' || min.text.includes((stopFull.excerpt ?? '').replace(/…$/, ''))),
      indexRowsFull: rowsFull.length,
      indexRowsInMinimal: rowsFull.filter(r => min.text.includes(r.replace(/…$/, ''))).length,
      indexRowsMinimalTotal: indexRows(idxMin?.excerpt ?? '').length,
      taskWarningSame: full.taskStatus === min.taskStatus && (full.text.split(/\r?\n/)[0] === min.text.split(/\r?\n/)[0] || !/^(⚠|ℹ)/.test(full.text)),
      everyOkSourcePathAndSha: okItems.every(i => min.text.includes(`\`${i.path}:${i.from}-${i.to}\``) && min.text.includes(`sha1 ${i.sha}`)),
      notReadLinesSame: full.items.filter(i => i.outcome !== 'ok').every(i => min.text.includes(`\`${i.path}\` · ⚠ NOT READ`)),
    },
    bodiesOmitted: min.text.split(/\r?\n/).filter(l => l.includes('body omitted (loop card)')).map(l => (/`([^`:]+):\d+-\d+`/.exec(l) ?? [])[1]),
  };
  // 시간: 같은 프로세스 안 buildResumeCard 반복(원천을 매번 다시 읽는다)
  const tf = [], tm = [];
  for (let k = 0; k < RUNS; k++) {
    let t = performance.now(); buildResumeCard(v.proj, BUDGET, { origin: 'unknown' }); tf.push(performance.now() - t);
    t = performance.now(); buildResumeCard(v.proj, BUDGET, { origin: 'loop' }); tm.push(performance.now() - t);
  }
  res.timeMs = { runs: RUNS, fullMedian: +median(tf).toFixed(2), minimalMedian: +median(tm).toFixed(2) };
  res._cards = { full: full.text, minimal: min.text };
  fs.rmSync(v.dir, { recursive: true, force: true });
  return res;
}

/** 훅 경로 전체 — SessionStart 주입 전체(카드 + DB 요약). 실행마다 깨끗한 DB 사본(SessionStart 가 정리 질의를 돌린다). */
function hookRun(role) {
  const v = variant(`hook-${role ?? 'unset'}`);
  const out = [], times = [];
  const n = Math.max(3, Math.min(9, Math.floor(RUNS / 5)));
  for (let k = 0; k < n; k++) {
    fs.mkdirSync(path.join(v.ws, '.claude'), { recursive: true });
    fs.copyFileSync(path.join(FIX, 'sessions.pristine.db'), path.join(v.ws, '.claude', 'sessions.db'));
    for (const f of ['sessions.db-wal', 'sessions.db-shm']) fs.rmSync(path.join(v.ws, '.claude', f), { force: true });
    const env = { ...process.env, WORKSPACE_ROOT: v.ws };
    delete env.PASSBATON_ROLE;
    if (role) env.PASSBATON_ROLE = role;
    const t = performance.now();
    const r = spawnSync(process.execPath, [SESSION_START], { input: JSON.stringify({ cwd: v.proj, session_id: 'm1', source: 'startup' }), encoding: 'utf-8', env });
    times.push(performance.now() - t);
    if (r.status !== 0) throw new Error(`session-start failed: ${r.stderr}`);
    out.push(r.stdout);
  }
  fs.rmSync(v.dir, { recursive: true, force: true });
  const text = out[0];
  return {
    role: role ?? '(unset)', runs: n, chars: text.length, lines: lines(text),
    sameOutputEveryRun: out.every(o => o === text),
    hasRecentSessions: text.includes('## Recent Sessions'),
    hasLoopMinimalHeader: text.includes('loop minimal'),
    wallMsMedian: +median(times).toFixed(1),
    _text: text,
  };
}

const variants = [
  compare('as-is'),
  compare('demo-stop-present', p => fs.writeFileSync(path.join(p, '.ralph/DEMO_STOP'), 'STOP — M1 변형: 사람 확인 대기 (H-152)\n')),
  compare('task-block-missing', p => {
    const f = path.join(p, '.ralph/fix_plan.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace(/^(#+\s.*)지금 할 일/m, '$1지금 할-일(M1 변형으로 지움)'));
  }),
  compare('index-row-added', p => {
    const f = path.join(p, 'docs/astra/INDEX.md');
    const t = fs.readFileSync(f, 'utf-8');
    const nl = t.includes('\r\n') ? '\r\n' : '\n';
    const ls = t.split(/\r?\n/);
    const h = ls.findIndex(l => /^#+\s.*활성 처분/.test(l));
    const sep = ls.findIndex((l, i) => i > h && /^\|[-|\s:]+\|$/.test(l));
    ls.splice(sep + 1, 0, '| M1-ROW | M1 변형 — 맨 앞에 끼운 활성 처분 | 테스트 | 테스트 | 테스트 | 테스트 | 테스트 | 테스트 |');
    fs.writeFileSync(f, ls.join(nl));
  }),
];
// 변형이 최소 카드에서 보이는가
const vis = {
  demoStopVisible: variants[1]._cards.minimal.includes('STOP — M1 변형'),
  taskWarningVisible: /^⚠ CURRENT TASK UNKNOWN/.test(variants[2]._cards.minimal),
  indexRowVisible: variants[3]._cards.minimal.includes('| M1-ROW |'),
};
const hooks = [hookRun(undefined), hookRun('loop')];
const after = verify();

const outDir = path.join(FIX, 'm1-out');
fs.mkdirSync(outDir, { recursive: true });
for (const v of variants) {
  fs.writeFileSync(path.join(outDir, `${v.variant}.full.txt`), v._cards.full);
  fs.writeFileSync(path.join(outDir, `${v.variant}.minimal.txt`), v._cards.minimal);
  delete v._cards;
}
for (const h of hooks) { fs.writeFileSync(path.join(outDir, `hook-${h.role.replace(/[()]/g, '')}.txt`), h._text); delete h._text; }

console.log(JSON.stringify({
  verdict: after.length ? 'INVALID — fixture changed during the run (비교 무효)' : 'valid',
  node: process.version, budget: BUDGET, manifestMade: manifest.made, fixtureSha256: manifest.sha256,
  variants, changesVisibleInMinimal: vis, hooks,
}, null, 2));
