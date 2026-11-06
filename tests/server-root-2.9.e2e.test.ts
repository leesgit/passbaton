// P4-100 (ledger L-54 · L-55 · Astra P4 reply-4) — the MCP server and the hooks pick the same DB
//
// Why this file exists: `dist/index.js` had its own root detector that stopped at the nearest `.claude/`
// and had no home guard. A sub-repo under `apps/<game>/` with its own `.claude/passbaton.config.json`
// (exactly what `/newgame` creates, and what Ashfall has) made the server open `apps/<game>/.claude/sessions.db`
// while the hooks, from the same cwd, wrote to the monorepo DB.
//
// The verdict is the file system, not a log line: which `sessions.db` the started server actually created.
// Expected values come from an independent table (the layout we built), not from `resolveWorkspaceRoot`.
// Positive control: the same layout with WORKSPACE_ROOT set creates the DB where the env says.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../dist/index.js');
const built = fs.existsSync(SERVER);
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p4-100', version: '1' } },
});

/** Start the server, send initialize, close stdin after the first response line. */
function startOnce(cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
    child.stdout.on('data', d => { stdout += String(d); if (stdout.includes('\n')) child.stdin.end(); });
    child.stderr.on('data', () => { /* startup log */ });
    child.stdin.write(INIT + '\n');
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, timedOut }); });
  });
}

/** fake home (has `.claude/`, like a real profile) · monorepo with apps/game as an independent repo with its own `.claude/` */
function layout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4-srvroot-')));
  roots.push(base);
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const mono = path.join(base, 'work', 'mono');
  const game = path.join(mono, 'apps', 'game');
  fs.mkdirSync(path.join(mono, '.git'), { recursive: true });
  fs.mkdirSync(path.join(game, '.git'), { recursive: true });
  fs.mkdirSync(path.join(game, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(game, '.claude', 'passbaton.config.json'), '{"continuity":{"sources":[]}}');
  const bare = path.join(home, 'work', 'bare');
  fs.mkdirSync(bare, { recursive: true });
  return { home, mono, game, bare };
}

function env(home: string, ws?: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete e.WORKSPACE_ROOT;
  delete e.PASSBATON_READONLY;
  if (ws) e.WORKSPACE_ROOT = ws;
  return e;
}

const db = (dir: string) => path.join(dir, '.claude', 'sessions.db');

describe.skipIf(!built)('P4-100 — server and hooks resolve the same workspace root', () => {
  it('server started inside apps/<game> (own .git and .claude) opens the monorepo DB, not the app DB', async () => {
    const { home, mono, game } = layout();
    const r = await startOnce(game, env(home));
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain('"result"');
    expect(fs.existsSync(db(mono))).toBe(true);
    expect(fs.existsSync(db(game))).toBe(false);
  }, 30000);

  it('hook resolver agrees with the server for the same cwd', async () => {
    const { home, mono, game } = layout();
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, WS: process.env.WORKSPACE_ROOT };
    process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.WORKSPACE_ROOT;
    try {
      const { resolveWorkspaceRoot } = await import('../src/utils/workspace.js');
      expect(resolveWorkspaceRoot(game)).toEqual({ root: mono, reason: 'apps' });
    } finally {
      process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
      if (saved.WS !== undefined) process.env.WORKSPACE_ROOT = saved.WS;
    }
  });

  it('server started in a marker-less folder under the home does not climb into ~/.claude', async () => {
    const { home, bare } = layout();
    const r = await startOnce(bare, env(home));
    expect(r.timedOut).toBe(false);
    expect(fs.existsSync(db(home))).toBe(false);
  }, 30000);

  it('positive control: WORKSPACE_ROOT still wins (DB created where the env says)', async () => {
    const { home, mono, game } = layout();
    const r = await startOnce(game, env(home, game));
    expect(r.timedOut).toBe(false);
    expect(fs.existsSync(db(game))).toBe(true);
    expect(fs.existsSync(db(mono))).toBe(false);
  }, 30000);
});
