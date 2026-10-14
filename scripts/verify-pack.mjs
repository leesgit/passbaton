#!/usr/bin/env node
/**
 * 배포 판정 (Astra P1 §4 · P2 §3·4): **실제 배포 tarball** 을 전역 설치하고
 * 훅 동작 → MCP 연결 → 임시 SQLite 생성·쿼리까지 본다. 문자열 테스트로는 이걸 못 본다.
 *
 *   node scripts/verify-pack.mjs                 # 기본 설정 설치 → 전부 초록이어야
 *   node scripts/verify-pack.mjs --break=shell   # 역검증: 옛 postinstall(셸 문법)로 포장 → 빨개져야
 *   node scripts/verify-pack.mjs --strict        # npm 설치 스크립트 정책: 엄격·승인 없음 → 설치 실패 /
 *                                                #   엄격·README 의 승인 목록 → 전부 초록
 *   node scripts/verify-pack.mjs --recover       # 스크립트를 건너뛴 설치(npm v12 기본 차단과 같은 꼴) → 빨개지고,
 *                                                #   README 의 복구 명령 → 전부 초록
 *
 * ⚠ 옛 postinstall 은 Windows(npm 11.19, cmd)에서 **설치를 실패시키지 않는다** — 종료 0 인데 postinstall 의
 *   node 명령이 아예 안 돈다(2026-10-15 실측). 즉 「설치 성공 · 훅·MCP 없음」. 그래서 역검증은
 *   설치 종료 코드가 아니라 「훅이 깔렸는가」 에서 빨개져야 한다.
 *
 * ⛔ 사용자의 ~/.claude 를 건드리지 않는다 — 임시 prefix(전역 설치 위치)와 임시 HOME 을 쓴다.
 *    npm 설정을 바꾸지 않는다(정책 시험은 명령줄 플래그로만). 의존성은 레지스트리에서 받는다.
 */
import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const arg = name => process.argv.includes(name);
const breakMode = (process.argv.find(a => a.startsWith('--break=')) ?? '').slice('--break='.length);
const { ALLOW_SCRIPTS } = await import(new URL('../dist/hooks/install.js', import.meta.url).href);
const ALLOW = ALLOW_SCRIPTS.join(',');

let results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  // CI 에서는 실패를 주석으로도 남긴다 — 단계 로그는 인증 없이 못 읽지만 주석은 공개 API 로 읽힌다
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=verify-pack::${name} — ${String(detail).replace(/?
/g, ' ').slice(0, 900)}`);
  return ok;
};
// Windows 의 npm 은 .cmd 라 셸 없이 못 띄운다. 인자는 이 스크립트가 만든 값뿐.
const npm = (args, opts = {}) => spawnSync(win ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: win, ...opts });

const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-pack-')));
process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 윈도우 잠금 — 남겨도 된다 */ } });

// ---- 포장 (역검증이면 package.json 을 잠시 옛 형태로) ----
const pkgFile = path.join(ROOT, 'package.json');
const pkgText = fs.readFileSync(pkgFile, 'utf8');
let tgz;
try {
  if (breakMode === 'shell') {
    fs.writeFileSync(pkgFile, pkgText.replace('"node scripts/postinstall.cjs"', '"node dist/hooks/install.js install 2>/dev/null || true"'));
  }
  const p = npm(['pack', '--pack-destination', work, '--json'], { cwd: ROOT });
  if (p.status !== 0) { console.error(p.stderr); process.exit(2); }
  const info = JSON.parse(p.stdout)[0];
  tgz = path.join(work, info.filename);
  const files = info.files.map(f => f.path);
  console.log('pack');
  check('tarball 에 postinstall 래퍼와 dist 설치기가 있다',
    files.includes('scripts/postinstall.cjs') && files.includes('dist/hooks/install.js') && files.includes('dist/index.js'));
} finally {
  fs.writeFileSync(pkgFile, pkgText);
}
check('README 의 승인 목록 = 코드의 ALLOW_SCRIPTS', fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes(`--allow-scripts=${ALLOW}`), ALLOW);

let n = 0;
function freshEnv() {
  const base = path.join(work, `run${++n}`);
  const home = path.join(base, 'home');
  const prefix = path.join(base, 'prefix');
  const ws = path.join(base, 'ws');
  for (const d of [home, prefix, path.join(ws, '.git')]) fs.mkdirSync(d, { recursive: true });
  return { home, prefix, ws, env: { ...process.env, HOME: home, USERPROFILE: home } };
}
const install = (e, extra = []) => npm(['install', '-g', '--prefix', e.prefix, ...extra, tgz], { env: e.env });
const lastLines = r => (r.stderr || '').split('\n').map(l => l.trim()).filter(Boolean).slice(-2).join(' | ');

/** 설치된 상태를 판정한다. 실패 수를 돌려준다. */
async function verifyInstalled(e) {
  const pkgDir = win ? path.join(e.prefix, 'node_modules', 'passbaton') : path.join(e.prefix, 'lib', 'node_modules', 'passbaton');
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const h = readJson(path.join(e.home, '.claude', 'settings.json'))?.hooks?.SessionStart?.[0]?.hooks?.[0];
  const isExec = !!h && Array.isArray(h.args);
  check('postinstall 이 임시 HOME 에 절대 경로 훅을 썼다',
    !!h && (isExec ? fs.existsSync(h.command) && h.args[0] === path.join(pkgDir, 'dist', 'hooks', 'session-start.js')
      : String(h.command).includes('passbaton/dist/hooks/session-start.js')),
    h ? JSON.stringify(h) : '훅 없음');
  const mcp = readJson(path.join(e.home, '.claude.json'))?.mcpServers?.['project-manager'];
  check('MCP 항목 = node 절대 + 설치된 dist/index.js', !!mcp && fs.existsSync(mcp.command) && path.resolve(mcp.args[0]) === path.join(pkgDir, 'dist', 'index.js'));
  if (!h || !mcp) return;

  // node·npm 없는 PATH
  const sys = process.env.SystemRoot ?? 'C:\\Windows';
  const bareEnv = { HOME: e.home, USERPROFILE: e.home, PATH: win ? `${sys}\\System32;${sys}` : '/usr/bin:/bin',
    ...(win ? { SystemRoot: sys, TEMP: os.tmpdir(), TMP: os.tmpdir() } : { TMPDIR: os.tmpdir() }) };
  const input = JSON.stringify({ session_id: 'v', cwd: e.ws, hook_event_name: 'SessionStart' });
  if (isExec) {
    const r = spawnSync(h.command, h.args, { input, env: bareEnv, encoding: 'utf8', shell: false });   // Claude Code 의 exec 형식 그대로
    check('훅(exec 형식)이 node·npm 없는 PATH 에서 셸 없이 돈다', r.status === 0 && r.stdout.includes('<session-context'), lastLines(r));
  } else {
    const bash = (win ? ['C:\\Program Files\\Git\\bin\\bash.exe'] : ['/bin/bash', '/bin/sh']).find(p => fs.existsSync(p));
    const r = bash ? spawnSync(bash, ['-c', h.command], { input, env: bareEnv, encoding: 'utf8' }) : null;
    check('훅(셸 형식)이 node·npm 없는 PATH 에서 돈다', !!r && r.status === 0 && r.stdout.includes('<session-context'), r ? lastLines(r) : 'bash/sh 없음');
  }

  // MCP: 같은 PATH 로 initialize → memory_store → memory_stats (SQLite 바인딩까지)
  const child = spawn(mcp.command, mcp.args, { env: { ...bareEnv, WORKSPACE_ROOT: e.ws }, cwd: e.ws });
  let buf = '';
  let stderr = '';
  const msgs = [];
  const nonJson = [];
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
      if (m || Date.now() - t0 > 30_000 || child.exitCode !== null) return resolve(m);
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
  check('임시 SQLite 생성·쓰기·쿼리 (memory_store → memory_stats)', dbOk && fs.existsSync(path.join(e.ws, '.claude', 'sessions.db')),
    dbOk ? '' : (stderr.trim().split('\n').find(l => /Error/.test(l)) ?? JSON.stringify(stored ?? stats ?? null)).slice(0, 200));
  check('MCP stdout 은 JSON-RPC 뿐', nonJson.length === 0, nonJson.slice(0, 2).join(' | '));
  child.kill();
}

/** 한 시나리오: 실패 수를 돌려준다. */
async function scenario(title, run) {
  console.log(`\n${title}`);
  results = [];
  await run();
  return results.filter(r => !r.ok).length;
}

let verdict = true;
const policyNote = `npm ${npm(['--version']).stdout.trim()} · script-shell=${npm(['config', 'get', 'script-shell']).stdout.trim()}`;

if (arg('--strict')) {
  const f1 = await scenario(`엄격 정책 · 승인 없음 → 설치가 실패해야 한다 (${policyNote})`, async () => {
    const e = freshEnv();
    const r = install(e, ['--strict-allow-scripts']);
    check('설치 종료 ≠ 0', r.status !== 0, `exit ${r.status}`);
  });
  // ⚠ 로컬 tarball 로 깐 루트 패키지는 **이름으로 승인되지 않는다** — npm 은 「해석된 출처」 로 맞춘다
  //   (2026-10-15 실측: `passbaton` · `passbaton@<판>` · `file:<tgz>` · `<tgz>` 모두 미승인 1 = 루트).
  //   그래서 둘로 가른다: ① 새 판 tarball 에서 목록이 **의존성 전부**를 덮는가(남는 미승인 = 루트 하나)
  //   ② 레지스트리 배포판에서 README 명령 그대로 엄격 설치가 되는가(이름 매칭)
  const f2 = await scenario(`엄격 정책 · 새 판 tarball + 승인 목록(${ALLOW}) → 남는 미승인은 로컬 루트 하나뿐`, async () => {
    const e = freshEnv();
    const r = install(e, ['--strict-allow-scripts', `--allow-scripts=${ALLOW}`]);
    const m = /(\d+) package\(s\) have install scripts not covered/.exec(r.stderr || '');
    const uncovered = (r.stderr || '').split('\n').filter(l => /npm error\s+\S+@\S+ \(/.test(l)).map(l => l.trim());
    check('의존성의 설치 스크립트가 전부 목록에 있다', r.status === 0 || (m?.[1] === '1' && uncovered.length === 1 && /npm error\s+passbaton@/.test(uncovered[0])),
      r.status === 0 ? 'exit 0' : `${m?.[1] ?? '?'} uncovered: ${uncovered.join(' ; ')}`);
  });
  const f3 = await scenario('엄격 정책 · 레지스트리 배포판 + README 명령 → 설치 종료 0 (이름 매칭 확인)', async () => {
    const e = freshEnv();
    const r = npm(['install', '-g', '--prefix', e.prefix, '--strict-allow-scripts', `--allow-scripts=${ALLOW}`, 'passbaton@latest'], { env: e.env });
    check('설치 종료 0', r.status === 0, r.status === 0 ? '' : lastLines(r));
  });
  verdict = f1 === 0 && f2 === 0 && f3 === 0;
} else if (arg('--recover')) {
  const e = freshEnv();
  const f1 = await scenario('설치 스크립트를 건너뛴 설치(--ignore-scripts) → 빨개져야 한다', async () => {
    const r = install(e, ['--ignore-scripts']);
    if (check('설치 종료 0', r.status === 0, lastLines(r))) await verifyInstalled(e);
  });
  const statusBin = win ? path.join(e.prefix, 'passbaton-hooks.cmd') : path.join(e.prefix, 'bin', 'passbaton-hooks');
  const st = spawnSync(statusBin, ['status'], { env: e.env, encoding: 'utf8', shell: win });
  console.log(`  ${st.status !== 0 && /better-sqlite3 does not load/.test(st.stdout) ? 'PASS' : 'FAIL'}  status 가 SQLite 바인딩 없음을 잡는다 (exit ${st.status})`);
  const statusCaught = st.status !== 0 && /better-sqlite3 does not load/.test(st.stdout);
  const f2 = await scenario(`README 의 복구 명령(npm install -g passbaton --allow-scripts=${ALLOW}) → 전부 초록`, async () => {
    const r = install(e, [`--allow-scripts=${ALLOW}`]);
    if (check('복구 설치 종료 0', r.status === 0, lastLines(r))) await verifyInstalled(e);
  });
  verdict = f1 > 0 && statusCaught && f2 === 0;
  console.log(`\n건너뛴 설치: ${f1 > 0 ? `✅ 빨강 (${f1})` : '❌ 초록 — 이 판정은 건너뛴 설치를 못 잡는다'} · 복구 뒤: ${f2 === 0 ? '✅ 초록' : `❌ ${f2} 실패`}`);
} else {
  const f = await scenario(`기본 설정 전역 설치 (${policyNote})`, async () => {
    const e = freshEnv();
    const r = install(e);
    if (check('설치 종료 0', r.status === 0, lastLines(r))) await verifyInstalled(e);
  });
  verdict = breakMode ? f > 0 : f === 0;
  if (breakMode) console.log(`\n역검증(${breakMode}): ${f > 0 ? `✅ 판정이 빨갛다 (${f} 실패)` : '❌ 전부 통과 — 이 판정은 옛 결함을 못 잡는다'}`);
}

console.log(`\n${verdict ? '✅' : '❌'} verify-pack${breakMode ? ` --break=${breakMode}` : arg('--strict') ? ' --strict' : arg('--recover') ? ' --recover' : ''} (${process.platform})`);
process.exit(verdict ? 0 : 1);
