// 2.8 — 주입 원장(N3)·재개 사건 기록 최소 양식(C9) (Astra reply-170 PB170-100)
//
// 계약(N3): 출력 조각마다 훅·프로젝트·원천 식별·**실제 출력 바이트**·생략 사유 · 추적 끄기 가능 · on/off 에서 모델 전달 본문 동일.
// 검사는 원장을 믿지 않고 **실제 stdout 에서 다시 잰다**: 원장의 at·bytes 로 본문을 잘라 sha 를 맞추고, 원장 조각이 덮지 못한
// 본문이 감싸개·공백뿐인지 본다 — 조각 누락·잘림 전 길이 기록·원천 바꿔치기는 각각 불일치로 드러난다.
// 계약(C9): 자동 칸은 그 재개의 원장 줄과 결속 · 판정은 판정자·근거와 함께 · 호출 0 인 오행동은 「나아짐」 이 아니다.
//
// ⚠ 격리: hookTrace 는 프로젝트 config 가 없으면 ~/.claude 설정으로 폴백한다 — 워크스페이스 config 에 on/off 를 명시한다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { checkResumeEvent, type ResumeEventRecord } from '../src/utils/resume-event.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const built = [SESSION_START, USER_PROMPT].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const sha12 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-28led-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), '# 최신 절\n- 다음 작업: N170-110 컴팩션 전달 확인\n- 정지: DEMO_STOP 유지\n');
  fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
    JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }] } }));
  setTrace(ws, false);
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}
function setTrace(ws: string, enabled: boolean): void {
  fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ features: { hookTrace: { enabled } } }));
}
function seed(dbPath: string): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES ('game', '미니맵 렌더러 깜빡임을 고쳤다 — 원장 시험 세션', datetime('now', '-1 hour'))").run();
  for (let i = 0; i < 4; i++) db.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES ('game', ?, datetime('now', ?))").run(`무관한 작업 ${i} 정리했다 — 원장 시험`, `-${2 + i} hours`);
  db.prepare("INSERT INTO active_context (project, current_state, blockers) VALUES ('game', '청크 경계 계산을 고쳤다 — 원장 시험 State', '셰이더 캐시 대기')").run();
  db.close();
}

function run(file: string, ws: string, payload: Record<string, unknown>, env: Record<string, string> = {}): string {
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws, ...env } });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

type Frag = { n: number; src: string; ids?: string; bytes: number; at: number; sha: string; in_body: string };
function ledger(ws: string, hook: string) {
  const p = path.join(ws, '.claude', 'hook-trace.log');
  const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/) : [];
  const kv = (l: string) => Object.fromEntries([...l.matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]]));
  const of = (kind: string) => lines.filter(l => l.includes(`hook=${hook}:${kind} `)).map(kv);
  return {
    frags: of('frag').map(f => ({ ...f, n: Number(f.n), bytes: Number(f.bytes), at: Number(f.at) }) as unknown as Frag),
    omits: of('omit'), emitted: of('emitted'), resume: of('resume-event'), raw: lines,
  };
}

/** 원장만으로 실제 본문을 다시 잰다 — 조각 sha 일치 + 덮지 못한 나머지가 허용된 감싸개뿐 */
function audit(body: Buffer, frags: Frag[], allowedRest: RegExp) {
  const covered = new Uint8Array(body.length);
  for (const f of frags) {
    expect(f.in_body, `${f.src} in body`).toBe('yes');
    expect(f.at, `${f.src} offset`).toBeGreaterThanOrEqual(0);
    const slice = body.subarray(f.at, f.at + f.bytes);
    expect(sha12(slice), `${f.src} bytes/sha match the emitted body`).toBe(f.sha);
    covered.fill(1, f.at, f.at + f.bytes);
  }
  const rest = Buffer.from(body.filter((_, i) => covered[i] === 0)).toString('utf8');
  expect(rest, 'every emitted byte outside the wrapper belongs to a ledgered fragment').toMatch(allowedRest);
}

describe.skipIf(!built)('PB170-100 N3 주입 원장 — SessionStart', () => {
  const SS_REST = /^\s*<session-context project="game">\s*<\/session-context>\s*$/;

  it('추적 on/off 에서 모델 전달 본문이 같다 · off 면 원장 없음', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'S0', source: 'startup' });   // DB 를 만든다
    seed(dbPath);
    const off1 = run(SESSION_START, ws, { cwd: proj, session_id: 'S1', source: 'compact' });
    expect(ledger(ws, 'session-start').frags).toEqual([]);
    setTrace(ws, true);
    const on = run(SESSION_START, ws, { cwd: proj, session_id: 'S1', source: 'compact' });
    setTrace(ws, false);
    const off2 = run(SESSION_START, ws, { cwd: proj, session_id: 'S1', source: 'compact' });
    expect(off2).toBe(off1);
    expect(on).toBe(off1);
    expect(on).toContain('N170-110 컴팩션 전달 확인');                       // 양성: 본문이 실제로 있다
  });

  it('조각마다 원천·실제 바이트 — 원장으로 본문을 다시 재면 sha 가 맞고, 덮지 못한 바이트는 감싸개뿐', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'S0', source: 'startup' });
    seed(dbPath);
    setTrace(ws, true);
    const out = Buffer.from(run(SESSION_START, ws, { cwd: proj, session_id: 'S1', source: 'compact' }).replace(/\r?\n$/, ''), 'utf8');
    const { frags, emitted } = ledger(ws, 'session-start');
    expect(frags.map(f => f.src)).toEqual(expect.arrayContaining(['header', 'card', 'state', 'recent-sessions', 'footer']));
    audit(out, frags, SS_REST);
    expect(emitted.at(-1)).toMatchObject({ project: 'game', bytes: String(out.length), sha: sha12(out) });
    // 원천 식별이 그 조각의 내용과 맞다(바꿔치기 검출)
    const bySrc = (s: string) => frags.find(f => f.src === s)!;
    const text = (f: Frag) => out.subarray(f.at, f.at + f.bytes).toString('utf8');
    expect(bySrc('card').ids).toMatch(/^docs\/HANDOFF\.md@[0-9a-f]+$/);
    expect(text(bySrc('card'))).toContain('N170-110');
    expect(bySrc('state').ids).toBe('active_context');
    expect(text(bySrc('state'))).toContain('원장 시험 State');
    expect(bySrc('recent-sessions').ids).toMatch(/^sessions:\d+(,\d+)*$/);
    expect(text(bySrc('recent-sessions'))).toContain('미니맵 렌더러 깜빡임');
  });

  it('생략 사유 — 예산이 모자라 빠진 조각은 omit 줄로 남는다(본문에는 없다)', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'S0', source: 'startup' });
    seed(dbPath);
    setTrace(ws, true);
    const out = run(SESSION_START, ws, { cwd: proj, session_id: 'S1', source: 'compact' }, { MCP_CONTEXT_BUDGET: '60' });
    const { omits, frags } = ledger(ws, 'session-start');
    expect(out).not.toContain('원장 시험 State');
    expect(omits).toEqual(expect.arrayContaining([expect.objectContaining({ src: 'state', reason: 'budget', ids: 'active_context' })]));
    expect(omits).toEqual(expect.arrayContaining([expect.objectContaining({ src: 'recovered', reason: 'no-handover-row' })]));
    expect(frags.find(f => f.src === 'state')).toBeUndefined();
  });
});

describe.skipIf(!built)('PB170-100 N3 주입 원장 — UserPromptSubmit', () => {
  it('past-context 조각: 원천 행 id · 실제 바이트 — 본문 전부가 원장 조각으로 덮인다 · on/off 동일', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'S0', source: 'startup' });
    seed(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const okId = (db.prepare("SELECT id FROM sessions WHERE last_work LIKE '미니맵 렌더러%'").get() as { id: number }).id;
    db.close();
    const payload = { cwd: proj, session_id: 'S1', prompt: '저번에 미니맵 렌더러 어떻게 고쳤지' };
    const off = run(USER_PROMPT, ws, payload);
    setTrace(ws, true);
    const on = run(USER_PROMPT, ws, payload);
    expect(on).toBe(off);
    const body = Buffer.from(on.replace(/\r?\n$/, ''), 'utf8');
    const { frags, emitted } = ledger(ws, 'user-prompt');
    expect(frags.map(f => f.src)).toEqual(['past-context']);
    expect(frags[0].ids).toBe(`s:${okId}`);
    audit(body, frags, /^$/);
    expect(emitted.at(-1)).toMatchObject({ bytes: String(body.length), sha: sha12(body) });
  });

  it('찾은 것이 없으면 조각 대신 생략 사유', () => {
    const { ws, proj } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'S0', source: 'startup' });
    setTrace(ws, true);
    const out = run(USER_PROMPT, ws, { cwd: proj, session_id: 'S1', prompt: '저번에 존재하지않는기능 어떻게 고쳤지' });
    expect(out).not.toContain('<past-context');
    const { frags, omits } = ledger(ws, 'user-prompt');
    expect(frags).toEqual([]);
    expect(omits).toEqual([expect.objectContaining({ src: 'past-context', reason: 'no-eligible-rows' })]);
  });
});

describe.skipIf(!built)('PB170-100 C9 재개 사건 기록 — 자동 칸 결속·판정 규칙', () => {
  function resumed() {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'S0', source: 'startup' });
    seed(dbPath);
    setTrace(ws, true);
    const out = run(SESSION_START, ws, { cwd: proj, session_id: 'S7', source: 'compact' });
    const log = fs.readFileSync(path.join(ws, '.claude', 'hook-trace.log'), 'utf8');
    const ev = ledger(ws, 'session-start').resume.at(-1)!;
    return { out, log, ev };
  }
  const judged = (ev: Record<string, string>, over: Partial<ResumeEventRecord> = {}): ResumeEventRecord => ({
    version: ev.version, host: ev.host, source: ev.source, session: ev.session, card: ev.card, emitted_sha: ev.emitted_sha,
    sample: 'natural', first_action: 'docs/HANDOFF.md 최신 절을 읽고 N170-110 을 이어감', calls_before_first_action: 1,
    first_action_ok: 'yes', verdict: 'same', judge: 'session', evidence: '카드 HANDOFF 절과 첫 도구 호출 대조', requery_reason: null, ...over,
  });

  it('자동 칸 = 이 재개의 실제 본문 sha · 카드 원천 · 버전 · 호스트 — 같은 값으로 채운 기록은 받는다', () => {
    const { out, log, ev } = resumed();
    expect(ev).toMatchObject({ project: 'game', host: 'claude', source: 'compact', session: 'S7' });
    expect(ev.emitted_sha).toBe(sha12(Buffer.from(out.replace(/\r?\n$/, ''), 'utf8')));
    expect(ev.card).toMatch(/^docs\/HANDOFF\.md@/);
    expect(ev.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(checkResumeEvent(judged(ev), log)).toEqual([]);
  });

  it('다른 출력·다른 빌드의 자동 칸은 결속 거부', () => {
    const { log, ev } = resumed();
    expect(checkResumeEvent(judged(ev, { emitted_sha: '000000000000' }), log).join()).toMatch(/do not match/);
    expect(checkResumeEvent(judged(ev, { version: '0.0.1' }), log).join()).toMatch(/do not match/);
    expect(checkResumeEvent(judged(ev, { session: 'other' }), log).join()).toMatch(/no resume-event trace line/);
  });

  it('호출 0 인 오행동을 「나아짐」 으로 판정하면 거부 · 근거 없는 판정 거부 · 미판정은 verdict 도 미판정', () => {
    const { log, ev } = resumed();
    expect(checkResumeEvent(judged(ev, { calls_before_first_action: 0, first_action_ok: 'no', verdict: 'better' }), log).join()).toMatch(/better requires a correct first action/);
    expect(checkResumeEvent(judged(ev, { evidence: '' }), log).join()).toMatch(/judged without judge and evidence/);
    expect(checkResumeEvent(judged(ev, { first_action_ok: 'unjudged', verdict: 'same' }), log).join()).toMatch(/verdict without judging/);
    expect(checkResumeEvent(judged(ev, { first_action_ok: 'unjudged', verdict: 'unjudged', judge: null, evidence: null }), log)).toEqual([]);
    expect(checkResumeEvent(judged(ev, { calls_before_first_action: 0, first_action_ok: 'yes', verdict: 'better' }), log)).toEqual([]);
  });
});
