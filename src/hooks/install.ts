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
 * 훅 실행 명령을 만든다.
 *
 * 원래는 무조건 `npm exec -- <bin>` 이었다. 로컬 설치에서도 node_modules/.bin 을
 * 찾아주므로 경로 독립적이라는 이유였는데, **매 Edit/Write 마다 그 대가를 낸다.**
 * 실측(Windows, 5회 중앙값):
 *
 *   npm exec -- passbaton-hook-post-tool   1,357 ms
 *   passbaton-hook-post-tool (이름만)         125 ms   ← 10.9배
 *   node <절대 dist 경로>                      117 ms   (경로가 박혀 취약)
 *
 * 그래서 **설치 시점에 이름이 PATH 에서 풀리는지 확인하고**(전역 설치의 정상 상태)
 * 풀리면 이름만 쓴다. 안 풀리면 예전 그대로 `npm exec` — 즉 최악이어도 현상 유지다.
 * 절대경로는 쓰지 않는다: 설치 위치가 바뀌면 조용히 깨진다.
 */
export function hookCommand(name: string, bareResolves: boolean, extra = ''): string {
  const bin = `${HOOK_PREFIX}${name}${extra}`;
  return bareResolves ? bin : `npm exec -- ${bin}`;
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

/** True if this command string is one of ours (current or legacy naming). */
export function isOurHookCommand(command?: string): boolean {
  if (!command) return false;
  return command.includes(HOOK_PREFIX) || command.includes(LEGACY_HOOK_PREFIX);
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

function loadSettings(): Record<string, unknown> {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings: Record<string, unknown>): void {
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function loadMcpConfig(): Record<string, unknown> {
  if (!fs.existsSync(MCP_CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMcpConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2));
}

function installMcpServer(): boolean {
  console.log('🔧 Registering MCP server...');

  try {
    const config = loadMcpConfig();
    const mcpServers = (config.mcpServers as Record<string, unknown>) || {};

    // 이미 등록되어 있으면 스킵
    if (mcpServers['project-manager']) {
      console.log('   MCP server already registered');
      return true;
    }

    // MCP 서버 등록
    mcpServers['project-manager'] = {
      command: 'npx',
      args: [PKG_NAME]
    };

    config.mcpServers = mcpServers;
    saveMcpConfig(config);

    console.log('✅ MCP server registered in ~/.claude.json');
    return true;
  } catch (error) {
    console.error('⚠️ Failed to register MCP server:', error);
    console.log('   You can manually add to ~/.claude.json:');
    console.log('   {');
    console.log('     "mcpServers": {');
    console.log('       "project-manager": {');
    console.log('         "command": "npx",');
    console.log(`         "args": ["${PKG_NAME}"]`);
    console.log('       }');
    console.log('     }');
    console.log('   }');
    return false;
  }
}

/**
 * Register the same hooks in ~/.codex/hooks.json for OpenAI Codex CLI (2026-07-09).
 * Only runs if ~/.codex exists (Codex installed). Preserves user's existing hooks;
 * replaces only ours (matched by the claude-hook- command prefix).
 */
function installCodexHooks(): void {
  if (!fs.existsSync(CODEX_DIR)) return;  // Codex not installed -> skip silently

  let hooksConfig: { hooks?: Record<string, unknown[]> } = { hooks: {} };
  if (fs.existsSync(CODEX_HOOKS_FILE)) {
    try { hooksConfig = JSON.parse(fs.readFileSync(CODEX_HOOKS_FILE, 'utf-8')); }
    catch { hooksConfig = { hooks: {} }; }
  }
  const hooks = hooksConfig.hooks || {};

  const merge = (event: string, ourEntries: unknown[]): void => {
    const existing = (hooks[event] || []) as Array<{ hooks?: Array<{ command?: string }> }>;
    const userEntries = existing.filter(e =>
      !(e.hooks || []).some(h => isOurHookCommand(h.command)));
    hooks[event] = [...userEntries, ...ourEntries];
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
function installGeminiHooks(): void {
  if (!fs.existsSync(GEMINI_DIR)) return;  // Gemini not installed -> skip silently

  let settings: { hooks?: Record<string, unknown[]> } = {};
  if (fs.existsSync(GEMINI_SETTINGS_FILE)) {
    try { settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_FILE, 'utf-8')); }
    catch { settings = {}; }
  }
  const hooks = settings.hooks || {};

  const merge = (event: string, ourEntries: unknown[]): void => {
    const existing = (hooks[event] || []) as Array<{ command?: string }>;
    const userEntries = existing.filter(e => !isOurHookCommand(e.command));
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

function install(): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Claude Session Continuity MCP - Installation             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // ===== 0. Migrate from settings.local.json if needed =====
  migrateLegacyHooks();

  // ===== 1. Hooks 설치 (이름 해석 가능하면 직접 실행, 아니면 npm exec) =====
  console.log(`📌 Step 1: Installing Hooks (${BARE_OK ? 'direct bin' : 'npm exec'} mode)...`);

  const settings = loadSettings();

  // 기존 hooks 유지하면서 우리 훅만 추가/교체
  const hooks = (settings.hooks as Record<string, unknown[]>) || {};

  /**
   * 기존 훅 배열에서 우리 훅만 제거하고, 새 훅을 추가
   * 사용자 커스텀 훅은 보존됨 (우리 훅 판별 = isOurHookCommand, 신/구 이름 모두 인식)
   */
  function mergeHooks(event: string, ourEntries: unknown[]): void {
    const existing = (hooks[event] || []) as Array<{ hooks?: Array<{ command?: string }>; matcher?: string }>;

    // 기존 항목 중 우리 훅이 아닌 것만 보존
    const userEntries = existing.filter(entry => {
      const cmds = entry.hooks || [];
      return !cmds.some(h => isOurHookCommand(h.command));
    });

    // 사용자 훅 먼저, 우리 훅 뒤에 추가
    hooks[event] = [...userEntries, ...ourEntries];
  }

  mergeHooks('SessionStart', [
    { hooks: [{ type: 'command', command: `${hookCommand('session-start', BARE_OK)}` }] }
  ]);

  mergeHooks('UserPromptSubmit', [
    { hooks: [{ type: 'command', command: `${hookCommand('user-prompt', BARE_OK)}` }] }
  ]);

  mergeHooks('PostToolUse', [
    { matcher: 'Edit', hooks: [{ type: 'command', command: `${hookCommand('post-tool', BARE_OK)}` }] },
    { matcher: 'Write', hooks: [{ type: 'command', command: `${hookCommand('post-tool', BARE_OK)}` }] }
  ]);

  mergeHooks('PreCompact', [
    { hooks: [{ type: 'command', command: `${hookCommand('pre-compact', BARE_OK)}` }] }
  ]);

  mergeHooks('Stop', [
    { hooks: [{ type: 'command', command: `${hookCommand('session-end', BARE_OK)}` }] }
  ]);

  settings.hooks = hooks;
  saveSettings(settings);

  // Codex CLI hooks (2026-07-09): register the same hooks in ~/.codex/hooks.json
  // if Codex is present. Hooks auto-detect the host and emit the right output format.
  installCodexHooks();

  // Gemini CLI hooks (2026-07-10): same, in ~/.gemini/settings.json if Gemini is present.
  installGeminiHooks();

  console.log(`✅ Hooks installed (${BARE_OK ? 'direct bin — ~10x faster per fire' : 'npm exec — bin not on PATH'})`);
  console.log('   SessionStart: context auto-load');
  console.log('   UserPromptSubmit: relevant memory injection');
  console.log('   PostToolUse: file change tracking (Edit, Write)');
  console.log('   PreCompact: save before context compression');
  console.log('   Stop: auto-save session on exit');
  console.log('');

  // ===== 2. MCP 서버 등록 =====
  console.log('📌 Step 2: Registering MCP Server...');
  installMcpServer();
  console.log('');

  // ===== 완료 메시지 =====
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   ✅ Installation Complete!                                ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║                                                            ║');
  console.log('║   🚀 Restart Claude Code to activate:                      ║');
  console.log('║      - 24 MCP tools (session_start, memory_store, etc.)    ║');
  console.log('║      - Auto context injection on session start             ║');
  console.log('║                                                            ║');
  console.log('║   📖 Quick Start:                                          ║');
  console.log('║      1. Start a new Claude Code session                    ║');
  console.log('║      2. Context will be auto-injected                      ║');
  console.log('║      3. Use session_end to save context                    ║');
  console.log('║                                                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
}

function uninstall(): void {
  console.log('🔧 Removing Claude Code Hooks...');

  const settings = loadSettings();
  const hooks = (settings.hooks as Record<string, unknown[]>) || {};

  // 각 이벤트에서 우리 훅만 제거, 사용자 훅은 보존 (신/구 이름 모두 제거)
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop']) {
    const existing = (hooks[event] || []) as Array<{ hooks?: Array<{ command?: string }> }>;
    const remaining = existing.filter(entry => {
      const cmds = entry.hooks || [];
      return !cmds.some(h => isOurHookCommand(h.command));
    });

    if (remaining.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = remaining;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }

  saveSettings(settings);

  // Also remove our hooks from Codex (2026-07-09), preserving user's hooks.
  if (fs.existsSync(CODEX_HOOKS_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CODEX_HOOKS_FILE, 'utf-8')) as { hooks?: Record<string, unknown[]> };
      const ch = cfg.hooks || {};
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']) {
        const existing = (ch[event] || []) as Array<{ hooks?: Array<{ command?: string }> }>;
        const remaining = existing.filter(e => !(e.hooks || []).some(h => isOurHookCommand(h.command)));
        if (remaining.length === 0) delete ch[event]; else ch[event] = remaining;
      }
      cfg.hooks = ch;
      fs.writeFileSync(CODEX_HOOKS_FILE, JSON.stringify(cfg, null, 2));
    } catch { /* non-fatal */ }
  }

  // Also remove our hooks from Gemini (2026-07-10), preserving user's settings + hooks.
  if (fs.existsSync(GEMINI_SETTINGS_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_FILE, 'utf-8')) as { hooks?: Record<string, unknown[]> };
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

function status(): void {
  console.log('📊 Claude Code Hooks Status\n');

  if (!fs.existsSync(SETTINGS_FILE)) {
    console.log('❌ No hooks configured');
    return;
  }

  const settings = loadSettings();
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;

  if (!hooks) {
    console.log('❌ No hooks configured');
    return;
  }

  console.log('Configured hooks:');
  for (const [event, hookList] of Object.entries(hooks)) {
    console.log(`  ${event}:`);
    for (const hook of hookList as Array<{ hooks: Array<{ command: string }> }>) {
      for (const h of hook.hooks || []) {
        console.log(`    → ${h.command}`);
      }
    }
  }
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

  switch (command) {
    case 'install':
      install();
      break;
    case 'uninstall':
    case 'remove':
      uninstall();
      break;
    case 'status':
      status();
      break;
    default:
      console.log('Usage: npx passbaton-hooks [install|uninstall|status]');
  }
}
