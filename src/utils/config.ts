/**
 * passbaton feature flags — control plane, separate from the data plane (sessions.db).
 *
 * Config lives in a plain JSON file so it survives a db reset, is `cat`-able and
 * `git diff`-able, and can be hand-edited. Resolution precedence (highest wins):
 *   env override  →  project .claude/passbaton.config.json  →  home ~/.claude/passbaton.config.json  →  DEFAULTS
 *
 * Every current v2.0.0 feature is seeded `true` in DEFAULTS, so a user with NO config
 * file keeps today's behavior (backward-compat contract). New/experimental features are
 * seeded `false` and only turn on via an explicit flag or preset "everything".
 *
 * A malformed config NEVER throws — it degrades to defaults. Hooks call this on every
 * event, and a broken config must not break a session (see the 18-day silent-exit incident).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface FeatureDef {
  enabled: boolean;
  desc: string;
  group: 'core' | 'cross-agent' | 'experimental';
  /**
   * Whether a hook actually reads this flag via isEnabled(). Only wired flags
   * are user-toggleable; unwired ones (hook existence is controlled by
   * settings.json, not config) render as "always on" and reject `config set`.
   * Omitted = true. Audited 2026-09-07: 6 wired, 10 unwired.
   */
  configurable?: boolean;
}

/**
 * The DEFAULTS map is the backward-compat contract.
 * - Everything shipping as of v2.0.0 = true (no-config users are unaffected).
 * - New/opinionated/noisy features = false (opt-in only).
 * Rule for ON-by-default: silent + safe + universally useful. Fails any → OFF.
 */
export const FEATURE_DEFS: Record<string, FeatureDef> = {
  // ── core: quiet, safe, universally-good → ON ──
  // NOTE: hook existence (sessionStart/sessionEnd) is controlled by settings.json,
  // not by config — these read no flag, so they are configurable:false ("always on").
  sessionStart:       { enabled: true,  desc: 'Inject prior session context on start (always on — remove the hook in settings.json to disable)', group: 'core', configurable: false },
  compactionHandover: { enabled: true,  desc: 'Preserve context across a pre-compact (headline feature)', group: 'core' },
  sessionEnd:         { enabled: true,  desc: 'Persist session state on stop (always on — remove the hook in settings.json to disable)', group: 'core', configurable: false },
  autoInject:         { enabled: true,  desc: 'Auto-surface relevant past memories at session start', group: 'core', configurable: false },
  taskTracking:       { enabled: true,  desc: 'Read/write the task list via MCP + hooks', group: 'core', configurable: false },
  hotPathPrewarm:     { enabled: true,  desc: 'Surface the files you most often edit in this project', group: 'core' },
  verificationLedger: { enabled: true,  desc: 'Warn on start if a recent session left the build red', group: 'core' },
  // ── cross-agent: works, but only matters to multi-CLI users ──
  crossAgentSync:     { enabled: true,  desc: 'Share one local db across Claude Code / Codex / Gemini (inherent — not a toggle)', group: 'cross-agent', configurable: false },
  postToolCapture:    { enabled: true,  desc: 'Observe tool use to build hot-paths (low-noise)', group: 'cross-agent', configurable: false },
  solutionCapture:    { enabled: true,  desc: 'Auto-record error→fix pairs to a solution archive (set off to skip)', group: 'cross-agent' },
  // ── experimental / polarizing → OFF ──
  // triggerMatching/patternMining/memoryAutoStore/statusLineInject read no flag yet
  // (designed-not-shipped) → configurable:false until a hook actually consumes them.
  triggerMatching:    { enabled: false, desc: 'Match prompt keywords to auto-inject solutions (not yet wired)', group: 'experimental', configurable: false },
  strictSolutionGate: { enabled: false, desc: 'Stricter error→fix capture filter — fewer noise entries, may drop some real ones', group: 'experimental' },
  patternMining:      { enabled: false, desc: 'Mine work patterns and suggest workflows (not yet wired)', group: 'experimental', configurable: false },
  memoryAutoStore:    { enabled: false, desc: 'Auto-write observation memories from prompts (not yet wired)', group: 'experimental', configurable: false },
  statusLineInject:   { enabled: false, desc: 'Append a passbaton status line to session-start output (not yet wired)', group: 'experimental', configurable: false },
  hookTrace:          { enabled: false, desc: 'Diagnostics: one line per SessionStart/PostToolUse fire to .claude/hook-trace.log (pid + resolved ws_root). Logs absolute paths; capped at 5MB', group: 'experimental' },
};

const DEFAULTS: Record<string, boolean> =
  Object.fromEntries(Object.entries(FEATURE_DEFS).map(([k, v]) => [k, v.enabled]));

const PRESETS: Record<string, (k: string) => boolean> = {
  minimal:    (k) => ['sessionStart', 'compactionHandover', 'sessionEnd'].includes(k),
  default:    (k) => DEFAULTS[k] ?? false,
  everything: () => true,
};

interface Cache { path: string; mtimeMs: number; flags: Record<string, boolean> }
let cache: Cache | null = null;

/** Resolve the active config file: project `.claude/` if present, else home `~/.claude/`. */
export function configPath(workspaceRoot: string): string {
  const proj = path.join(workspaceRoot, '.claude', 'passbaton.config.json');
  if (fs.existsSync(proj)) return proj;
  return path.join(os.homedir(), '.claude', 'passbaton.config.json');
}

/** Home config path — where `passbaton config set` writes by default. */
export function homeConfigPath(): string {
  return path.join(os.homedir(), '.claude', 'passbaton.config.json');
}

/**
 * Is a feature enabled? Cheap on the hot path: env check, then one statSync;
 * re-reads the file only when its mtime changes. Never throws.
 */
export function isEnabled(feature: string, workspaceRoot: string): boolean {
  // env override wins, cheapest check — e.g. PASSBATON_TRIGGERMATCHING=0
  const env = process.env[`PASSBATON_${feature.toUpperCase()}`];
  if (env != null) return env === '1' || env === 'true' || env === 'on';

  const p = configPath(workspaceRoot);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* no file → defaults */ }

  // Cache is keyed on BOTH path and mtime: a long-lived caller (e.g. MCP server loop)
  // may query different workspace roots, and two config files can share an mtimeMs.
  // Keying on mtime alone would return the first file's flags for the second path.
  if (!cache || cache.path !== p || cache.mtimeMs !== mtimeMs) {
    const flags = { ...DEFAULTS };
    if (mtimeMs) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
          preset?: string;
          features?: Record<string, { enabled?: boolean }>;
        };
        if (raw.preset && PRESETS[raw.preset]) {
          for (const k of Object.keys(flags)) flags[k] = PRESETS[raw.preset](k);
        }
        for (const [k, v] of Object.entries(raw.features ?? {})) {
          if (v && typeof v.enabled === 'boolean') flags[k] = v.enabled;
        }
      } catch { /* malformed → keep defaults, never throw in a hook */ }
    }
    cache = { path: p, mtimeMs, flags };
  }
  return cache.flags[feature] ?? DEFAULTS[feature] ?? false;
}

/** Force a re-read on next isEnabled() — used by the CLI after writing the file. */
export function invalidateConfigCache(): void { cache = null; }

/** Load the raw resolved flags (for `passbaton config` display). Never throws. */
export function resolveFlags(workspaceRoot: string): Record<string, boolean> {
  invalidateConfigCache();
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(FEATURE_DEFS)) out[k] = isEnabled(k, workspaceRoot);
  return out;
}
