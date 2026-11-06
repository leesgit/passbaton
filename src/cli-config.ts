/**
 * `passbaton config` CLI — view and toggle feature flags.
 *
 *   passbaton config                     print a grouped table of every feature + on/off
 *   passbaton config set <feature> on|off
 *   passbaton config preset <name>       minimal | default | everything
 *   passbaton config reset               delete the config file (→ defaults)
 *   passbaton config path                print the active config file path
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  FEATURE_DEFS,
  configPath,
  homeConfigPath,
  resolveFlags,
  invalidateConfigCache,
} from './utils/config.js';

// 2.9 (P4-100): 별도 사본을 버리고 훅·서버와 같은 판정기를 쓴다(홈 경계·레포 경계가 사본에는 없었다)
import { detectWorkspaceRoot } from './utils/workspace.js';

interface ConfigFile {
  version?: number;
  preset?: string | null;
  features?: Record<string, { enabled: boolean; desc?: string }>;
}

function readConfig(p: string): ConfigFile {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return { version: 1, preset: 'default', features: {} }; }
}

function writeConfig(p: string, cfg: ConfigFile): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  invalidateConfigCache();
}

function printTable(workspaceRoot: string): void {
  const flags = resolveFlags(workspaceRoot);
  const active = configPath(workspaceRoot);
  const exists = fs.existsSync(active);
  const preset = exists ? (readConfig(active).preset ?? 'custom') : 'default (no file)';

  console.log(`passbaton — config: ${active} (preset: ${preset})\n`);

  const groups: Record<string, string> = { core: 'CORE', 'cross-agent': 'CROSS-AGENT', experimental: 'EXPERIMENTAL' };
  for (const [g, label] of Object.entries(groups)) {
    const keys = Object.entries(FEATURE_DEFS).filter(([, d]) => d.group === g).map(([k]) => k);
    if (keys.length === 0) continue;
    console.log(label);
    for (const k of keys) {
      const on = flags[k];
      const wired = FEATURE_DEFS[k].configurable !== false;
      // Unwired flags aren't user-toggleable — show a neutral marker + fixed state
      // instead of ●/○ so `config set` on them doesn't look effective.
      const dot = !wired ? '·' : on ? '●' : '○';
      const state = !wired ? '—  ' : on ? 'on ' : 'off';
      console.log(`  ${dot} ${k.padEnd(20)} ${state}  ${FEATURE_DEFS[k].desc}`);
    }
    console.log('');
  }
  console.log('  ●=on ○=off ·=always on (not a config toggle)');
  console.log('  passbaton config set <feature> on|off   ·   passbaton config preset <minimal|default|everything>');
}

export function runConfigCli(args: string[]): number {
  const workspaceRoot = detectWorkspaceRoot(process.cwd());
  const sub = args[0];

  if (!sub) { printTable(workspaceRoot); return 0; }

  if (sub === 'path') { console.log(configPath(workspaceRoot)); return 0; }

  if (sub === 'reset') {
    const p = homeConfigPath();
    try { fs.unlinkSync(p); console.log(`Removed ${p} — features back to defaults.`); }
    catch { console.log('No config file to remove — already at defaults.'); }
    invalidateConfigCache();
    return 0;
  }

  if (sub === 'preset') {
    const name = args[1];
    if (!['minimal', 'default', 'everything'].includes(name ?? '')) {
      console.error('Usage: passbaton config preset <minimal|default|everything>');
      return 1;
    }
    const p = homeConfigPath();
    const cfg = readConfig(p);
    cfg.version = 1;
    cfg.preset = name;
    cfg.features = {}; // preset replaces per-feature overrides
    writeConfig(p, cfg);
    console.log(`Preset set to "${name}". Run "passbaton config" to view.`);
    return 0;
  }

  if (sub === 'set') {
    const feature = args[1];
    const val = args[2];
    if (!feature || !FEATURE_DEFS[feature]) {
      console.error(`Unknown feature "${feature ?? ''}". Run "passbaton config" to see valid names.`);
      return 1;
    }
    if (FEATURE_DEFS[feature].configurable === false) {
      console.error(`"${feature}" is always on and not a config toggle (no hook reads it). ${FEATURE_DEFS[feature].desc}`);
      return 1;
    }
    if (val !== 'on' && val !== 'off') {
      console.error('Usage: passbaton config set <feature> on|off');
      return 1;
    }
    const p = homeConfigPath();
    const cfg = readConfig(p);
    cfg.version = 1;
    cfg.features = cfg.features ?? {};
    cfg.features[feature] = { enabled: val === 'on', desc: FEATURE_DEFS[feature].desc };
    cfg.preset = null; // an individual override means we're no longer on a named preset
    writeConfig(p, cfg);
    console.log(`${feature} → ${val}`);
    return 0;
  }

  console.error(`Unknown config command "${sub}". Try: (none) | set | preset | reset | path`);
  return 1;
}
