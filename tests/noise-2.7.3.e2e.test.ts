// 2.7.3 — 의미를 잃지 않는 잡음 감소 (Astra reply-165 PB165-300)
//
// 계약: Recent 의 files 줄 — 관측 0 인 **정상 완전 검사**만 짧게(검사 범위·경계·선언/유효 수는 남김) ·
// 미기록·부분 검사(checked < roots · 못 본 곳)·경계 없음·선언 오류·무효 선언은 지금의 긴 꼴 그대로 ·
// `Solutions: N recorded` 통계 줄은 재개 카드가 실제로 전달된(anyRead) 비-loop 출력에서만 뺀다 · 오류 때 해법 주입은 그대로.
// 역검증(reply-165 §1 300): 부분 검사를 정상 0 으로 보이면 빨강 · 오류 해법 주입까지 끄면 빨강.

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
const POST_TOOL = path.resolve(here, '../dist/hooks/post-tool-use.js');
const built = [SESSION_START, POST_TOOL].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

type Ws = { boundary?: string; roots?: number; checked?: number; uncovered?: string[]; declared?: number; valid?: number; declStatus?: string; artifacts?: { problems?: string[] } };

function workspace(coverage: { workspace: Ws } | null, opts: { solutions?: number } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-165n-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  const dbPath = path.join(ws, '.claude', 'sessions.db');
  const db = new Database(dbPath);
  migrateSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS solutions (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, error_signature TEXT NOT NULL,
    error_message TEXT, solution TEXT NOT NULL, related_files TEXT, keywords TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare("INSERT INTO sessions (project, last_work, timestamp, user_intent, modified_files, file_coverage) VALUES ('game', ?, ?, ?, '[]', ?)")
    .run('문서만 읽고 아무 파일도 고치지 않았다 — 지도 조사', '2026-10-24 01:00:00', '지도 문서 읽어줘', coverage ? JSON.stringify(coverage) : null);
  const sol = db.prepare("INSERT INTO solutions (project, error_signature, solution) VALUES ('game', ?, ?)");
  for (let i = 0; i < (opts.solutions ?? 0); i++) {
    sol.run(`Cannot find module shader-cache-${i}`, `셰이더 캐시 모듈 경로를 tsconfig paths 에 추가했다 (${i})`);
  }
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
const filesLine = (out: string) => out.split(/\r?\n/).filter(l => l.startsWith('  files') || l.startsWith('  coverage'));
const card = (proj: string, sources: unknown[], files: Record<string, string> = {}) => {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
    fs.writeFileSync(path.join(proj, rel), body);
  }
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources } }));
};

const NORMAL: Ws = { boundary: 'turn_start', roots: 1, checked: 1, uncovered: [], declared: 1, valid: 1 };
const LONG = /^ {2}files: no qualifying observations within checked scope \(/;

describe.skipIf(!built)('PB165-300 files 줄 — 정상 완전 검사의 관측 0 만 짧게', () => {
  it('정상 완전 검사 → 짧은 꼴 · 범위·경계·선언/유효 수 보존', () => {
    const { ws, proj } = workspace({ workspace: NORMAL });
    expect(filesLine(start(ws, proj))).toEqual(['  files: 0 obs in checked scope · 1/1 roots · boundary=turn_start · declared 1 (valid 1)']);
  });

  it('선언 칸이 없는 행(2.7 이전 커버리지)도 정상이면 짧게 — 없는 수를 지어내지 않는다', () => {
    const { ws, proj } = workspace({ workspace: { boundary: 'turn_start', roots: 2, checked: 2, uncovered: [] } });
    expect(filesLine(start(ws, proj))).toEqual(['  files: 0 obs in checked scope · 2/2 roots · boundary=turn_start']);
  });

  const notNormal: Array<[string, Ws, RegExp]> = [
    ['부분 검사(checked < roots)', { ...NORMAL, roots: 2, checked: 1, uncovered: ['b: not_a_worktree'] }, /\(1\/2 roots, boundary=turn_start, declared 1 \(valid 1\), skipped: b: not_a_worktree\)$/],
    ['다 셌지만 못 본 곳(잘림·HEAD 기준선 없음)', { ...NORMAL, uncovered: ['repo: truncated'] }, /\(1\/1 roots, boundary=turn_start, declared 1 \(valid 1\), skipped: repo: truncated\)$/],
    ['checked < roots 인데 이유가 비었음', { ...NORMAL, roots: 3, checked: 2 }, /\(2\/3 roots, boundary=turn_start, declared 1 \(valid 1\)\)$/],
    ['경계 없음(턴 시작 기준선 없음)', { ...NORMAL, boundary: 'none', checked: 0, uncovered: ['no turn-start baseline (UserPromptSubmit did not record this turn)'] }, /\(0\/1 roots, boundary=none, /],
    ['경계가 기록되지 않음(boundary 칸 없음)', { roots: 1, checked: 1, uncovered: [], declared: 1, valid: 1 }, /\(1\/1 roots, boundary=\?, declared 1 \(valid 1\)\)$/],
    ['볼 곳 없음(0/0 roots)', { ...NORMAL, roots: 0, checked: 0, uncovered: ['no registered worktree (not a git repository?)'] }, /\(0\/0 roots, boundary=turn_start, /],
    ['선언 파일 오류', { ...NORMAL, declStatus: 'malformed' }, /\(1\/1 roots, boundary=turn_start, root declaration malformed\)$/],
    ['무효 선언(valid < declared)', { ...NORMAL, declared: 2, valid: 1 }, /\(1\/1 roots, boundary=turn_start, declared 2 \(valid 1\)\)$/],
    ['산출물 스캔 문제', { ...NORMAL, artifacts: { problems: ['dist/**: failed'] } }, /\(1\/1 roots, boundary=turn_start, declared 1 \(valid 1\)\)$/],
  ];
  for (const [name, w, tail] of notNormal) {
    it(`${name} → 긴 꼴 그대로 · 「0 obs」 아님`, () => {
      const { ws, proj } = workspace({ workspace: w });
      const l = filesLine(start(ws, proj));
      expect(l).toHaveLength(1);
      expect(l[0]).toMatch(LONG);
      expect(l[0]).toMatch(tail);
      expect(l[0]).not.toContain('0 obs');
    });
  }

  it('미기록(커버리지 없음) → files: not recorded', () => {
    const { ws, proj } = workspace(null);
    expect(filesLine(start(ws, proj))).toEqual(['  files: not recorded']);
  });
});

describe.skipIf(!built)('PB165-300 Solutions 통계 줄 — 재개 카드가 전달된 비-loop 출력에서만 생략', () => {
  const STAT = /^Solutions: 3 recorded \(auto-injected on error\)$/m;
  const READABLE = [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }];

  it('카드 전달(anyRead) + 비-loop → 통계 줄 없음 · 카드는 있음', () => {
    const { ws, proj } = workspace({ workspace: NORMAL }, { solutions: 3 });
    card(proj, READABLE, { 'docs/HANDOFF.md': '# 최신 절\n- 다음 작업: N164-200\n' });
    const out = start(ws, proj);
    expect(out).toContain('## Resume card — repo source of truth');
    expect(out).not.toMatch(/^Solutions:/m);
  });

  it('카드 없음 → 통계 줄 그대로', () => {
    const { ws, proj } = workspace({ workspace: NORMAL }, { solutions: 3 });
    expect(start(ws, proj)).toMatch(STAT);
  });

  it('카드는 있지만 아무것도 못 읽음(anyRead=false) → 통계 줄 그대로', () => {
    const { ws, proj } = workspace({ workspace: NORMAL }, { solutions: 3 });
    card(proj, [{ path: 'docs/MISSING.md', lines: 5, label: '없음' }]);
    const out = start(ws, proj);
    expect(out).toContain('none of the declared sources could be read');
    expect(out).toMatch(STAT);
  });

  it('loop 출력 → 카드가 전달돼도 통계 줄 그대로', () => {
    const { ws, proj } = workspace({ workspace: NORMAL }, { solutions: 3 });
    card(proj, READABLE, { 'docs/HANDOFF.md': '# 최신 절\n- 다음 작업: N164-200\n' });
    expect(start(ws, proj, 'loop')).toMatch(STAT);
  });

  it('오류 때 해법 주입은 그대로 — Bash 오류 출력 → <past-solution> (카드가 있어도)', () => {
    const { ws, proj } = workspace({ workspace: NORMAL }, { solutions: 3 });
    card(proj, READABLE, { 'docs/HANDOFF.md': '# 최신 절\n' });
    const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws };
    delete env.PASSBATON_ROLE;
    const r = spawnSync('node', [POST_TOOL], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: proj, tool_result: 'Error: Cannot find module shader-cache-1\n    at load (x.js:1:1)' }),
      encoding: 'utf-8', env,
    });
    expect(r.status, r.stderr?.slice(0, 300)).toBe(0);
    expect(r.stdout).toContain('<past-solution>');
    expect(r.stdout).toContain('셰이더 캐시 모듈 경로를 tsconfig paths 에 추가했다');
  });
});
