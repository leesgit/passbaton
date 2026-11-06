// 2.10 — 선언된 실행 상태 원천(health) 표시 (Astra P5 reply-5 C5b · Ashfall P5-07)
//
// 계약: 생산자(프로젝트의 실행기·감시기)가 사실을 만들고 passbaton 은 표시만 한다 · 로그를 세지 않는다 · 낱말을 해석하지 않는다.
// 역검증(아래 기대값이 빨개져야 하는 결함): 정상 STOP 이 오래돼 STALE 경고 · 오래된 attention 을 현재 경고로 · 시계 역행을
// 정상으로 · 모순(attention+normal_stop)을 한쪽으로 · 원천 없음을 침묵 · 생산자가 안 한 경고를 실패 횟수로 지어냄.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildResumeCard, readContinuityDeclaration, parseHealth, healthLine } from '../src/utils/resume-card.js';

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function project(files: Record<string, string>, sources: unknown[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-210h-')));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources } }));
  return dir;
}

const NOW = Date.parse('2026-11-06T15:10:00+09:00');
const SRC = [{ path: '.ralph/health.json', label: '실행 상태', health: { maxAgeMinutes: 30 } }];
const H = (o: Record<string, unknown>) => JSON.stringify({ observed_at: '2026-11-06T15:08:00+09:00', state: 'progress', attention: false, normal_stop: false, ...o });
const card = (body: string | null, sources: unknown[] = SRC) =>
  buildResumeCard(project(body === null ? {} : { '.ralph/health.json': body }, sources), 3200, { now: NOW })!.text;

const STUCK = H({
  state: 'no_progress', attention: true, last_attempt: '2026-11-06T15:07:20+09:00',
  failure: { count: 132, first: '2026-11-06T05:03:25+09:00', last: '2026-11-06T15:07:51+09:00', text: "Output: timeout: failed to run command 'claude': Argument list too long" },
});

describe('2.10 health — display', () => {
  it('shows a stuck-but-alive run as needing attention with the repeat range', () => {
    const t = card(STUCK);
    expect(t).toContain('⚠ RUN NEEDS ATTENTION — state "no_progress" · no success recorded · last attempt 3m ago · same failure ×132 (2026-11-05T20:03Z → 2026-11-06T06:07Z): Output: timeout');
    expect(t).toContain('observed 2m ago');
    expect(t).not.toContain('"observed_at"');            // JSON 본문은 싣지 않는다
  });

  it('healthy run is a plain line, no warning, even with a past failure count (producer did not flag it)', () => {
    const t = card(H({ last_success: '2026-11-06T15:00:00+09:00', failure: { count: 2, first: '2026-11-06T14:00:00+09:00', last: '2026-11-06T14:01:00+09:00', text: 'transient' } }));
    expect(t).toContain('run health: state "progress" · last success 10m ago');
    expect(t).not.toContain('⚠ RUN');
  });

  it('normal STOP stays neutral even when observations stopped long ago', () => {
    const t = card(H({ state: 'stopped_normal', normal_stop: true, observed_at: '2026-11-05T15:00:00+09:00' }));
    expect(t).toContain('run health: stopped normally (state "stopped_normal") · observed 24.2h ago · no further observations expected');
    expect(t).not.toContain('⚠ RUN');
  });

  it('stale observation: last state is reported as past, current state unknown', () => {
    const t = card(H({ ...JSON.parse(STUCK), observed_at: '2026-11-06T13:00:00+09:00', last_attempt: '2026-11-06T12:59:00+09:00', failure: undefined }));
    expect(t).toContain('⚠ RUN HEALTH STALE — observed 2.2h ago (max 30m) · last state "no_progress" (needed attention then) · current state unknown');
    expect(t).not.toContain('RUN NEEDS ATTENTION');
  });

  it('clock: observation ahead of card time is unknown, not healthy', () => {
    expect(card(H({ observed_at: '2026-11-06T16:00:00+09:00' }))).toContain('⚠ RUN HEALTH UNKNOWN — observed_at 2026-11-06T16:00:00+09:00 is ahead of card time (clock?)');
  });

  it('clock: events after the observation or failure first > last are unknown', () => {
    expect(card(H({ last_success: '2026-11-06T15:30:00+09:00' }))).toContain('⚠ RUN HEALTH UNKNOWN — event times are inconsistent');
    expect(card(H({ failure: { count: 3, first: '2026-11-06T15:00:00+09:00', last: '2026-11-06T14:00:00+09:00', text: 'x' } }))).toContain('⚠ RUN HEALTH UNKNOWN — event times are inconsistent');
  });

  it('contradiction (attention + normal_stop) is unknown, neither warning nor normal', () => {
    const t = card(H({ attention: true, normal_stop: true }));
    expect(t).toContain('⚠ RUN HEALTH UNKNOWN — producer says both attention and normal_stop');
    expect(t).not.toContain('stopped normally');
  });

  it('missing source is unknown (also when optional)', () => {
    expect(card(null)).toContain('⚠ NOT READ (file not found)\n⚠ RUN HEALTH UNKNOWN — source not read');
    expect(card(null, [{ ...SRC[0], optional: true }])).toContain('file absent (optional source — not an error)\n⚠ RUN HEALTH UNKNOWN — source not read');
  });

  it('broken or offset-less producer files are unknown', () => {
    expect(card('{not json')).toContain('⚠ RUN HEALTH UNKNOWN — not valid JSON');
    expect(card(H({ observed_at: '2026-11-06 15:08:00' }))).toContain('⚠ RUN HEALTH UNKNOWN — observed_at missing or without a time zone offset');
    expect(card(JSON.stringify({ observed_at: '2026-11-06T15:08:00+09:00' }))).toContain('⚠ RUN HEALTH UNKNOWN — state missing');
    expect(card(H({ attention: 'yes' }))).toContain('⚠ RUN HEALTH UNKNOWN — attention is not a boolean');
  });
});

describe('2.10 health — declaration', () => {
  it('json is read only when health is declared', () => {
    const t = card(STUCK, [{ path: '.ralph/health.json' }]);
    expect(t).toContain('⚠ NOT READ (not a text source');
    expect(t).not.toContain('RUN');
  });

  it('bad health shape drops a .json source and says so', () => {
    const dir = project({ '.ralph/health.json': STUCK }, [{ path: '.ralph/health.json', health: true }]);
    const d = readContinuityDeclaration(dir);
    expect(d.sources).toHaveLength(0);
    expect(d.invalid[0]).toContain('health ignored');
  });

  it('undeclared card bytes do not change (no health key anywhere)', () => {
    const dir = project({ 'a.md': '# A\nbody\n' }, [{ path: 'a.md' }]);
    expect(buildResumeCard(dir, 3200, { now: NOW })!.text).toBe('## Resume card — repo source of truth (read this before the DB summary below)\n### a.md — `a.md:1-2` (of 2) · sha1 ' + buildResumeCard(dir, 3200)!.items[0].sha + '\n```\n# A\nbody\n```');
  });
});

describe('2.10 health — unit', () => {
  it('parseHealth keeps only checked fields; healthLine without facts is unknown', () => {
    const p = parseHealth(STUCK);
    expect(p.ok && p.facts.failure?.count).toBe(132);
    expect(healthLine(undefined, 30, NOW)).toBe('⚠ RUN HEALTH UNKNOWN — source not read');
  });
});
