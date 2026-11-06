// P5-03 (Astra P5 reply-5 C9) — routing checks the 2.9 suites did not pin, run against the built hooks
//
// The same file is also run with ../dist pointing at an installed copy, so it only spawns dist hooks
// (no ../src imports). Each case has a false-green guard:
//   - role: a loop turn and a conversation turn in the same routed project must differ in run_origin;
//     a wrong-case value ("Loop") must not count as loop
//   - sibling paths: apps/game-a and apps/game-ab must not capture each other; a folder next to the
//     workspace (same name prefix) and the home folder are outside — no routing card, no routed row
//   - previous turn: a routed B turn after a routed A turn with a commit must carry neither A's fact nor A's commit
//   - existing rows: switching record to "target" later leaves rows already stored byte-for-byte unchanged

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const built = [SESSION_START, USER_PROMPT, SESSION_END].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const ROUTES = { '/ga': 'apps/game-a', '/gab': 'apps/game-ab', '/gb': 'apps/game-b', '/home': '.' };
const PROJECTS = ['game-a', 'game-ab', 'game-b'];

function tmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(d);
  return d;
}

function workspace(routing: { commands: Record<string, string>; record?: string }) {
  const ws = tmpDir('pb-210rc-');
  for (const name of PROJECTS) {
    const proj = path.join(ws, 'apps', name);
    fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), `# 최신\n- ${name} 카드\n`);
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }] } }));
  }
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  const setRouting = (r: typeof routing) =>
    fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ routing: r }));
  setRouting(routing);
  return { ws, root: path.basename(ws), dbPath: path.join(ws, '.claude', 'sessions.db'), setRouting };
}

function hook(file: string, ws: string, payload: Record<string, unknown>, extra: NodeJS.ProcessEnv = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws, ...extra };
  if (!('PASSBATON_ROLE' in extra)) delete env.PASSBATON_ROLE;
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

class Convo {
  lines: unknown[] = [];
  n = 0;
  constructor(readonly ws: string, readonly sid: string, readonly cwd = ws, readonly env: NodeJS.ProcessEnv = {}) {}
  get file() { return path.join(this.ws, `${this.sid}.jsonl`); }
  turn(prompt: string, answer: string, opts: { commit?: string } = {}) {
    const pid = `${this.sid}-p${++this.n}`;
    const ups = hook(USER_PROMPT, this.ws, { cwd: this.cwd, session_id: this.sid, prompt_id: pid, prompt }, this.env);
    this.lines.push({ uuid: `${pid}-u`, type: 'user', message: { role: 'user', content: prompt } });
    const content: unknown[] = [];
    if (opts.commit) content.push({ type: 'tool_use', id: `${pid}-t`, name: 'Bash', input: { command: `git commit -m "${opts.commit}"` } });
    content.push({ type: 'text', text: answer });
    this.lines.push({ uuid: `${pid}-a`, type: 'assistant', message: { role: 'assistant', content } });
    fs.writeFileSync(this.file, this.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    hook(SESSION_END, this.ws, { cwd: this.cwd, session_id: this.sid, prompt_id: pid, transcript_path: this.file, last_assistant_message: answer }, this.env);
    return { pid, ups };
  }
}

type Row = Record<string, unknown> & { project: string; prompt_id: string; last_work: string; issues: string | null; routed_from: string | null; run_origin: string | null };
const allRows = (dbPath: string): Row[] => {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[];
  db.close();
  return r;
};
const byPid = (rows: Row[], pid: string) => rows.find(r => r.prompt_id === pid)!;

const A_FACT = 'GAMEA-FACT 게임 A 의 저장 시험을 고쳐 통과시켰습니다.';
const AB_FACT = 'GAMEAB-FACT 게임 AB 의 지도 생성기를 정리했습니다.';
const B_FACT = 'GAMEB-FACT 게임 B 의 입력 처리를 바꿨습니다.';
const LOOP_FACT = 'LOOPA-FACT 루프가 게임 A 의 판독기를 고쳤습니다.';
const A_COMMIT = 'fix: GA-COMMIT game-a segment commit';

describe.skipIf(!built)('P5-03 — routing.record = target, role', () => {
  it('a loop turn and a conversation turn in the same routed project keep their own run_origin', () => {
    const { ws, dbPath } = workspace({ commands: ROUTES, record: 'target' });
    const chat = new Convo(ws, 'c1');
    const loop = new Convo(ws, 'l1', ws, { PASSBATON_ROLE: 'loop' });
    const wrong = new Convo(ws, 'w1', ws, { PASSBATON_ROLE: 'Loop' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 'c1' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 'l1' }, { PASSBATON_ROLE: 'loop' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 'w1' }, { PASSBATON_ROLE: 'Loop' });
    const pc = chat.turn('/ga', A_FACT).pid;
    const pl = loop.turn('/ga', LOOP_FACT).pid;
    const pw = wrong.turn('/ga', A_FACT).pid;
    const rows = allRows(dbPath);
    for (const p of [pc, pl, pw]) expect(byPid(rows, p).project, p).toBe('game-a');
    expect(byPid(rows, pl).run_origin).toBe('loop');
    expect(byPid(rows, pc).run_origin).not.toBe('loop');
    expect(byPid(rows, pw).run_origin).not.toBe('loop');
    expect(byPid(rows, pc).last_work).not.toContain('LOOPA-FACT');
    expect(JSON.parse(byPid(rows, pl).routed_from!)).toMatchObject({ via: '/ga', target: 'apps/game-a', session: 'l1', turn: pl });
  });
});

describe.skipIf(!built)('P5-03 — routing.record = target, paths', () => {
  it('apps/game-a and apps/game-ab do not capture each other (three projects)', () => {
    const { ws, dbPath } = workspace({ commands: ROUTES, record: 'target' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    const p1 = c.turn('/gab', AB_FACT).pid;
    const p2 = c.turn('/ga', A_FACT).pid;
    const p3 = c.turn('/gb', B_FACT).pid;
    const rows = allRows(dbPath);
    expect([p1, p2, p3].map(p => byPid(rows, p).project)).toEqual(['game-ab', 'game-a', 'game-b']);
    expect(byPid(rows, p1).last_work).toContain('GAMEAB-FACT');
    expect(byPid(rows, p2).last_work).not.toContain('GAMEAB-FACT');
    expect(byPid(rows, p1).last_work).not.toContain('GAMEA-FACT ');
  });

  it('a folder next to the workspace with the same name prefix is outside: no card, no routed row', () => {
    const { ws, dbPath } = workspace({ commands: ROUTES, record: 'target' });
    const sib = `${ws}-sib`;
    fs.mkdirSync(path.join(sib, 'apps', 'game-a'), { recursive: true });
    roots.push(sib);
    // the DB must exist first — otherwise routing returns early on "no DB" and the path check is never reached
    hook(SESSION_START, ws, { cwd: ws, session_id: 'boot' });
    expect(fs.existsSync(dbPath)).toBe(true);
    const c = new Convo(ws, 'x1', sib);
    const { pid, ups } = c.turn('/ga', A_FACT);
    expect(ups).not.toContain('game-a 카드');
    const rows = allRows(dbPath).filter(r => r.prompt_id === pid);
    for (const r of rows) {
      expect(r.project).not.toBe('game-a');
      expect(r.routed_from).toBeNull();
    }
    const ok = new Convo(ws, 'x2').turn('/ga', A_FACT);
    expect(ok.ups).toContain('game-a 카드');
    expect(byPid(allRows(dbPath), ok.pid).project).toBe('game-a');
  });

  it('the home folder is outside: no card, no routed row, no ~/.claude/sessions.db', () => {
    const { ws, dbPath } = workspace({ commands: ROUTES, record: 'target' });
    const home = tmpDir('pb-210home-');
    const env = { HOME: home, USERPROFILE: home };
    hook(SESSION_START, ws, { cwd: ws, session_id: 'boot' }, env);
    expect(fs.existsSync(dbPath)).toBe(true);
    const c = new Convo(ws, 'h1', home, env);
    const { pid, ups } = c.turn('/ga', A_FACT);
    expect(ups).not.toContain('game-a 카드');
    for (const r of allRows(dbPath).filter(x => x.prompt_id === pid)) {
      expect(r.project).not.toBe('game-a');
      expect(r.routed_from).toBeNull();
    }
    expect(fs.existsSync(path.join(home, '.claude', 'sessions.db'))).toBe(false);
    // positive control: the same prompt from the workspace root does route
    const ok = new Convo(ws, 'h2', ws, env).turn('/ga', A_FACT);
    expect(ok.ups).toContain('game-a 카드');
    expect(byPid(allRows(dbPath), ok.pid).project).toBe('game-a');
  });
});

describe.skipIf(!built)('P5-03 — routing.record = target, segments', () => {
  it('a routed B turn after a routed A turn with a commit carries neither A fact nor A commit', () => {
    const { ws, dbPath } = workspace({ commands: ROUTES, record: 'target' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    const pa = c.turn('/ga', A_FACT, { commit: A_COMMIT }).pid;
    const pb = c.turn('/gb', '응').pid;
    const rows = allRows(dbPath);
    expect(byPid(rows, pa).project).toBe('game-a');
    const b = byPid(rows, pb);
    expect(b.project).toBe('game-b');
    expect(`${b.last_work} ${b.issues ?? ''}`).not.toContain('GAMEA-FACT');
    expect(`${b.last_work} ${b.issues ?? ''}`).not.toContain('GA-COMMIT');
    expect(b.last_work).toBe('(결과 요약 없음)');
  });

  it('turning record = "target" on later leaves the rows already stored unchanged', () => {
    const { ws, root, dbPath, setRouting } = workspace({ commands: ROUTES });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    c.turn('루트 일', 'ROOT-FACT 루트 문서를 정리했습니다.');
    c.turn('/ga', A_FACT);
    const before = JSON.stringify(allRows(dbPath));
    expect(JSON.parse(before).map((r: Row) => r.project)).toEqual([root, root]);
    setRouting({ commands: ROUTES, record: 'target' });
    const p3 = c.turn('/ga', 'GAMEA2-FACT 게임 A 의 두 번째 일을 마쳤습니다.').pid;
    const after = allRows(dbPath);
    expect(JSON.stringify(after.slice(0, 2))).toBe(before);
    expect(byPid(after, p3).project).toBe('game-a');
  });
});
