/**
 * 재개 사건 기록 — 최소 양식 (2.8 · Astra reply-170 PB170-100 · C9).
 *
 * 다른 후보(C1·C2·C7…)가 「재개를 낫게 했다」 고 말하려면 기준선이 있어야 한다. 그 기준선은 **자연 발생** 재개
 * (컴팩션·새 세션)마다 한 줄씩 쌓인다. 자동으로 아는 칸은 SessionStart 가 hook-trace 에 적고(`session-start:resume-event`),
 * 판정 칸은 사람·대화 세션이 근거와 함께 채운다. 양식·규칙의 정본은 docs/resume-events.md.
 *
 * ⛔ 계약:
 *   - 자동 칸(version·host·source·session·card·emitted_sha)은 **그 재개의 원장 줄과 결속**된다 — 같은 session·source 의
 *     `resume-event` 줄과 sha·card 가 다르면 기록을 받지 않는다(다른 빌드·다른 출력의 결과를 옮겨 붙이지 않는다).
 *   - 판정 없음 = `unjudged`. 판정했으면 판정자·근거가 있어야 한다.
 *   - 「나아짐(better)」 은 첫 행동이 **맞았을 때만**. 호출 0 으로 끝난 오행동은 효율 개선이 아니다.
 *   - 이 기록은 측정이다 — 통제된 컴팩션 시험(C7)은 표본으로 세지 않는다(`sample: natural` 만 집계).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { trace } from './hook-trace.js';

export function packageVersion(): string {
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** SessionStart 가 자동 칸을 원장에 남긴다(hookTrace 가 켜져 있을 때만 — trace 와 같은 스위치). */
export function traceResumeEvent(workspaceRoot: string, f: {
  project: string; host: string; source: string | undefined; session: string | undefined; card: string | undefined; emittedSha: string;
}): void {
  trace('session-start:resume-event', workspaceRoot, {
    project: f.project, version: packageVersion(), host: f.host, source: f.source ?? 'unknown',
    session: f.session, card: f.card ?? 'none', emitted_sha: f.emittedSha,
  });
}

export type ResumeEventRecord = {
  /** 자동 칸 — 원장 줄에서 옮긴다 */
  version: string; host: string; source: string; session: string; card: string; emitted_sha: string;
  /** 표본 종류 — natural(자연 발생)만 효과 집계에 들어간다 */
  sample: 'natural' | 'controlled';
  /** 판정 칸 — 사람·대화 세션 */
  first_action: string;
  calls_before_first_action: number | null;
  first_action_ok: 'yes' | 'no' | 'unjudged';
  verdict: 'better' | 'same' | 'worse' | 'unjudged';
  judge: 'human' | 'session' | null;
  evidence: string | null;
  requery_reason: string | null;
};

/** hook-trace.log 의 `key=value` 한 줄을 읽는다(trace 형식). */
function parseTraceLine(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

/** 기록의 문제 목록 — 비면 받는다. */
export function checkResumeEvent(rec: ResumeEventRecord, traceLog: string): string[] {
  const problems: string[] = [];
  const lines = traceLog.split(/\r?\n/).filter(l => l.includes('hook=session-start:resume-event')).map(parseTraceLine);
  const mine = lines.filter(l => l.session === rec.session && l.source === rec.source);
  if (mine.length === 0) problems.push('no resume-event trace line for this session/source');
  else if (!mine.some(l => l.emitted_sha === rec.emitted_sha && l.card === rec.card && l.version === rec.version && l.host === rec.host)) {
    problems.push('auto fields do not match the trace line (different build, output or card)');
  }
  if (rec.first_action_ok === 'unjudged' && rec.verdict !== 'unjudged') problems.push('verdict without judging the first action');
  if (rec.first_action_ok !== 'unjudged' && (!rec.judge || !rec.evidence?.trim())) problems.push('judged without judge and evidence');
  if (rec.verdict === 'better' && rec.first_action_ok !== 'yes') problems.push('better requires a correct first action (0 calls + wrong action is not an improvement)');
  if (rec.calls_before_first_action !== null && (!Number.isInteger(rec.calls_before_first_action) || rec.calls_before_first_action < 0)) {
    problems.push('calls_before_first_action must be a non-negative integer or null');
  }
  return problems;
}
