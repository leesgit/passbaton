// Feature-toggle regression tests (audit-7 2026-07-20).
// Pins: (1) isEnabled source priority (env > config file > defaults),
//       (2) every FEATURE_DEF's configurable/wired contract stays honest,
//       (3) the two shipped toggles resolve correctly.
// Why: audit-7 found 10/15 flags were dead config (CLI claimed they were
// toggleable but no hook read them). These tests fail if that regresses.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FEATURE_DEFS,
  isEnabled,
  configPath,
  invalidateConfigCache,
} from '../src/utils/config.js';

// A workspace whose .claude/ we control. isEnabled resolves the project config
// first (workspaceRoot/.claude/passbaton.config.json), so a temp root isolates us.
let tmpRoot: string;

function writeConfig(features: Record<string, boolean>): void {
  const dir = path.join(tmpRoot, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const feat: Record<string, { enabled: boolean }> = {};
  for (const [k, v] of Object.entries(features)) feat[k] = { enabled: v };
  fs.writeFileSync(
    path.join(dir, 'passbaton.config.json'),
    JSON.stringify({ version: 1, preset: null, features: feat }, null, 2),
  );
  invalidateConfigCache();
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cfg-'));
  invalidateConfigCache();
});

afterEach(() => {
  // clean the env overrides these tests set
  delete process.env.PASSBATON_SOLUTIONCAPTURE;
  delete process.env.PASSBATON_STRICTSOLUTIONGATE;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  invalidateConfigCache();
});

describe('isEnabled — source priority', () => {
  it('returns FEATURE_DEFS default when no env and no config file', () => {
    // configPath falls back to the (real) home file if project has none; to keep
    // this deterministic we assert the SHIPPED default matches the def, which is
    // what a no-config user gets.
    expect(isEnabled('solutionCapture', tmpRoot)).toBe(FEATURE_DEFS.solutionCapture.enabled);
    expect(isEnabled('strictSolutionGate', tmpRoot)).toBe(FEATURE_DEFS.strictSolutionGate.enabled);
  });

  it('project config file overrides the default', () => {
    writeConfig({ solutionCapture: false });
    expect(isEnabled('solutionCapture', tmpRoot)).toBe(false);
    writeConfig({ solutionCapture: true });
    expect(isEnabled('solutionCapture', tmpRoot)).toBe(true);
  });

  it('env var wins over the config file', () => {
    writeConfig({ solutionCapture: false });
    process.env.PASSBATON_SOLUTIONCAPTURE = '1';
    expect(isEnabled('solutionCapture', tmpRoot)).toBe(true); // env beats file
    process.env.PASSBATON_SOLUTIONCAPTURE = '0';
    expect(isEnabled('solutionCapture', tmpRoot)).toBe(false);
  });

  it('accepts 1/true/on as truthy for env override', () => {
    for (const v of ['1', 'true', 'on']) {
      process.env.PASSBATON_STRICTSOLUTIONGATE = v;
      invalidateConfigCache();
      expect(isEnabled('strictSolutionGate', tmpRoot)).toBe(true);
    }
    for (const v of ['0', 'false', 'off', '']) {
      process.env.PASSBATON_STRICTSOLUTIONGATE = v;
      invalidateConfigCache();
      expect(isEnabled('strictSolutionGate', tmpRoot)).toBe(false);
    }
  });

  it('never throws on a malformed config file (falls back to defaults)', () => {
    const dir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'passbaton.config.json'), '{ not valid json');
    invalidateConfigCache();
    expect(() => isEnabled('solutionCapture', tmpRoot)).not.toThrow();
    expect(isEnabled('solutionCapture', tmpRoot)).toBe(FEATURE_DEFS.solutionCapture.enabled);
  });
});

describe('FEATURE_DEFS — wired/configurable honesty (audit-7 pin)', () => {
  // These are the flags a hook actually reads via isEnabled(). If you wire a new
  // flag, add it here AND drop its configurable:false. If you add a configurable
  // flag with no consumer, this list (and the CLI) will lie again.
  const WIRED = [
    'compactionHandover',
    'hotPathPrewarm',
    'verificationLedger',
    'solutionCapture',
    'strictSolutionGate',
    // 2026-09-07: src/utils/hook-trace.ts 가 isEnabled('hookTrace') 로 읽는다.
    'hookTrace',
  ];

  it('exactly the wired flags are user-configurable', () => {
    const configurable = Object.entries(FEATURE_DEFS)
      .filter(([, d]) => d.configurable !== false)
      .map(([k]) => k)
      .sort();
    expect(configurable).toEqual([...WIRED].sort());
  });

  it('every non-configurable flag is explicitly marked configurable:false', () => {
    for (const [k, d] of Object.entries(FEATURE_DEFS)) {
      if (!WIRED.includes(k)) {
        expect(d.configurable, `${k} should be configurable:false`).toBe(false);
      }
    }
  });

  it('shipped defaults match the backward-compat contract', () => {
    // solutionCapture on (v1 behavior), strictSolutionGate off (opt-in).
    expect(FEATURE_DEFS.solutionCapture.enabled).toBe(true);
    expect(FEATURE_DEFS.strictSolutionGate.enabled).toBe(false);
  });
});
