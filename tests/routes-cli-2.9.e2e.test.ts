// P4-300 (Astra P4 reply-4) — the routing declaration as the hooks read it, checked without a DB
//
// `passbaton-card --routes` must print the same interpretation the hooks use and fail on: a missing target,
// a target outside the workspace, the same command twice (case only), two folders sharing a project name.
// Arguments after a routing command never change the target (the signal is the command name only).
// It must not create anything (no .claude/ DB, no hook trace).

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CARD = path.resolve(here, '../dist/cli-card.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const built = [CARD, USER_PROMPT, SESSION_START].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/** Raw JSON text, so duplicate-by-case keys survive into the file. */
function workspace(routingJson: string) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-29rc-')));
  roots.push(ws);
  for (const name of ['game-a', 'game-b']) {
    fs.mkdirSync(path.join(ws, 'apps', name, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'apps', name, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'apps', name, 'docs', 'HANDOFF.md'), `# 최신\n- ${name} 카드\n`);
    fs.writeFileSync(path.join(ws, 'apps', name, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }] } }));
  }
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), `{"routing": ${routingJson}}`);
  return ws;
}

const routes = (ws: string) => spawnSync('node', [CARD, '--routes', '--workspace', ws], { encoding: 'utf-8' });

describe.skipIf(!built)('P4-300 — passbaton-card --routes', () => {
  it('valid declaration: every route, the release command, record mode · exit 0 · writes nothing', () => {
    const ws = workspace('{"commands": {"/ga": "apps/game-a", "/ga-astra": "apps/game-a", "/gb": "apps/game-b", "/home": "."}, "record": "target"}');
    const before = fs.readdirSync(path.join(ws, '.claude')).sort();
    const r = routes(ws);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('record=target');
    expect(r.stdout).toContain('ROUTE /ga -> apps/game-a project=game-a');
    expect(r.stdout).toContain('ROUTE /ga-astra -> apps/game-a project=game-a');   // aliases to one target are fine
    expect(r.stdout).toContain('ROUTE /home -> . (release)');
    expect(r.stdout).toContain('ROUTES-CHECK ok');
    expect(fs.readdirSync(path.join(ws, '.claude')).sort()).toEqual(before);
  });

  it.each([
    ['missing target folder', '{"commands": {"/ga": "apps/gone", "/home": "."}}', 'INVALID /ga'],
    ['target outside the workspace', '{"commands": {"/ga": "..", "/home": "."}}', 'INVALID /ga'],
    ['same command twice (case only)', '{"commands": {"/ga": "apps/game-a", "/GA": "apps/game-b", "/home": "."}}', 'INVALID /GA'],
    ['no release command', '{"commands": {"/ga": "apps/game-a"}}', 'DISABLED'],
    ['unknown record value', '{"commands": {"/ga": "apps/game-a", "/home": "."}, "record": "both"}', 'INVALID record'],
  ])('problem: %s → exit 1', (_n, json, line) => {
    const ws = workspace(json);
    const r = routes(ws);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(line);
    expect(r.stdout).toContain('ROUTES-CHECK problems');
  });

  it('two folders sharing a project name → CLASH · exit 1', () => {
    const ws = workspace('{"commands": {"/ga": "apps/game-a", "/dup": "tools/game-a", "/home": "."}}');
    fs.mkdirSync(path.join(ws, 'tools', 'game-a'), { recursive: true });
    const r = routes(ws);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('CLASH project name game-a');
  });

  it('case-duplicated command is not routed by the hook either (same reading as the CLI)', () => {
    const ws = workspace('{"commands": {"/ga": "apps/game-a", "/GA": "apps/game-b", "/home": "."}}');
    spawnSync('node', [SESSION_START], { input: JSON.stringify({ cwd: ws, session_id: 's1' }), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
    const out = spawnSync('node', [USER_PROMPT], { input: JSON.stringify({ cwd: ws, session_id: 's1', prompt: '/ga' }), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } }).stdout;
    expect(out).not.toContain('routed-context');
  });

  it('arguments never change the target: "/ga apps/game-b" routes to game-a', () => {
    const ws = workspace('{"commands": {"/ga": "apps/game-a", "/gb": "apps/game-b", "/home": "."}}');
    spawnSync('node', [SESSION_START], { input: JSON.stringify({ cwd: ws, session_id: 's1' }), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
    const out = spawnSync('node', [USER_PROMPT], { input: JSON.stringify({ cwd: ws, session_id: 's1', prompt: '/ga apps/game-b /gb' }), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } }).stdout;
    expect(out).toContain('<routed-context project="game-a" via="/ga">');
    expect(out).not.toContain('game-b 카드');
  });

  it('no declaration file → exit 3', () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-29rc-')));
    roots.push(ws);
    const r = routes(ws);
    expect(r.status).toBe(3);
    expect(fs.existsSync(path.join(ws, '.claude'))).toBe(false);
  });
});
