// 설치기가 쓴 훅·MCP 가 **PATH 에 node/npm 이 없어도** 도는가 (2026-10-15, Astra P1 C·D·E·A)
//
// 실제로 겪은 일: Node 를 처음 깔기 전부터 열려 있던 앱에서 Claude Code 를 띄우니 그 PATH 가
// 옛것이라 `npm exec -- passbaton-hook-*` 훅이 매 프롬프트 `npm: command not found` 로 죽었고,
// `npx passbaton` MCP 도 CONNECTION_CLOSED 였다. 설치기는 이제 node·스크립트 절대 경로를 쓴다.
//
// 모든 시험은 임시 HOME 에서 돈다 — ⛔ 사용자의 ~/.claude 를 건드리지 않는다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const INSTALLER = path.join(ROOT, 'dist', 'hooks', 'install.js');
const POSTINSTALL = path.join(ROOT, 'scripts', 'postinstall.cjs');
const built = fs.existsSync(INSTALLER);
const win = process.platform === 'win32';

const dirs: string[] = [];
const tmpDir = (name: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) {
    try { fs.rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/** node·npm 이 **없는** 최소 환경. 셸이 돌 만큼만 남긴다. */
function barePathEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const sys = process.env.SystemRoot ?? 'C:\\Windows';
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: win ? `${sys}\\System32;${sys}` : '/usr/bin:/bin',
    ...(win ? { SystemRoot: sys, ComSpec: `${sys}\\System32\\cmd.exe`, TEMP: os.tmpdir(), TMP: os.tmpdir() } : { TMPDIR: os.tmpdir() }),
    ...extra,
  };
}

function runInstaller(home: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    encoding: 'utf8',
  });
}

const readSettings = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const commandsOf = (settings: { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }, event: string) =>
  (settings.hooks[event] ?? []).flatMap(e => e.hooks.map(h => h.command));

/** 이 PC 에서 훅을 띄울 수 있는 셸들 (Claude Code 는 Windows 에서 Git Bash 로 띄운다). */
function shells(): Array<{ name: string; run: (cmd: string, input: string, env: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync> }> {
  const out: ReturnType<typeof shells> = [];
  const bashCandidates = win
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash'];
  const bash = bashCandidates.find(p => fs.existsSync(p));
  if (bash) out.push({ name: 'bash', run: (c, i, e) => spawnSync(bash, ['-c', c], { input: i, env: e, encoding: 'utf8', timeout: 60_000 }) });
  if (!win && fs.existsSync('/bin/sh')) out.push({ name: 'sh', run: (c, i, e) => spawnSync('/bin/sh', ['-c', c], { input: i, env: e, encoding: 'utf8', timeout: 60_000 }) });
  if (win) {
    const cmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    out.push({ name: 'cmd', run: (c, i, e) => spawnSync(cmd, ['/d', '/s', '/c', `"${c}"`], { input: i, env: e, encoding: 'utf8', timeout: 60_000, windowsVerbatimArguments: true }) });
  }
  return out;
}

describe.skipIf(!built)('install — Claude Code 훅은 PATH 없이 돈다', () => {
  it('빈 HOME 에 절대 경로 훅 5종 + MCP 항목을 쓴다 (종료 0)', () => {
    const home = tmpDir('pb-home-');
    const r = runInstaller(home, ['install']);
    expect(r.status, r.stderr).toBe(0);
    const s = readSettings(home);
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']) {
      const cs = commandsOf(s, ev);
      expect(cs).toHaveLength(1);
      expect(cs[0].startsWith(`"${process.execPath.replace(/\\/g, win ? '/' : '\\')}" "`)).toBe(true);
    }
    expect(commandsOf(s, 'PostToolUse')).toHaveLength(2);
    const mcp = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['project-manager'];
    expect(mcp).toEqual({ command: process.execPath, args: [path.join(ROOT, 'dist', 'index.js')] });
  });

  it('등록된 훅을 node·npm 없는 PATH 의 셸로 돌려도 성공하고 실제로 일한다', () => {
    const home = tmpDir('pb-home-');
    expect(runInstaller(home, ['install']).status).toBe(0);
    const s = readSettings(home);
    const available = shells();
    expect(available.length).toBeGreaterThan(0);
    for (const sh of available) {
      const ws = tmpDir(`pb-ws-${sh.name}-`);
      fs.mkdirSync(path.join(ws, '.git'));
      const env = barePathEnv(home);
      // 같은 PATH 에서 옛 형태는 죽는다 — 시험 환경이 정말 node·npm 없는 환경인지의 대조
      const legacy = sh.run('npm exec -- passbaton-hook-session-start', '{}', env);
      expect(legacy.status, `${sh.name}: legacy form must fail here`).not.toBe(0);

      const start = sh.run(commandsOf(s, 'SessionStart')[0], JSON.stringify({ session_id: 't', cwd: ws, hook_event_name: 'SessionStart' }), env);
      expect(start.status, `${sh.name}: ${start.stderr}`).toBe(0);
      expect(start.stdout).toContain('<session-context');
      expect(fs.existsSync(path.join(ws, '.claude', 'sessions.db'))).toBe(true);

      for (const ev of ['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop']) {
        const input = JSON.stringify({ session_id: 't', cwd: ws, hook_event_name: ev, prompt: 'probe',
          tool_name: 'Edit', tool_input: { file_path: path.join(ws, 'a.txt') } });
        const r = sh.run(commandsOf(s, ev)[0], input, env);
        expect(r.status, `${sh.name} ${ev}: ${r.stderr}`).toBe(0);
      }
    }
  });

  it('공백·한글이 든 설치 경로도 각 셸에서 돈다', () => {
    const home = tmpDir('pb-home-');
    const odd = path.join(tmpDir('pb-odd-'), '패스 바통', 'passbaton');
    fs.mkdirSync(odd, { recursive: true });
    fs.cpSync(path.join(ROOT, 'dist'), path.join(odd, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(odd, 'package.json'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(odd, 'node_modules'), 'junction');
    const r = spawnSync(process.execPath, [path.join(odd, 'dist', 'hooks', 'install.js'), 'install'], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const c = commandsOf(readSettings(home), 'SessionStart')[0];
    expect(c).toContain('패스 바통');
    for (const sh of shells()) {
      const ws = tmpDir('pb-ws-');
      fs.mkdirSync(path.join(ws, '.git'));
      const out = sh.run(c, JSON.stringify({ session_id: 't', cwd: ws, hook_event_name: 'SessionStart' }), barePathEnv(home));
      expect(out.status, `${sh.name}: ${out.stderr}`).toBe(0);
      expect(out.stdout).toContain('<session-context');
    }
  });

  it('두 번 설치해도 등록 수가 늘지 않고, 섞인 사용자 줄은 남는다', () => {
    const home = tmpDir('pb-home-');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      model: 'keep-me',
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [
          { type: 'command', command: 'npm exec -- passbaton-hook-post-tool' },
          { type: 'command', command: 'my-formatter --fix' },
        ] }],
        Stop: [{ hooks: [{ type: 'command', command: 'my-wrapper passbaton-hook-session-end' }] }],
      },
    }));
    expect(runInstaller(home, ['install']).status).toBe(0);
    expect(runInstaller(home, ['install']).status).toBe(0);
    const s = readSettings(home);
    expect(s.model).toBe('keep-me');
    const post = commandsOf(s, 'PostToolUse');
    expect(post.filter(c => c === 'my-formatter --fix')).toHaveLength(1);
    expect(post.filter(c => c.includes('post-tool-use.js'))).toHaveLength(2);
    expect(post.some(c => c.startsWith('npm exec'))).toBe(false);
    const stop = commandsOf(s, 'Stop');
    expect(stop).toContain('my-wrapper passbaton-hook-session-end');
    expect(stop.filter(c => c.includes('session-end.js'))).toHaveLength(1);
  });

  it('⛔ 깨진 settings.json 은 덮어쓰지 않고 실패로 끝난다 (종료 1)', () => {
    const home = tmpDir('pb-home-');
    fs.mkdirSync(path.join(home, '.claude'));
    const bad = '{ "hooks": { "Stop": [ ';
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), bad);
    const r = runInstaller(home, ['install']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
    expect(r.stdout).not.toContain('Installation complete');
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(bad);
  });

  it('남의 "project-manager" MCP 항목은 건드리지 않는다', () => {
    const home = tmpDir('pb-home-');
    const theirs = { mcpServers: { 'project-manager': { command: 'python', args: ['pm.py'] } }, other: 1 };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(theirs));
    expect(runInstaller(home, ['install']).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))).toEqual(theirs);
  });
});

describe.skipIf(!built)('postinstall — 자동 설정 실패가 패키지 설치를 막지 않는다', () => {
  const runPost = (home: string, script = POSTINSTALL) =>
    spawnSync(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });

  it('정상이면 종료 0, 훅이 깔린다', () => {
    const home = tmpDir('pb-home-');
    const r = runPost(home);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('did NOT complete');
    expect(commandsOf(readSettings(home), 'SessionStart')).toHaveLength(1);
  });

  it('기존 우리 줄(옛 npm exec 형태)은 자동 설치가 바꾸지 않는다', () => {
    const home = tmpDir('pb-home-');
    fs.mkdirSync(path.join(home, '.claude'));
    const before = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npm exec -- passbaton-hook-session-start' }] }] } };
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(before));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'project-manager': { command: 'npx', args: ['passbaton'] } } }));
    expect(runPost(home).status).toBe(0);
    const s = readSettings(home);
    expect(commandsOf(s, 'SessionStart')).toEqual(['npm exec -- passbaton-hook-session-start']);
    expect(commandsOf(s, 'Stop')).toHaveLength(1);   // 없던 이벤트는 추가
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['project-manager'])
      .toEqual({ command: 'npx', args: ['passbaton'] });
  });

  it('깨진 settings.json: 종료 0 이지만 「끝나지 않았다」 고 원인과 재시도 명령을 남기고, 파일은 그대로', () => {
    const home = tmpDir('pb-home-');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{oops');
    const r = runPost(home);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('did NOT complete');
    expect(r.stderr).toContain('not valid JSON');
    expect(r.stderr).toContain('npx passbaton-hooks install');
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{oops');
  });

  it('설치기 파일이 없어도(로드 전 실패) 종료 0 + 경고', () => {
    const pkg = tmpDir('pb-pkg-');
    fs.mkdirSync(path.join(pkg, 'scripts'));
    const wrapper = path.join(pkg, 'scripts', 'postinstall.cjs');
    fs.copyFileSync(POSTINSTALL, wrapper);
    const r = runPost(tmpDir('pb-home-'), wrapper);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('did NOT complete');
  });

  it('package.json 의 postinstall 에 셸 문법이 없다 (Windows cmd 에서 죽던 형태)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall.cjs');
    expect(pkg.files).toContain('scripts/postinstall.cjs');
  });
});

describe.skipIf(!built)('status — 등록됨·찾을 수 있음·실행됨을 가른다', () => {
  it('막 설치한 상태는 종료 0 이고 한계(지금 이 프로세스의 PATH 기준)를 밝힌다', () => {
    const home = tmpDir('pb-home-');
    expect(runInstaller(home, ['install']).status).toBe(0);
    const r = runInstaller(home, ['status']);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('PATH of THIS command');
    expect(r.stdout).toContain('independent of PATH');
  });

  it('사라진 훅 스크립트 · 등록 누락 · PATH 에 없는 npm 을 각각 실패로', () => {
    const home = tmpDir('pb-home-');
    expect(runInstaller(home, ['install']).status).toBe(0);
    const file = path.join(home, '.claude', 'settings.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 설치 위치가 통째로 사라진 경우: 형태는 우리 것(…/passbaton/dist/hooks/…)인데 파일이 없다
    const gone = path.join(tmpDir('pb-gone-'), 'passbaton', 'dist', 'hooks', 'session-start.js').replace(/\\/g, '/');
    s.hooks.SessionStart[0].hooks[0].command = `"${process.execPath.replace(/\\/g, '/')}" "${gone}"`;
    delete s.hooks.PreCompact;
    s.hooks.Stop[0].hooks[0].command = 'npm exec -- passbaton-hook-session-end';
    fs.writeFileSync(file, JSON.stringify(s));
    const r = spawnSync(process.execPath, [INSTALLER, 'status'], { env: barePathEnv(home), encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/SessionStart \[absolute\] hook script not found/);
    expect(r.stdout).toContain('PreCompact: not registered');
    expect(r.stdout).toMatch(/Stop \[npm-exec\] npm not on PATH/);
    expect(r.stdout).toContain('npx passbaton-hooks install');
    expect(r.stdout).toContain('No reboot is needed');
  });
});

describe.skipIf(!built)('MCP — 등록 항목으로 PATH 없이 붙는다', () => {
  it('initialize → tools/list → memory_store → memory_stats, stdout 은 JSON-RPC 뿐', async () => {
    const home = tmpDir('pb-home-');
    expect(runInstaller(home, ['install']).status).toBe(0);
    const entry = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['project-manager'];
    const ws = tmpDir('pb-ws-');
    fs.mkdirSync(path.join(ws, '.git'));
    const child = spawn(entry.command, entry.args, { env: barePathEnv(home, { WORKSPACE_ROOT: ws }), cwd: ws });
    let buf = '';
    const msgs: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    const nonJson: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { msgs.push(JSON.parse(line)); } catch { nonJson.push(line); }
      }
    });
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    const waitFor = (id: number) => new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const m = msgs.find(x => x.id === id);
        if (m) return resolve(m);
        if (Date.now() - t0 > 30_000) return reject(new Error(`timeout waiting for ${id}`));
        setTimeout(tick, 20);
      };
      tick();
    });
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect((await waitFor(1)).result).toBeDefined();
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const tools = (await waitFor(2)).result as { tools: Array<{ name: string }> };
      expect(tools.tools.map(t => t.name)).toContain('memory_stats');
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_store', arguments: { content: 'probe memory', type: 'learning', project: 'probe' } } });
      const stored = await waitFor(3);
      expect(stored.error).toBeUndefined();
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } });
      const stats = await waitFor(4);
      expect(stats.error).toBeUndefined();
      expect(JSON.stringify(stats.result)).not.toMatch(/isError":true/);
      expect(nonJson).toEqual([]);
    } finally {
      child.kill();
    }
  }, 60_000);
});
