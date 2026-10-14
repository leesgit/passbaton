#!/usr/bin/env node
/**
 * Claude Code Hooks + MCP Server 자동 설치 스크립트
 *
 * npm install 시 자동으로:
 * 1. ~/.claude/settings.json에 Hook 등록
 * 2. ~/.claude.json에 MCP 서버 등록
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const LEGACY_SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.local.json');
const MCP_CONFIG_FILE = path.join(os.homedir(), '.claude.json');

// Codex CLI (2026-07-09): hooks register in ~/.codex/hooks.json (same JSON shape as Claude)
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_HOOKS_FILE = path.join(CODEX_DIR, 'hooks.json');

// Gemini CLI (2026-07-10): hooks register inside ~/.gemini/settings.json under a "hooks" key
const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_SETTINGS_FILE = path.join(GEMINI_DIR, 'settings.json');

// Renamed to "passbaton" in v2.0.0 (2026-07-13). New installs write passbaton-hook-*,
// but installs from <=1.17.x wrote claude-hook-*, and both bin names still ship.
// Ownership matching must recognize BOTH prefixes, otherwise a v1 hook line would be
// treated as a user's own hook and we'd append a duplicate next to it.
const PKG_NAME = 'passbaton';
const LEGACY_PKG_NAME = 'claude-session-continuity-mcp';
const HOOK_PREFIX = 'passbaton-hook-';

/**
 * 훅 실행 명령을 만든다 (Codex / Gemini 용 — Claude Code 는 `claudeHookCommand`).
 *
 * 원래는 무조건 `npm exec -- <bin>` 이었다. 로컬 설치에서도 node_modules/.bin 을
 * 찾아주므로 경로 독립적이라는 이유였는데, **매 Edit/Write 마다 그 대가를 낸다.**
 * 실측(Windows, 5회 중앙값):
 *
 *   npm exec -- passbaton-hook-post-tool   1,357 ms
 *   passbaton-hook-post-tool (이름만)         125 ms   ← 10.9배
 *   node <절대 dist 경로>                      117 ms
 *
 * 그래서 **설치 시점에 이름이 PATH 에서 풀리는지 확인하고** 풀리면 이름만 쓴다.
 * ⚠ 둘 다 **훅을 띄우는 프로세스의 PATH** 에 기댄다 — Codex·Gemini 가 Windows 에서
 * 훅을 어떤 셸로 띄우는지 확인하지 못해서(PowerShell 이면 따옴표로 시작하는 절대 경로
 * 명령이 문자열 식이 된다) 이 둘은 바꾸지 않았다.
 */
export function hookCommand(name: string, bareResolves: boolean, extra = ''): string {
  const bin = `${HOOK_PREFIX}${name}${extra}`;
  return bareResolves ? bin : `npm exec -- ${bin}`;
}

/** 훅 이름 → dist/hooks 안의 스크립트 파일. */
export const HOOK_SCRIPTS: Readonly<Record<string, string>> = {
  'session-start': 'session-start.js',
  'user-prompt': 'user-prompt-submit.js',
  'post-tool': 'post-tool-use.js',
  'pre-compact': 'pre-compact.js',
  'session-end': 'session-end.js',
};

/**
 * 큰따옴표 하나로 감싸서 bash·sh·cmd 어디서나 글자 그대로 넘어가는 경로인가.
 * `"` 는 따옴표를 닫고, `$` `` ` `` 는 bash 가, `%` `!` 는 cmd 가 해석한다.
 */
export function isQuotablePath(p: string): boolean {
  return p.length > 0 && !/["$`%!\r\n]/.test(p);
}

/** Windows 경로를 셸에 넣을 형태로 — 백슬래시는 bash 에서 이스케이프로 읽힐 수 있다. */
export function toShellPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

/**
 * Claude Code 훅 명령: **설치 시점의 node 와 스크립트의 절대 경로.**
 *
 * 이름만·`npm exec` 는 훅을 띄우는 프로세스의 PATH 에 node/npm 이 있어야 돈다.
 * Node 를 처음 깔기 전부터 열려 있던 터미널·VS Code 에서 Claude Code 를 띄우면 그 PATH 가
 * 옛것이라 **훅이 매번 `npm: command not found` 로 죽는다** (2026-10-15 실측, 아래 표).
 * 절대 경로만 PATH 와 무관하게 돌았다:
 *
 *   PATH 에 있는 것      npm exec   이름만   node 절대 + 스크립트 절대
 *   둘 다 없음             127       127        0
 *   npm 전역 bin 만        127       127        —
 *   nodejs 만               0        127        —
 *
 * 대가: Node 를 옮기거나 지우면 이 줄이 깨진다. 그래서 `status` 가 그걸 잡고
 * `passbaton-hooks install` 을 다시 돌리면 현재 경로로 고쳐 쓴다(등록 수는 안 는다).
 * 경로에 따옴표로 못 감싸는 글자가 있으면 예전 `npm exec` 로 둔다 — 명령이 깨지는 것보다 낫다.
 */
export function claudeHookCommand(name: string, nodePath: string, hooksDir: string, extra = ''): string {
  const script = HOOK_SCRIPTS[name];
  if (script === undefined) throw new Error(`unknown hook: ${name}`);
  const node = toShellPath(nodePath);
  const file = toShellPath(path.join(hooksDir, script));
  if (!isQuotablePath(node) || !isQuotablePath(file)) return hookCommand(name, false, extra);
  return `"${node}" "${file}"${extra}`;
}

/**
 * Claude Code 가 `args`(**셸 없는 exec 형식**)를 아는 첫 판으로 잡은 값. 공식 2026-w20 요약
 * (v2.1.139→v2.1.142)에 「hook `args: string[]` exec form」 이 있다 — 개별 판이 적혀 있지 않아 끝값을 쓴다.
 */
export const CLAUDE_EXEC_FORM_MIN: readonly [number, number, number] = [2, 1, 142];

export function parseVersion(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
  }
  return true;
}

/**
 * exec 형식을 쓸 것인가. 설치된 Claude Code 가 **확인된 옛 판**일 때만 셸 형식으로 물러난다.
 * 판을 못 읽으면(데스크톱 앱만 · PATH 에 없음) exec — Claude Code 는 자동 갱신이 기본이다.
 */
export function chooseExecForm(claudeVersionOutput: string | null): boolean {
  const v = claudeVersionOutput === null ? null : parseVersion(claudeVersionOutput);
  return v === null || versionAtLeast(v, CLAUDE_EXEC_FORM_MIN);
}

function claudeVersionOutput(): string | null {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000, shell: false });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code 훅 항목 하나.
 *
 * **exec 형식**(`command` = node 절대 경로, `args` = [스크립트 절대 경로])이 기본이다 — Claude Code 가
 * 셸 없이 바로 띄우므로 Git Bash 든, Git Bash 가 없는 Windows 의 PowerShell 이든 같고,
 * 경로에 공백·특수문자가 있어도 따옴표가 필요 없다. ⚠ `command` 는 실제 실행 파일이어야 한다
 * (npm 의 `.cmd` shim 은 셸 없이 못 띄운다) — 그래서 shim 이 아니라 node 를 쓴다.
 * 옛 Claude Code(exec 형식 모름)에는 `claudeHookCommand` 의 셸 형식.
 */
export function claudeHookHandler(name: string, nodePath: string, hooksDir: string, execForm: boolean): HookHandler {
  const script = HOOK_SCRIPTS[name];
  if (script === undefined) throw new Error(`unknown hook: ${name}`);
  if (!execForm) return { type: 'command', command: claudeHookCommand(name, nodePath, hooksDir) };
  return { type: 'command', command: nodePath, args: [path.join(hooksDir, script)] };
}

/** 이 이름이 PATH 에서 실행 가능한가. 실패하면 false — 판정 불가는 안전한 쪽으로. */
export function binResolves(name: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(probe, [name], { stdio: 'ignore', shell: false }).status === 0;
  } catch {
    return false;
  }
}

const BARE_OK = binResolves(`${HOOK_PREFIX}session-start`);
const LEGACY_HOOK_PREFIX = 'claude-hook-';

const HOOK_NAMES = '(?:session-start|user-prompt|post-tool|pre-compact|session-end)';
const HOST_FLAG = '(?: --(?:codex|gemini))?';
/** 우리가 지금까지 써 온 모든 형태 — 이름만 · npm exec · npx · npx --no (v1). */
const OUR_BIN_COMMAND = new RegExp(
  `^(?:npm exec -- |npx --no |npx )?(?:${HOOK_PREFIX}|${LEGACY_HOOK_PREFIX})${HOOK_NAMES}${HOST_FLAG}$`,
);
const OUR_SCRIPT_FILE = /^(?:session-start|user-prompt-submit|post-tool-use|pre-compact|session-end)\.js$/;
const ABSOLUTE_COMMAND = /^"([^"]+)" "([^"]+)"( --(?:codex|gemini))?$/;

/** `"<node>" "<스크립트>"` 형태를 쪼갠다. 아니면 null. */
export function parseAbsoluteCommand(command: string): { node: string; script: string } | null {
  const m = ABSOLUTE_COMMAND.exec(command.trim());
  return m ? { node: m[1], script: m[2] } : null;
}

/**
 * 이 명령이 **우리가 쓴 줄**인가 (신·구 이름, 모든 실행 형태).
 *
 * ⛔ 「passbaton 이라는 글자가 들어 있다」 로 판정하지 않는다. 사용자가 우리 훅을 자기
 * 래퍼로 감싼 줄(`my-wrapper passbaton-hook-post-tool`)을 우리 것으로 보면 재설치가
 * 그 줄을 지운다. **명령 전체가 우리 형태와 정확히 맞을 때만** 우리 것이다.
 * 절대 경로 형태는 스크립트가 `<passbaton 또는 옛 이름 패키지>/dist/hooks/<훅>.js` 이거나
 * 지금 설치기 옆의 훅 디렉터리일 때만.
 */
export function isOurHookCommand(command?: string, ownHooksDir: string = __dirname): boolean {
  if (!command) return false;
  const c = command.trim();
  if (OUR_BIN_COMMAND.test(c)) return true;
  const abs = parseAbsoluteCommand(c);
  return abs !== null && isOurHookScript(abs.script, ownHooksDir);
}

/** 이 경로가 우리 훅 스크립트인가 — `<passbaton|옛 이름>/dist/hooks/<훅>.js` 이거나 지금 설치기 옆. */
export function isOurHookScript(script: string, ownHooksDir: string = __dirname): boolean {
  const parts = script.split(/[\\/]+/);
  const file = parts[parts.length - 1] ?? '';
  if (!OUR_SCRIPT_FILE.test(file)) return false;
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  if (norm(path.dirname(script)) === norm(ownHooksDir)) return true;
  const pkg = parts[parts.length - 4] ?? '';
  return parts[parts.length - 3] === 'dist' && parts[parts.length - 2] === 'hooks'
    && (pkg === PKG_NAME || pkg === LEGACY_PKG_NAME);
}

/**
 * 훅 항목 하나가 우리 것인가. exec 형식(`args` 있음)은 `command` 가 node 이고
 * `args` 가 우리 스크립트 하나일 때만 — 사용자가 node 로 자기 스크립트를 돌리는 줄은 남의 것이다.
 */
export function isOurHookHandler(h: HookHandler, ownHooksDir: string = __dirname): boolean {
  if (h.args !== undefined) {
    const args = h.args;
    if (typeof h.command !== 'string' || !Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') return false;
    return /^node(?:\.exe)?$/i.test(path.basename(h.command)) && isOurHookScript(args[0], ownHooksDir);
  }
  return isOurHookCommand(h.command, ownHooksDir);
}

type HookHandler = { command?: string; args?: unknown; [k: string]: unknown };
type HookEntry = { hooks?: HookHandler[]; matcher?: string; [k: string]: unknown };

/**
 * 한 이벤트의 항목들에서 **우리 줄만** 뺀다 (Claude·Codex 의 중첩 형태).
 *
 * 예전엔 항목 안에 우리 줄이 하나라도 있으면 **항목째** 지웠다 — 같은 항목에 넣어 둔
 * 사용자 훅이 같이 사라졌다. 이제는 그 줄만 빼고, 빈 항목만 지운다. 다른 필드·순서는 그대로.
 */
export function stripOurHooks(entries: HookEntry[], ownHooksDir?: string): { kept: HookEntry[]; removed: number } {
  let removed = 0;
  const kept: HookEntry[] = [];
  for (const entry of entries) {
    const handlers = Array.isArray(entry.hooks) ? entry.hooks : [];
    const others = handlers.filter(h => !isOurHookHandler(h, ownHooksDir));
    removed += handlers.length - others.length;
    if (others.length === handlers.length) kept.push(entry);
    else if (others.length > 0) kept.push({ ...entry, hooks: others });
  }
  return { kept, removed };
}

/**
 * 한 이벤트를 고친다: 우리 줄을 빼고 새 줄을 뒤에 붙인다(사용자 줄 먼저).
 * ⛔ **자동 설치(postinstall)는 이미 있는 우리 줄을 그대로 둔다** — 기존 설치자의 등록을
 * 소리 없이 일괄 변환하지 않는다. 바꾸는 것은 사용자가 직접 `install` 을 돌렸을 때뿐.
 */
export function mergeEvent(existing: HookEntry[], ours: HookEntry[], auto: boolean, ownHooksDir?: string): HookEntry[] {
  const { kept, removed } = stripOurHooks(existing, ownHooksDir);
  if (auto && removed > 0) return existing;
  return [...kept, ...ours];
}

/** JSON 설정 읽기 결과. 깨진 파일은 `invalid` — ⛔ 빈 설정으로 보고 덮어쓰지 않는다. */
export type JsonRead =
  | { state: 'missing' }
  | { state: 'ok'; data: Record<string, unknown> }
  | { state: 'invalid'; error: string };

export function readJsonFile(file: string): JsonRead {
  if (!fs.existsSync(file)) return { state: 'missing' };
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { state: 'invalid', error: 'top level is not a JSON object' };
    }
    return { state: 'ok', data: data as Record<string, unknown> };
  } catch (e) {
    return { state: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }
}

// 설치된 패키지 경로 찾기
function getPackagePath(): string {
  // 1. 글로벌 설치 확인
  const globalPath = path.dirname(process.argv[1]);
  if (fs.existsSync(path.join(globalPath, 'hooks'))) {
    return globalPath;
  }

  // 2. 로컬 node_modules 확인 (새 이름 우선, 1.x 설치는 옛 이름으로 폴백)
  let current = process.cwd();
  while (current !== path.parse(current).root) {
    for (const pkg of [PKG_NAME, LEGACY_PKG_NAME]) {
      const candidate = path.join(current, 'node_modules', pkg, 'dist', 'hooks');
      if (fs.existsSync(candidate)) {
        return path.join(current, 'node_modules', pkg, 'dist');
      }
    }
    current = path.dirname(current);
  }

  // 3. 현재 패키지 디렉토리 (ESM 호환)
  return path.dirname(__dirname);
}

function migrateLegacyHooks(): void {
  if (!fs.existsSync(LEGACY_SETTINGS_FILE)) return;

  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_SETTINGS_FILE, 'utf-8'));
    const legacyHooks = legacy.hooks;
    if (!legacyHooks) return;

    // Remove hooks from legacy file
    delete legacy.hooks;
    if (Object.keys(legacy).length === 0 || (Object.keys(legacy).length === 1 && legacy.permissions)) {
      // Only permissions left or empty - can clean up
      fs.writeFileSync(LEGACY_SETTINGS_FILE, JSON.stringify(legacy, null, 2));
    } else {
      fs.writeFileSync(LEGACY_SETTINGS_FILE, JSON.stringify(legacy, null, 2));
    }

    console.log('🔄 Migrated hooks from settings.local.json → settings.json');
  } catch {
    // Ignore migration errors
  }
}

/** 설치를 멈춰야 하는 실패. 메시지는 사용자에게 그대로 보인다. */
class InstallError extends Error {}

/** Claude 설정을 읽는다. 깨져 있으면 **멈춘다** — 예전엔 `{}` 로 보고 사용자 설정 전체를 덮어썼다. */
function loadSettings(): Record<string, unknown> {
  const r = readJsonFile(SETTINGS_FILE);
  if (r.state === 'invalid') {
    throw new InstallError(`${SETTINGS_FILE} is not valid JSON (${r.error}) — left untouched. Fix it, then run: passbaton-hooks install`);
  }
  return r.state === 'ok' ? r.data : {};
}

function saveSettings(settings: Record<string, unknown>): void {
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** 이 설치의 MCP 서버 항목 — PATH 의 `npx` 대신 node·서버 스크립트 절대 경로 (JSON 값이라 따옴표 없음). */
export function mcpServerEntry(nodePath: string, distDir: string): { command: string; args: string[] } {
  return { command: nodePath, args: [path.join(distDir, 'index.js')] };
}

/**
 * MCP 서버 항목이 **우리가 쓴 것**인가. `npx [-y] passbaton[@ver]`(옛 이름 포함) 또는
 * `<node> <passbaton>/dist/index.js`. 이름이 같아도 남의 서버면 건드리지 않는다.
 */
export function isOurMcpEntry(entry: unknown, ownDistDir: string = path.dirname(__dirname)): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || !Array.isArray(args) || !args.every(a => typeof a === 'string')) return false;
  const a = args as string[];
  const isPkg = (s: string) => new RegExp(`^(?:${PKG_NAME}|${LEGACY_PKG_NAME})(?:@[^\\s]+)?$`).test(s);
  if (/^npx(?:\.cmd)?$/i.test(path.basename(command))) {
    const rest = a.filter(x => x !== '-y' && x !== '--yes');
    return rest.length === 1 && isPkg(rest[0]);
  }
  if (a.length !== 1) return false;
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  if (norm(a[0]) === norm(path.join(ownDistDir, 'index.js'))) return true;
  const parts = a[0].split(/[\\/]+/);
  return parts[parts.length - 1] === 'index.js' && parts[parts.length - 2] === 'dist'
    && (parts[parts.length - 3] === PKG_NAME || parts[parts.length - 3] === LEGACY_PKG_NAME);
}

/**
 * `~/.claude.json` 의 사용자 범위에 MCP 서버를 등록한다.
 *
 * - 없으면 절대 경로 항목으로 추가
 * - 우리 항목이 있으면: 자동 설치(postinstall)는 **그대로 둔다**, 명시적 `install` 은 지금 경로로 고쳐 쓴다
 * - 같은 이름의 남의 항목이면 건드리지 않는다
 * ⛔ 레포의 `.mcp.json`(남과 공유)은 쓰지 않는다 — 내 PC 의 절대 경로가 퍼진다.
 */
function installMcpServer(auto: boolean): void {
  const r = readJsonFile(MCP_CONFIG_FILE);
  if (r.state === 'invalid') {
    throw new InstallError(`${MCP_CONFIG_FILE} is not valid JSON (${r.error}) — left untouched`);
  }
  const config = r.state === 'ok' ? r.data : {};
  const mcpServers = (config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers : {}) as Record<string, unknown>;
  const existing = mcpServers['project-manager'];

  if (existing !== undefined && !isOurMcpEntry(existing)) {
    console.log('   ⚠️ "project-manager" in ~/.claude.json is not a passbaton entry — left untouched');
    return;
  }
  if (existing !== undefined && auto) {
    console.log('   MCP server already registered (left as is — run `passbaton-hooks install` to rewrite it)');
    return;
  }

  mcpServers['project-manager'] = mcpServerEntry(process.execPath, path.dirname(__dirname));
  config.mcpServers = mcpServers;
  fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`✅ MCP server ${existing === undefined ? 'registered' : 'rewritten'} in ~/.claude.json (absolute node path)`);
}

/**
 * Register the same hooks in ~/.codex/hooks.json for OpenAI Codex CLI (2026-07-09).
 * Only runs if ~/.codex exists (Codex installed). Preserves user's existing hooks;
 * replaces only ours (matched by the claude-hook- command prefix).
 */
function installCodexHooks(auto: boolean): void {
  if (!fs.existsSync(CODEX_DIR)) return;  // Codex not installed -> skip silently

  const r = readJsonFile(CODEX_HOOKS_FILE);
  if (r.state === 'invalid') {
    console.error(`⚠️ ${CODEX_HOOKS_FILE} is not valid JSON (${r.error}) — Codex hooks skipped, file left untouched`);
    return;
  }
  const hooksConfig = (r.state === 'ok' ? r.data : { hooks: {} }) as { hooks?: Record<string, unknown[]> };
  const hooks = hooksConfig.hooks || {};

  const merge = (event: string, ourEntries: HookEntry[]): void => {
    hooks[event] = mergeEvent((hooks[event] || []) as HookEntry[], ourEntries, auto);
  };

  // Codex uses the same event names as Claude (SessionStart/UserPromptSubmit/Stop...).
  // Append "--codex" so hooks detect the host reliably: Codex passes transcript_path
  // as null at SessionStart, so the argv marker is the only dependable signal.
  merge('SessionStart', [{ hooks: [{ type: 'command', command: `${hookCommand('session-start', BARE_OK, ' --codex')}` }] }]);
  merge('UserPromptSubmit', [{ hooks: [{ type: 'command', command: `${hookCommand('user-prompt', BARE_OK, ' --codex')}` }] }]);
  merge('PreCompact', [{ hooks: [{ type: 'command', command: `${hookCommand('pre-compact', BARE_OK, ' --codex')}` }] }]);
  merge('Stop', [{ hooks: [{ type: 'command', command: `${hookCommand('session-end', BARE_OK, ' --codex')}` }] }]);

  hooksConfig.hooks = hooks;
  try {
    fs.writeFileSync(CODEX_HOOKS_FILE, JSON.stringify(hooksConfig, null, 2));
    console.log('✅ Codex CLI hooks installed (~/.codex/hooks.json)');
  } catch { /* non-fatal: Codex hooks are optional */ }
}

/**
 * Register the same hooks in ~/.gemini/settings.json for Gemini CLI (2026-07-10).
 * Only runs if ~/.gemini exists. Hooks live under a "hooks" key inside settings.json
 * (not a separate file). Preserves the user's other settings and their own hooks;
 * replaces only ours (matched by the claude-hook- command prefix).
 * Gemini event names differ: BeforeAgent (≈UserPromptSubmit), PreCompress (≈PreCompact),
 * SessionEnd (≈Stop). transcript_path can be null at SessionStart, so we inject "--gemini".
 */
function installGeminiHooks(auto: boolean): void {
  if (!fs.existsSync(GEMINI_DIR)) return;  // Gemini not installed -> skip silently

  const r = readJsonFile(GEMINI_SETTINGS_FILE);
  if (r.state === 'invalid') {
    console.error(`⚠️ ${GEMINI_SETTINGS_FILE} is not valid JSON (${r.error}) — Gemini hooks skipped, file left untouched`);
    return;
  }
  const settings = (r.state === 'ok' ? r.data : {}) as { hooks?: Record<string, unknown[]> };
  const hooks = settings.hooks || {};

  const merge = (event: string, ourEntries: unknown[]): void => {
    const existing = (hooks[event] || []) as Array<{ command?: string }>;
    const userEntries = existing.filter(e => !isOurHookCommand(e.command));
    if (auto && userEntries.length < existing.length) return;  // 자동 설치는 기존 우리 줄을 그대로 둔다
    hooks[event] = [...userEntries, ...ourEntries];
  };

  // Gemini hook entries are flat {type, command} (no nested "hooks" array like Claude/Codex).
  merge('SessionStart', [{ type: 'command', command: `${hookCommand('session-start', BARE_OK, ' --gemini')}` }]);
  merge('BeforeAgent', [{ type: 'command', command: `${hookCommand('user-prompt', BARE_OK, ' --gemini')}` }]);
  merge('PreCompress', [{ type: 'command', command: `${hookCommand('pre-compact', BARE_OK, ' --gemini')}` }]);
  merge('SessionEnd', [{ type: 'command', command: `${hookCommand('session-end', BARE_OK, ' --gemini')}` }]);

  settings.hooks = hooks;
  try {
    fs.writeFileSync(GEMINI_SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log('✅ Gemini CLI hooks installed (~/.gemini/settings.json)');
  } catch { /* non-fatal: Gemini hooks are optional */ }
}

/**
 * 훅이 「npm/node: command not found」 로 죽을 때 사용자에게 줄 안내 (Astra P1 B 로 고정한 문구).
 * ⛔ postinstall 출력은 npm 7+ 에서 기본으로 숨는다 — 이 안내의 정본은 README 이고, 여기는 보조다.
 */
export const RESTART_HINT = [
  'If Claude Code was already open before Node.js was installed, fully quit the app that launched it',
  '(VS Code, your terminal app) and start it again, then start Claude Code. Opening a new tab or window',
  'in the same app can keep the old PATH. No reboot is needed for this.',
];

function install(auto: boolean): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   passbaton - Installation                                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // ===== 0. Migrate from settings.local.json if needed =====
  migrateLegacyHooks();

  // ===== 1. Hooks — Claude Code 는 node·스크립트 절대 경로, 가능하면 셸 없는 exec 형식 (claudeHookHandler 주석) =====
  console.log('📌 Step 1: Installing Hooks...');

  const settings = loadSettings();
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? settings.hooks : {}) as Record<string, HookEntry[]>;
  const node = process.execPath;
  const claudeVersion = claudeVersionOutput();
  const execForm = chooseExecForm(claudeVersion);
  const entry = (name: string, matcher?: string): HookEntry =>
    ({ ...(matcher ? { matcher } : {}), hooks: [claudeHookHandler(name, node, __dirname, execForm)] });
  console.log(`   form: ${execForm ? 'exec (no shell)' : 'shell'} — Claude Code ${claudeVersion?.trim() || 'version unknown'}`);

  const merge = (event: string, ours: HookEntry[]) => {
    hooks[event] = mergeEvent(hooks[event] || [], ours, auto);
  };
  merge('SessionStart', [entry('session-start')]);
  merge('UserPromptSubmit', [entry('user-prompt')]);
  merge('PostToolUse', [entry('post-tool', 'Edit'), entry('post-tool', 'Write')]);
  merge('PreCompact', [entry('pre-compact')]);
  merge('Stop', [entry('session-end')]);

  settings.hooks = hooks;
  saveSettings(settings);

  if (!execForm && parseAbsoluteCommand(claudeHookCommand('session-start', node, __dirname)) === null) {
    console.error('⚠️ Install path has characters that cannot be quoted safely for every shell — hooks use `npm exec` and need npm on PATH');
  }

  // Codex CLI hooks (2026-07-09): register the same hooks in ~/.codex/hooks.json
  // if Codex is present. Hooks auto-detect the host and emit the right output format.
  installCodexHooks(auto);

  // Gemini CLI hooks (2026-07-10): same, in ~/.gemini/settings.json if Gemini is present.
  installGeminiHooks(auto);

  console.log(`✅ Hooks ${auto ? 'checked' : 'installed'} in ~/.claude/settings.json`);
  if (auto) console.log('   (existing passbaton hook lines are kept as is — `passbaton-hooks install` rewrites them)');
  console.log('   SessionStart: context auto-load');
  console.log('   UserPromptSubmit: relevant memory injection');
  console.log('   PostToolUse: file change tracking (Edit, Write)');
  console.log('   PreCompact: save before context compression');
  console.log('   Stop: auto-save session on exit');
  console.log('');

  // ===== 2. MCP 서버 등록 =====
  console.log('📌 Step 2: Registering MCP Server...');
  installMcpServer(auto);
  console.log('');

  // ===== 완료 메시지 =====
  console.log('✅ Installation complete. Start a new Claude Code session to activate.');
  console.log('');
  for (const line of RESTART_HINT) console.log(`   ${line}`);
  console.log('   Check with: passbaton-hooks status');
  console.log('');
}

function uninstall(): void {
  console.log('🔧 Removing Claude Code Hooks...');

  const settings = loadSettings();
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? settings.hooks : {}) as Record<string, HookEntry[]>;

  // 각 이벤트에서 우리 줄만 제거, 사용자 훅은 보존 (신/구 이름·모든 실행 형태)
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop']) {
    const { kept } = stripOurHooks(hooks[event] || []);
    if (kept.length === 0) delete hooks[event]; else hooks[event] = kept;
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }

  saveSettings(settings);

  // Also remove our hooks from Codex (2026-07-09), preserving user's hooks.
  const codex = readJsonFile(CODEX_HOOKS_FILE);
  if (codex.state === 'invalid') console.error(`⚠️ ${CODEX_HOOKS_FILE} is not valid JSON — left untouched`);
  if (codex.state === 'ok') {
    try {
      const cfg = codex.data as { hooks?: Record<string, HookEntry[]> };
      const ch = cfg.hooks || {};
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']) {
        const { kept } = stripOurHooks(ch[event] || []);
        if (kept.length === 0) delete ch[event]; else ch[event] = kept;
      }
      cfg.hooks = ch;
      fs.writeFileSync(CODEX_HOOKS_FILE, JSON.stringify(cfg, null, 2));
    } catch { /* non-fatal */ }
  }

  // Also remove our hooks from Gemini (2026-07-10), preserving user's settings + hooks.
  const gemini = readJsonFile(GEMINI_SETTINGS_FILE);
  if (gemini.state === 'invalid') console.error(`⚠️ ${GEMINI_SETTINGS_FILE} is not valid JSON — left untouched`);
  if (gemini.state === 'ok') {
    try {
      const cfg = gemini.data as { hooks?: Record<string, unknown[]> };
      const gh = cfg.hooks || {};
      for (const event of ['SessionStart', 'BeforeAgent', 'PreCompress', 'SessionEnd']) {
        const existing = (gh[event] || []) as Array<{ command?: string }>;
        const remaining = existing.filter(e => !isOurHookCommand(e.command));
        if (remaining.length === 0) delete gh[event]; else gh[event] = remaining;
      }
      cfg.hooks = gh;
      fs.writeFileSync(GEMINI_SETTINGS_FILE, JSON.stringify(cfg, null, 2));
    } catch { /* non-fatal */ }
  }

  console.log('✅ Hooks removed successfully!');
}

/** PATH 에서 실행 파일을 찾는다 (Windows 는 PATHEXT 까지). 셸·프로세스를 띄우지 않는다. */
export function findOnPath(name: string, envPath: string = process.env.PATH ?? process.env.Path ?? '',
  platform: NodeJS.Platform = process.platform): string | null {
  const exts = platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())]
    : [''];
  for (const dir of envPath.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
    }
  }
  return null;
}

/** 이 node 실행 파일이 실제로 도는가 — `--version` 만 (부작용 없음). */
function nodeRuns(nodePath: string): boolean {
  try {
    const r = spawnSync(nodePath, ['--version'], { stdio: 'ignore', timeout: 10_000, shell: false });
    return r.status === 0;
  } catch {
    return false;
  }
}

export type HookCheck = { form: 'exec' | 'absolute' | 'npm-exec' | 'npx' | 'bare'; ok: boolean; detail: string };

/**
 * 등록된 우리 훅 명령 하나를 **지금 이 프로세스의 환경에서** 판정한다.
 * 「등록됨」 · 「찾을 수 있음」 · 「실행됨」 을 가른다 — bare shim 이 있어도 node 가 없으면 실패다.
 * ⛔ 훅 자체는 실행하지 않는다(세션 데이터를 바꾼다). node 는 `--version` 으로만 확인한다.
 */
/** 훅 항목 하나를 판정한다 — exec 형식(`args`)이면 node·스크립트를, 아니면 명령 문자열을. */
export function checkHookHandler(h: HookHandler, envPath?: string): HookCheck {
  if (Array.isArray(h.args) && typeof h.command === 'string' && typeof h.args[0] === 'string') {
    const node = h.command;
    const script = h.args[0];
    if (!fs.existsSync(node)) return { form: 'exec', ok: false, detail: `node not found: ${node}` };
    if (!fs.existsSync(script)) return { form: 'exec', ok: false, detail: `hook script not found: ${script}` };
    if (!nodeRuns(node)) return { form: 'exec', ok: false, detail: `node does not run: ${node}` };
    return { form: 'exec', ok: true, detail: 'node + script found, no shell, independent of PATH' };
  }
  return checkHookCommand(typeof h.command === 'string' ? h.command : '', envPath);
}

export function checkHookCommand(command: string, envPath?: string): HookCheck {
  const abs = parseAbsoluteCommand(command);
  if (abs) {
    if (!fs.existsSync(abs.node)) return { form: 'absolute', ok: false, detail: `node not found: ${abs.node}` };
    if (!fs.existsSync(abs.script)) return { form: 'absolute', ok: false, detail: `hook script not found: ${abs.script}` };
    if (!nodeRuns(abs.node)) return { form: 'absolute', ok: false, detail: `node does not run: ${abs.node}` };
    return { form: 'absolute', ok: true, detail: 'node + script found, independent of PATH' };
  }
  const c = command.trim();
  const nodeOnPath = findOnPath('node', envPath) !== null;
  if (c.startsWith('npm exec -- ') || c.startsWith('npx ')) {
    const form = c.startsWith('npm exec') ? 'npm-exec' : 'npx';
    const tool = form === 'npm-exec' ? 'npm' : 'npx';
    if (findOnPath(tool, envPath) === null) return { form, ok: false, detail: `${tool} not on PATH` };
    if (!nodeOnPath) return { form, ok: false, detail: 'node not on PATH' };
    return { form, ok: true, detail: `${tool} + node on PATH (depends on PATH)` };
  }
  const bin = c.split(' ')[0];
  if (findOnPath(bin, envPath) === null) return { form: 'bare', ok: false, detail: `${bin} not on PATH` };
  if (!nodeOnPath) return { form: 'bare', ok: false, detail: `${bin} found but node not on PATH` };
  return { form: 'bare', ok: true, detail: `${bin} + node on PATH (depends on PATH)` };
}

const EXPECTED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop'];

/**
 * 설치 스크립트가 있는 의존성 (이 판 기준 — npm 11.19 의 install-scripts 경고가 이 넷을 꼽았다).
 * npm v12 는 허용 목록 밖의 설치 스크립트를 기본으로 건너뛴다. README 의 설치 명령과 같은 목록이다.
 * ⚠ 의존성이 바뀌면 여기와 README 를 같이 고친다 — `scripts/verify-pack.mjs --strict` 가 어긋남을 잡는다.
 */
export const ALLOW_SCRIPTS = ['passbaton', 'better-sqlite3', 'sharp', 'protobufjs'] as const;

/** 이 설치의 better-sqlite3 가 실제로 열리는가 — 별도 프로세스에서 메모리 DB 하나만 (부작용 없음). */
function sqliteOpens(): { ok: boolean; detail: string } {
  const pkgRoot = path.resolve(__dirname, '..', '..');
  const code = "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get()";
  try {
    const r = spawnSync(process.execPath, ['-e', code], { cwd: pkgRoot, encoding: 'utf8', timeout: 20_000, shell: false });
    if (r.status === 0) return { ok: true, detail: 'opens' };
    const lines = (r.stderr || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const msg = lines.find(l => /Error:/.test(l)) ?? lines[0] ?? `exit ${r.status}`;
    return { ok: false, detail: `does not load: ${msg}` };
  } catch (e) {
    return { ok: false, detail: `does not load: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 문제가 있으면 false (CLI 종료 1). PATH 에 기대는 항목은 실패는 아니지만 고칠 방법을 같이 보인다. */
function status(): boolean {
  console.log('📊 passbaton status\n');
  console.log('⚠️ Checked with the PATH of THIS command. A Claude Code session that is already');
  console.log('   running may have a different (older) PATH — this cannot see it.\n');

  let healthy = true;
  let pathDependent = false;

  const r = readJsonFile(SETTINGS_FILE);
  if (r.state === 'invalid') {
    console.log(`❌ ${SETTINGS_FILE} is not valid JSON: ${r.error}`);
    return false;
  }
  const hooks = (r.state === 'ok' && r.data.hooks && typeof r.data.hooks === 'object'
    ? r.data.hooks : {}) as Record<string, HookEntry[]>;

  console.log('Claude Code hooks (~/.claude/settings.json):');
  for (const event of EXPECTED_EVENTS) {
    const ours = (hooks[event] || []).flatMap(e => (Array.isArray(e.hooks) ? e.hooks : []))
      .filter(h => isOurHookHandler(h));
    if (ours.length === 0) {
      console.log(`  ❌ ${event}: not registered`);
      healthy = false;
      continue;
    }
    for (const h of ours) {
      const chk = checkHookHandler(h);
      if (!chk.ok) healthy = false;
      if (chk.form !== 'absolute' && chk.form !== 'exec') pathDependent = true;
      console.log(`  ${chk.ok ? '✅' : '❌'} ${event} [${chk.form}] ${chk.detail}`);
      console.log(`      → ${Array.isArray(h.args) ? JSON.stringify({ command: h.command, args: h.args }) : String(h.command)}`);
    }
  }

  console.log('\nMCP server (~/.claude.json):');
  const m = readJsonFile(MCP_CONFIG_FILE);
  if (m.state === 'invalid') {
    console.log(`  ❌ ${MCP_CONFIG_FILE} is not valid JSON: ${m.error}`);
    healthy = false;
  } else {
    const data = m.state === 'ok' ? m.data : {};
    const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
    const user = servers['project-manager'];
    if (user === undefined) {
      console.log('  ❌ user scope "project-manager": not registered');
      healthy = false;
    } else if (!isOurMcpEntry(user)) {
      console.log('  ⚠️ user scope "project-manager": not a passbaton entry');
    } else {
      const e = user as { command: string; args: string[] };
      const isNpx = /^npx(?:\.cmd)?$/i.test(path.basename(e.command));
      const ok = isNpx
        ? findOnPath('npx') !== null
        : fs.existsSync(e.command) && fs.existsSync(e.args[0]) && nodeRuns(e.command);
      if (!ok) healthy = false;
      if (isNpx) pathDependent = true;
      console.log(`  ${ok ? '✅' : '❌'} user scope "project-manager" [${isNpx ? 'npx — depends on PATH' : 'absolute'}]`);
    }
    // local scope(~/.claude.json projects.<dir>.mcpServers) 는 같은 이름이면 user 보다 먼저 쓰인다 — 알리기만 한다.
    const projects = (data.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>;
    for (const [dir, proj] of Object.entries(projects)) {
      for (const [name, srv] of Object.entries(proj?.mcpServers ?? {})) {
        if (isOurMcpEntry(srv)) console.log(`  ℹ️ local scope "${name}" for ${dir} — used instead of user scope "${name}" there`);
      }
    }
  }
  const projectMcp = readJsonFile(path.join(process.cwd(), '.mcp.json'));
  if (projectMcp.state === 'ok') {
    for (const [name, srv] of Object.entries((projectMcp.data.mcpServers ?? {}) as Record<string, unknown>)) {
      if (isOurMcpEntry(srv)) {
        console.log(`  ℹ️ project scope "${name}" in ./.mcp.json — used instead of user scope "${name}" here (the installer never edits this file)`);
      }
    }
  }

  // ⚠ 등록·경로 검사만으로는 「설치 스크립트가 건너뛰어진 설치」 를 못 잡는다(npm v12 기본 차단 · --ignore-scripts).
  //   그때 가장 먼저 깨지는 것이 better-sqlite3 네이티브 바인딩이라 그것 하나는 실제로 연다. 다른 네이티브 의존성은 안 본다.
  console.log('\nNative module (this install):');
  const sqlite = sqliteOpens();
  if (!sqlite.ok) healthy = false;
  console.log(`  ${sqlite.ok ? '✅' : '❌'} better-sqlite3 ${sqlite.detail}`);
  console.log('  (other install-time steps of dependencies are not checked)');
  if (!sqlite.ok) {
    console.log(`  Fix: reinstall allowing install scripts — npm install -g passbaton --allow-scripts=${ALLOW_SCRIPTS.join(',')}`);
    console.log('       (re-running `passbaton-hooks install` does NOT rebuild this binding)');
  }

  console.log('');
  if (!healthy || pathDependent) {
    if (!healthy) console.log('Some checks failed.');
    if (pathDependent) console.log('Some entries depend on PATH — they fail when the app running Claude Code has an old PATH.');
    console.log('Fix:');
    console.log('  1. Run: passbaton-hooks install   (or: npx passbaton install) — rewrites passbaton entries with absolute paths');
    console.log('  2. Then restart the right way:');
    for (const line of RESTART_HINT) console.log(`     ${line}`);
  } else {
    console.log('✅ All passbaton hooks and the MCP server are independent of PATH.');
  }
  return healthy;
}

/**
 * 이 파일을 **직접 실행했을 때만** CLI 로 동작한다.
 *
 * 예전엔 이 스위치가 top-level 에 그냥 있어서 `import` 만 해도 install() 이 돌았다.
 * 즉 테스트가 이 모듈을 불러오는 순간 사용자의 ~/.claude/settings.json 과
 * ~/.claude.json 이 다시 쓰였다. 실제로 2026-09-07 에 그렇게 터졌다 — 결과가
 * 우연히 원하던 값이라 알아채기까지 한 단계 더 걸렸다.
 * postinstall 은 이 파일을 직접 실행하므로 동작에는 영향이 없다.
 */
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const command = args[0] || 'install';
  // postinstall 래퍼(scripts/postinstall.cjs)가 붙인다. 자동 설치는 기존 우리 줄을 바꾸지 않는다.
  const auto = process.env.PASSBATON_POSTINSTALL === '1';

  try {
    switch (command) {
      case 'install':
        install(auto);
        break;
      case 'uninstall':
      case 'remove':
        uninstall();
        break;
      case 'status':
        if (!status()) process.exitCode = 1;
        break;
      default:
        console.log('Usage: passbaton-hooks [install|uninstall|status]');
    }
  } catch (e) {
    // ⛔ 직접 실행한 install 이 실패하면 비0 으로 끝난다 — 「완료」 라고 말하지 않는다.
    //    postinstall 은 래퍼가 이 종료 코드를 경고 한 줄로 바꾸고 0 으로 끝낸다.
    console.error(`❌ passbaton ${command} failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
