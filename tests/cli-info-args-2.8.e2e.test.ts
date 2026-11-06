// PB195-100 (원장 B4 · R-83) — 정보 인자는 서버·DB 보다 먼저 끝난다
//
// 왜 이 파일이 있는가: `dist/index.js` 는 모듈 최상위에서 WORKSPACE_ROOT 를 찾고 `.claude/` 를 만들고
// `new Database(DB_PATH)` 로 DB 를 연 다음에야 인자를 봤다. 그래서 `--help` 도 DB 를 만들었고,
// `--version` 은 분기가 없어 stdio 서버까지 떴다. 10-24 tarball 확인에서 이 경로로 실제
// `~/.claude/sessions.db` 가 열렸다(cwd → 상위 탐색 → 홈의 `.claude`).
//
// 판정은 출력만 보지 않는다(출력은 맞는데 초기화가 먼저 도는 거짓 초록이 가능 — reply-195 §4):
//   - 종료 코드 · stdout
//   - stdin 을 **열어 둔 채** 스스로 끝나는가(서버가 뜨면 stdin 을 기다리며 안 끝난다 → 시간 초과 = 빨강)
//   - DB 파일(·`.claude/`)이 안 생겼는가 — WORKSPACE_ROOT 명시 + 홈 상위 탐색(사고 재현) 두 배치
//   - 양성 대조: 인자 없이 띄우면 같은 배치에서 서버가 응답하고 DB 가 생긴다(「안 생김」 검사가 살아 있음)

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
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8')) as { version: string }).version;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** stdin 을 닫지 않고 띄운다. `send` 가 있으면 한 줄 보내고 첫 stdout 줄을 받으면 stdin 을 닫는다. */
function run(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; send?: string; timeoutMs?: number }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER, ...args], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs ?? 8000);
    child.stdout.on('data', d => {
      stdout += String(d);
      if (opts.send && stdout.includes('\n')) child.stdin.end();
    });
    child.stderr.on('data', d => { stderr += String(d); });
    if (opts.send) child.stdin.write(opts.send + '\n');
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** 격리 배치: 가짜 홈(`.claude/` 있음 = 실제 홈과 같은 모양) · 그 아래 작업 폴더. */
function layout(): { home: string; ws: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb195-cli-'));
  roots.push(home);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const ws = path.join(home, 'work', 'repo');
  fs.mkdirSync(ws, { recursive: true });
  return { home, ws };
}

function envFor(home: string, ws: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.WORKSPACE_ROOT;
  delete env.PASSBATON_READONLY;
  if (ws) env.WORKSPACE_ROOT = ws;
  return env;
}

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pb195-cli', version: '1' } },
});

describe.skipIf(!built)('PB195-100 B4 — 정보 인자: 서버·DB 기동 전에 끝난다', () => {
  for (const arg of ['--version', '-v', 'version']) {
    it(`${arg}: package.json 버전 · 종료 0 · stdin 대기 없음 · DB·.claude 미생성(WORKSPACE_ROOT 명시)`, async () => {
      const { home, ws } = layout();
      const r = await run([arg], { cwd: ws, env: envFor(home, ws) });
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(PKG_VERSION);
      expect(r.stderr).not.toMatch(/MCP .*started/);
      expect(fs.existsSync(path.join(ws, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.claude', 'sessions.db'))).toBe(false);
    });
  }

  for (const arg of ['--help', '-h', 'help']) {
    it(`${arg}: 사용법 · 종료 0 · stdin 대기 없음 · DB·.claude 미생성`, async () => {
      const { home, ws } = layout();
      const r = await run([arg], { cwd: ws, env: envFor(home, ws) });
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: npx passbaton');
      expect(r.stdout).toContain('--version');
      expect(fs.existsSync(path.join(ws, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.claude', 'sessions.db'))).toBe(false);
    });
  }

  it('R-83 재현 배치(WORKSPACE_ROOT 없음 · cwd 상위 = 홈의 .claude): --version 이 홈 DB 를 만들지 않는다', async () => {
    const { home, ws } = layout();
    const r = await run(['--version'], { cwd: ws, env: envFor(home, null) });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual([]);
    expect(fs.existsSync(path.join(ws, '.claude'))).toBe(false);   // 2.9: positive control now opens the DB here
  });

  it('config(하위 명령)도 DB 를 열지 않는다', async () => {
    const { home, ws } = layout();
    const r = await run(['config'], { cwd: ws, env: envFor(home, ws) });
    expect(r.timedOut).toBe(false);
    expect(fs.existsSync(path.join(ws, '.claude', 'sessions.db'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'sessions.db'))).toBe(false);
  });

  // 양성 대조 — 같은 배치·같은 감시로 인자 없이 띄우면 서버가 응답하고 DB 가 생긴다.
  it('양성 대조: 인자 없음 = 서버가 initialize 에 응답 · DB 생성(WORKSPACE_ROOT 명시 · 홈 상위 탐색 둘 다)', async () => {
    const a = layout();
    const r1 = await run([], { cwd: a.ws, env: envFor(a.home, a.ws), send: INIT, timeoutMs: 20000 });
    expect(r1.timedOut).toBe(false);
    expect(r1.stdout).toContain('"id":1');
    expect(fs.existsSync(path.join(a.ws, '.claude', 'sessions.db'))).toBe(true);

    const b = layout();
    const r2 = await run([], { cwd: b.ws, env: envFor(b.home, null), send: INIT, timeoutMs: 20000 });
    expect(r2.timedOut).toBe(false);
    expect(r2.stdout).toContain('"id":1');
    // 2.9 (P4-100 · L-54): the server no longer climbs into the home's `.claude/` — it falls back to cwd
    //   like the hooks' resolver (reason `cwd`). The positive half is that it still opened a DB in this layout.
    expect(fs.existsSync(path.join(b.ws, '.claude', 'sessions.db'))).toBe(true);
    expect(fs.readdirSync(path.join(b.home, '.claude'))).toEqual([]);
  }, 60_000);   // 서버 두 번 기동 — 설치본(첫 실행)에서는 기본 5 초를 넘을 수 있다(PB195-800)
});
