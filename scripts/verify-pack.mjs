#!/usr/bin/env node
/**
 * 배포 판정 (Astra P1 §4): **실제 배포 tarball** 을 기본 설정으로 전역 설치하고
 * 훅 동작 → MCP 연결 → 임시 SQLite 생성·쿼리까지 본다. 문자열 테스트로는 이걸 못 본다.
 *
 *   node scripts/verify-pack.mjs              # 판정
 *   node scripts/verify-pack.mjs --break=shell # 역검증: 옛 postinstall(셸 문법)로 포장 → 판정이 빨개져야 한다
 *
 * ⚠ 옛 형태는 Windows(npm 11.19, cmd)에서 **설치를 실패시키지 않는다** — 종료 0 인데 postinstall 의
 *   node 명령이 아예 안 돈다(2026-10-15 실측: 부수효과 파일 안 생김). 즉 「설치 성공 · 훅·MCP 없음」.
 *   그래서 역검증은 「설치 종료 코드」 가 아니라 「훅이 깔렸는가」 에서 빨개져야 한다.
 *
 * ⛔ 사용자의 ~/.claude 를 건드리지 않는다 — 임시 prefix(전역 설치 위치)와 임시 HOME 을 쓴다.
 *    npm 설정(script-shell 등)은 바꾸지 않는다: 「기본 설정」 이 시험 대상이다.
 * 의존성은 레지스트리에서 받는다(네트워크 필요).
 */
import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const breakMode = (process.argv.find(a => a.startsWith('--break=')) ?? '').slice('--break='.length);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const npm = (args, opts = {}) => spawnSync(win ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: win, ...opts });

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-pack-')));
const home = path.join(work, 'home');
const prefix = path.join(work, 'prefix');
const ws = path.join(work, 'ws');
for (const d of [home, prefix, path.join(ws, '.git')]) fs.mkdirSync(d, { recursive: true });

// 1. 포장 — 역검증이면 package.json 을 잠시 옛 형태로
const pkgFile = path.join(ROOT, 'package.json');
const pkgText = fs.readFileSync(pkgFile, 'utf8');
let tgz;
try {
  if (breakMode === 'shell') {
    fs.writeFileSync(pkgFile, pkgText.replace('"node scripts/postinstall.cjs"', '"node dist/hooks/install.js install 2>/dev/null || true"'));
  }
  const p = npm(['pack', '--pack-destination', work, '--json'], { cwd: ROOT });
  if (p.status !== 0) { console.error(p.stderr); process.exit(2); }
  tgz = path.join(work, JSON.parse(p.stdout)[0].filename);
  const files = JSON.parse(p.stdout)[0].files.map(f => f.path);
  check('tarball 에 postinstall 래퍼와 dist 설치기가 있다',
    files.includes('scripts/postinstall.cjs') && files.includes('dist/hooks/install.js') && files.includes('dist/index.js'));
} finally {
  fs.writeFileSync(pkgFile, pkgText);
}

// 2. 기본 설정으로 전역 설치 (prefix 만 임시로)
const env = { ...process.env, HOME: home, USERPROFILE: home };
const inst = npm(['install', '-g', '--prefix', prefix, tgz], { env });
const installedOk = check(`기본 설정 전역 설치 종료 0 (script-shell=${npm(['config', 'get', 'script-shell']).stdout.trim()})`,
  inst.status === 0, inst.status === 0 ? '' : (inst.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | '));
function finish() {
  const failed = results.filter(r => !r.ok).length;
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 윈도우 잠금 — 남겨도 된다 */ }
  if (breakMode) {
    console.log(`\n역검증(${breakMode}): ${failed > 0 ? `✅ 판정이 빨갛다 (${failed} 실패)` : '❌ 전부 통과 — 이 판정은 옛 결함을 못 잡는다'}`);
    process.exit(failed > 0 ? 0 : 1);
  }
  console.log(`\n${failed === 0 ? '✅' : '❌'} verify-pack: ${results.length - failed}/${results.length} (${process.platform})`);
  process.exit(failed === 0 ? 0 : 1);
}
if (!installedOk) finish();

const pkgDir = win ? path.join(prefix, 'node_modules', 'passbaton') : path.join(prefix, 'lib', 'node_modules', 'passbaton');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const cmd = readJson(path.join(home, '.claude', 'settings.json'))?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? '';
check('postinstall 이 임시 HOME 에 절대 경로 훅을 썼다', cmd.startsWith('"') && cmd.includes('passbaton/dist/hooks/session-start.js'), cmd || '훅 없음');
const mcp = readJson(path.join(home, '.claude.json'))?.mcpServers?.['project-manager'];
check('MCP 항목 = node 절대 + 설치된 dist/index.js', !!mcp && fs.existsSync(mcp.command) && path.resolve(mcp.args[0]) === path.join(pkgDir, 'dist', 'index.js'));
if (!cmd || !mcp) finish();

// 3. node·npm 없는 PATH 로 훅 실행
const sys = process.env.SystemRoot ?? 'C:\\Windows';
const bareEnv = { HOME: home, USERPROFILE: home, PATH: win ? `${sys}\\System32;${sys}` : '/usr/bin:/bin',
  ...(win ? { SystemRoot: sys, TEMP: os.tmpdir(), TMP: os.tmpdir() } : { TMPDIR: os.tmpdir() }) };
const bash = (win ? ['C:\\Program Files\\Git\\bin\\bash.exe'] : ['/bin/bash', '/bin/sh']).find(p => fs.existsSync(p));
if (bash) {
  const r = spawnSync(bash, ['-c', cmd], { input: JSON.stringify({ session_id: 'v', cwd: ws, hook_event_name: 'SessionStart' }), env: bareEnv, encoding: 'utf8' });
  check(`훅이 node·npm 없는 PATH 의 ${path.basename(bash)} 에서 돈다`, r.status === 0 && r.stdout.includes('<session-context'), r.stderr.trim().split('\n').pop());
} else {
  check('훅 실행 셸', false, 'bash/sh 없음 — 이 OS 에서는 판정 못 함');
}

// 4. MCP: 같은 PATH 로 initialize → memory_store → memory_stats (SQLite 바인딩까지)
const child = spawn(mcp.command, mcp.args, { env: { ...bareEnv, WORKSPACE_ROOT: ws }, cwd: ws });
let buf = '';
const msgs = [];
const nonJson = [];
let stderr = '';
child.stderr.on('data', d => { stderr += d; });
child.stdout.setEncoding('utf8');
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { msgs.push(JSON.parse(line)); } catch { nonJson.push(line); }
  }
});
const send = m => child.stdin.write(JSON.stringify(m) + '\n');
const waitFor = id => new Promise(resolve => {
  const t0 = Date.now();
  const tick = () => {
    const m = msgs.find(x => x.id === id);
    if (m || Date.now() - t0 > 30_000) return resolve(m);
    setTimeout(tick, 20);
  };
  tick();
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-pack', version: '1' } } });
const init = await waitFor(1);
check('MCP initialize', !!init?.result, init ? '' : stderr.trim().split('\n').slice(-2).join(' | '));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_store', arguments: { content: 'verify-pack probe', type: 'learning', project: 'verify' } } });
const stored = await waitFor(2);
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } });
const stats = await waitFor(3);
const dbOk = !!stored?.result && !stored.result.isError && !!stats?.result && !stats.result.isError;
check('임시 SQLite 생성·쓰기·쿼리 (memory_store → memory_stats)', dbOk && fs.existsSync(path.join(ws, '.claude', 'sessions.db')),
  dbOk ? '' : JSON.stringify(stored ?? stats ?? stderr.slice(-300)));
check('MCP stdout 은 JSON-RPC 뿐', nonJson.length === 0, nonJson.slice(0, 2).join(' | '));
child.kill();

finish();
