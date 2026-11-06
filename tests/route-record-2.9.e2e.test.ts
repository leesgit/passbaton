// P4-200 (Astra P4 reply-4) — opt-in: routed turns are recorded under the routed project, segment by segment
//
// Why: in the real monorepo, 30 of 85 root rows since 10-23 came from `/ashfall`-routed sessions and the
// root SessionStart card showed only Ashfall work. 2.7–2.8 recorded every routed turn under the root by design.
//
// The verdict uses an independent expectation table: each segment (root → A → B → root) gets a unique fact
// in its own last answer, and the root segment also has a commit and an answer inside the same transcript.
// A row must carry only its own segment's fact. False-green guards:
//   - "everything stays root" passes M2 trivially → the positive cases require rows under game-a / game-b
//   - "summary from the whole transcript" → the A turn with an empty answer must be "(결과 요약 없음)", not ROOT text,
//     and A rows must not carry the root segment's commit
//   - without `record: "target"` everything stays under the root (default unchanged)
//   - a re-fired Stop (same prompt_id) is not stored twice

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

type Routing = { commands: Record<string, string>; record?: string };
const ROUTES = { '/ga': 'apps/game-a', '/gb': 'apps/game-b', '/home': '.' };

function workspace(routing: Routing) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-29rr-')));
  roots.push(ws);
  for (const name of ['game-a', 'game-b']) {
    const proj = path.join(ws, 'apps', name);
    fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), `# 최신\n- ${name} 카드\n`);
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }] } }));
  }
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ routing }));
  return { ws, root: path.basename(ws), dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function hook(file: string, ws: string, payload: Record<string, unknown>): string {
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

/** One growing transcript per session — like the host writes it. */
class Convo {
  lines: unknown[] = [];
  n = 0;
  constructor(readonly ws: string, readonly sid: string) {}
  get file() { return path.join(this.ws, `${this.sid}.jsonl`); }
  /** prompt → UPS hook → transcript gets user + assistant (+ optional commit tool_use) → Stop hook */
  turn(prompt: string, answer: string, opts: { commit?: string; refire?: boolean } = {}) {
    const pid = `${this.sid}-p${++this.n}`;
    hook(USER_PROMPT, this.ws, { cwd: this.ws, session_id: this.sid, prompt_id: pid, prompt });
    this.lines.push({ uuid: `${pid}-u`, type: 'user', message: { role: 'user', content: prompt } });
    const content: unknown[] = [];
    if (opts.commit) content.push({ type: 'tool_use', id: `${pid}-t`, name: 'Bash', input: { command: `git commit -m "${opts.commit}"` } });
    content.push({ type: 'text', text: answer });
    this.lines.push({ uuid: `${pid}-a`, type: 'assistant', message: { role: 'assistant', content } });
    fs.writeFileSync(this.file, this.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const stop = { cwd: this.ws, session_id: this.sid, prompt_id: pid, transcript_path: this.file, last_assistant_message: answer };
    hook(SESSION_END, this.ws, stop);
    if (opts.refire) {
      for (const f of fs.readdirSync(path.join(this.ws, '.claude'))) if (f.startsWith('.session-end-')) fs.rmSync(path.join(this.ws, '.claude', f));
      hook(SESSION_END, this.ws, stop);
    }
    return pid;
  }
}

type Row = { project: string; prompt_id: string; last_work: string; issues: string | null; routed_from: string | null };
const allRows = (dbPath: string): Row[] => {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare('SELECT project, prompt_id, last_work, issues, routed_from FROM sessions ORDER BY id').all() as Row[];
  db.close();
  return r;
};

const ROOT_FACT = 'ROOT-FACT 루트 문서 정리를 끝냈고 명령 목록을 고쳤습니다.';
const A_FACT = 'GAMEA-FACT 게임 A 의 첫 실행 게이트를 만들어 통과시켰습니다.';
const B_FACT = 'GAMEB-FACT 게임 B 의 비전 문서 초안을 정리해 두었습니다.';
const BACK_FACT = 'BACK-FACT 루트로 돌아와 원장 행을 갱신했습니다.';
const ROOT_COMMIT = 'docs: ROOT-COMMIT root segment commit message';

describe.skipIf(!built)('P4-200 — routing.record = target', () => {
  it('root → /ga → (no command) → /gb → /home: each turn lands in its own segment project, with its own fact only', () => {
    const { ws, root, dbPath } = workspace({ commands: ROUTES, record: 'target' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    const p1 = c.turn('루트 일 정리', ROOT_FACT, { commit: ROOT_COMMIT });
    const p2 = c.turn('/ga 이어서', A_FACT, { refire: true });
    const p3 = c.turn('계속', '응');                         // routed, no command, answer too short to summarise
    const p4 = c.turn('/gb', B_FACT);
    const p5 = c.turn('/home', BACK_FACT);

    // independent expectation table
    const want: Record<string, { project: string; fact: string | null }> = {
      // root rows keep the existing 2.8 ladder: a commit anywhere in the transcript wins (known limit, not changed here)
      [p1]: { project: root, fact: 'ROOT-COMMIT' },
      [p2]: { project: 'game-a', fact: 'GAMEA-FACT' },
      [p3]: { project: 'game-a', fact: null },
      [p4]: { project: 'game-b', fact: 'GAMEB-FACT' },
      [p5]: { project: root, fact: 'ROOT-COMMIT' },
    };
    const rows = allRows(dbPath);
    expect(rows.map(r => r.prompt_id)).toEqual([p1, p2, p3, p4, p5]);          // re-fire of p2 not stored twice
    for (const r of rows) {
      const w = want[r.prompt_id];
      expect(r.project, r.prompt_id).toBe(w.project);
      const others = ['ROOT-FACT', 'GAMEA-FACT', 'GAMEB-FACT', 'BACK-FACT', 'ROOT-COMMIT'].filter(f => f !== w.fact);
      for (const f of others) {
        if (w.project === root && (f === 'ROOT-FACT' || f === 'BACK-FACT')) continue;   // root segment's own texts
        expect(`${r.last_work} ${r.issues ?? ''}`, `${r.prompt_id} must not carry ${f}`).not.toContain(f);
      }
      if (w.fact) expect(r.last_work, r.prompt_id).toContain(w.fact);
    }
    expect(rows.find(r => r.prompt_id === p3)!.last_work).toBe('(결과 요약 없음)');
    // provenance on routed rows only
    const ra = JSON.parse(rows.find(r => r.prompt_id === p2)!.routed_from!);
    expect(ra).toMatchObject({ root, via: '/ga', target: 'apps/game-a', session: 's1', turn: p2 });
    expect(rows.find(r => r.prompt_id === p1)!.routed_from).toBeNull();
    expect(rows.find(r => r.prompt_id === p5)!.routed_from).toBeNull();
  });

  it('State and Recent follow the record: the root card does not show game rows; the game card does', () => {
    const { ws, root } = workspace({ commands: ROUTES, record: 'target' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    c.turn('루트 일 정리', ROOT_FACT);
    c.turn('/ga 이어서', A_FACT);
    const rootCard = hook(SESSION_START, ws, { cwd: ws, session_id: 's2' });
    expect(rootCard).toContain('ROOT-FACT');
    expect(rootCard).not.toContain('GAMEA-FACT');
    const gameCard = hook(SESSION_START, ws, { cwd: path.join(ws, 'apps', 'game-a'), session_id: 's3' });
    expect(gameCard).toContain('GAMEA-FACT');
    expect(gameCard).not.toContain('ROOT-FACT');
    expect(root).toBeTruthy();
  });

  it('the routed banner says where turns are recorded', () => {
    const { ws } = workspace({ commands: ROUTES, record: 'target' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const out = hook(USER_PROMPT, ws, { cwd: ws, session_id: 's1', prompt: '/ga' });
    expect(out).toContain('turns from now on are recorded under game-a (routing.record = target)');
  });

  it('a route that no longer maps is not attributed to any project: root + reason', () => {
    const { ws, root, dbPath } = workspace({ commands: ROUTES, record: 'target' });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    c.turn('/ga', A_FACT);
    // the next prompt's UPS clears the stale route; simulate a lost UPS by changing config *after* the UPS
    hook(USER_PROMPT, ws, { cwd: ws, session_id: 's1', prompt_id: 's1-px', prompt: '계속' });
    fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ routing: { commands: { '/gb': 'apps/game-b', '/home': '.' }, record: 'target' } }));
    hook(SESSION_END, ws, { cwd: ws, session_id: 's1', prompt_id: 's1-px', transcript_path: c.file, last_assistant_message: 'STALE-FACT 설정이 바뀐 뒤의 턴을 마쳤습니다.' });
    const r = allRows(dbPath).find(x => x.prompt_id === 's1-px')!;
    expect(r.project).toBe(root);
    expect(JSON.parse(r.routed_from!)).toMatchObject({ root, unattributed: '/ga no longer maps to apps/game-a' });
  });

  it('two routed folders with the same project name are not attributed', () => {
    const { ws, root, dbPath } = workspace({ commands: { '/ga': 'apps/game-a', '/dup': 'tools/game-a', '/home': '.' }, record: 'target' });
    fs.mkdirSync(path.join(ws, 'tools', 'game-a'), { recursive: true });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    const p = c.turn('/ga', A_FACT);
    const r = allRows(dbPath).find(x => x.prompt_id === p)!;
    expect(r.project).toBe(root);
    expect(JSON.parse(r.routed_from!).unattributed).toContain('share the name game-a');
  });
});

describe.skipIf(!built)('P4-200 — default (no routing.record) is unchanged', () => {
  it('every routed turn stays under the root, routed_from stays NULL, banner unchanged', () => {
    const { ws, root, dbPath } = workspace({ commands: ROUTES });
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    const c = new Convo(ws, 's1');
    c.turn('루트 일 정리', ROOT_FACT);
    c.turn('/ga 이어서', A_FACT);
    c.turn('/gb', B_FACT);
    const rows = allRows(dbPath);
    expect(rows.map(r => r.project)).toEqual([root, root, root]);
    expect(rows.every(r => r.routed_from === null)).toBe(true);
    const out = hook(USER_PROMPT, ws, { cwd: ws, session_id: 's9', prompt: '/ga' });
    expect(out).toContain(`still recorded under ${root}`);
  });

  it('an unknown record value is ignored (root) and reported as invalid', async () => {
    const { ws } = workspace({ commands: ROUTES, record: 'everywhere' });
    const { readRoutingDeclaration } = await import('../src/utils/routing.js');
    const d = readRoutingDeclaration(ws);
    expect(d.record).toBe('root');
    expect(d.invalid).toContain('record');
  });
});
