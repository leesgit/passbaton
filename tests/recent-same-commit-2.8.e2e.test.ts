// PB195-500 ② (원장 L-49 · fb1025 P3) — 같은 커밋을 말하는 서로 다른 세션의 기록은 보존한다
//
// 원문: Recent Sessions 세 줄 — 「토끼·여우가 서 있을 때 튀던 원인을 찾아 고쳤습니다(06e2fc6)」(대화 세션) /
//       「N191-100을 끝내고 커밋했습니다(06e2fc6) …」(랄프 루프) / 「랄프가 첫 단계를 마쳤습니다(ddc048d) …」.
// 판단(reply-195 §2 · R-59 · L-45): 같은 커밋 ≠ 같은 기록. 대화 요약과 루프 요약은 다른 세션의 다른 작업 기록이다 →
//   합치거나 지우지 않는다. 구분은 2.7.3 의 출처 표시(`_(via …)_` · PB165-200)와 실행 출처(`[origin unknown]` · 확인된 loop 는
//   대화 카드에서 노출만 뺌 · PB154-B)로 한다. 「진짜 중복」(같은 세션 같은 턴)은 Stop 의 턴 정체성이 이미 막는다.
//   같은 세션의 다른 턴이 같은 문구를 남긴 경우를 줄이는 것은 L-45 보류 그대로(같은 문구 ≠ 같은 의미).

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { migrateSchema } from '../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const built = fs.existsSync(SESSION_START);
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const CONV = '토끼·여우가 서 있을 때 튀던 원인을 찾아 고쳤습니다(06e2fc6)';
const RALPH = 'N191-100을 끝내고 커밋했습니다(06e2fc6) — 다음은 N191-200';
const LOOP = '랄프가 첫 단계를 마쳤습니다(ddc048d) — 검증 대기';

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-195r-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  const dbPath = path.join(ws, '.claude', 'sessions.db');
  const db = new Database(dbPath);
  migrateSchema(db);
  const ins = db.prepare(`INSERT INTO sessions (project, last_work, timestamp, session_id, prompt_id, run_origin, summary_source, issues)
    VALUES ('game', ?, ?, ?, ?, ?, ?, ?)`);
  const meta = (c: string) => JSON.stringify({ commits: [c] });
  ins.run(LOOP, '2026-10-25 03:00:00', 'ralph-2', 'p1', 'loop', 'commit', meta('ddc048d'));
  ins.run(RALPH, '2026-10-25 02:00:00', 'ralph-1', 'p1', null, 'commit', meta('06e2fc6 N191-100'));
  ins.run(CONV, '2026-10-25 01:00:00', 'conv-1', 'p7', null, 'assistant-text', meta('06e2fc6 N191-100'));
  db.close();
  return { ws, proj, dbPath };
}
function start(ws: string, proj: string, role?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws };
  delete env.PASSBATON_ROLE;
  if (role !== undefined) env.PASSBATON_ROLE = role;
  const r = spawnSync('node', [SESSION_START], { input: JSON.stringify({ cwd: proj, session_id: 'S', source: 'startup' }), encoding: 'utf-8', env });
  expect(r.status, r.stderr?.slice(0, 300)).toBe(0);
  return r.stdout;
}
const recent = (out: string) => {
  const lines = out.split(/\r?\n/);
  const i = lines.indexOf('## Recent Sessions');
  if (i < 0) return [];
  const rest = lines.slice(i + 1);
  const end = rest.findIndex(l => !l.startsWith('- ') && !l.startsWith('  '));
  return (end < 0 ? rest : rest.slice(0, end)).filter(l => l.startsWith('- '));
};

describe.skipIf(!built)('PB195-500 ② L-49 같은 커밋 · 다른 세션 = 둘 다 보존', () => {
  it('대화 카드: 같은 커밋(06e2fc6)의 대화 요약·루프 요약 두 줄이 모두 나오고 출처 표시로 갈린다', () => {
    const { ws, proj } = workspace();
    const r = recent(start(ws, proj));
    const conv = r.find(l => l.includes(CONV));
    const ralph = r.find(l => l.includes(RALPH));
    expect(conv, r.join('\n')).toBeTruthy();
    expect(ralph, r.join('\n')).toBeTruthy();
    expect(conv).toContain('_(via assistant text)_');
    expect(ralph).toContain('_(via commit message)_');
    expect(conv).toContain('[origin unknown]');
    expect(ralph).toContain('[origin unknown]');
    // 확인된 loop 행은 대화 카드에서 노출만 빠진다(PB154-B) — 같은 커밋 규칙과 무관
    expect(r.some(l => l.includes(LOOP))).toBe(false);
  });

  it('루프 카드: 세 기록 모두 · DB 행 3 그대로(합치거나 지우지 않음)', () => {
    const { ws, proj, dbPath } = workspace();
    const r = recent(start(ws, proj, 'loop'));
    for (const w of [CONV, RALPH, LOOP]) expect(r.some(l => l.includes(w)), w).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project = 'game'").get() as { n: number }).n).toBe(3);
    db.close();
  });
});
