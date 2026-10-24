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
    // subarray 는 끝을 넘으면 조용히 자른다 — 본문 끝을 넘는 길이 기록(잘림 전 길이 등)을 sha 대조가 놓치지 않게(PB174-020)
    expect(f.at + f.bytes, `${f.src} recorded length stays inside the emitted body`).toBeLessThanOrEqual(body.length);
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

// ── PB174-020 (Astra reply-174 §1 (c)) — routed-card 원천 식별 ─────────────────────────────────────────────
// 계약: 파일 원천 = 워크스페이스 기준 경로 : 선택 범위 @ 그 범위의 sha1(앞 10 · 카드에 찍힌 값) [~보인 끝 줄(잘렸을 때)] ·
//   읽지 못한 원천 = 경로@결과(해시 없음) · DB 원천 = 실제 session_route 행(session_id/project — 그 행에서 읽은 값) ·
//   존재하지 않는 DB 행 id 를 만들지 않는다. 검사는 원장을 믿지 않고 디스크·DB·stdout 에서 다시 잰다.
describe.skipIf(!built)('PB174-020 N3 — routed-card 원천 식별(파일 범위·해시 · DB 행)', () => {
  const ROUTES = { '/ashfall': 'apps/game', '/other': 'apps/other', '/home': '.' };
  function routedWs(handoff: string, lines = 5) {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-174r-')));
    roots.push(ws);
    for (const [name, body] of [['game', handoff], ['other', '# 최신\n- 다음: 다른 앱 일\n']]) {
      const proj = path.join(ws, 'apps', name);
      fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), body);
      fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
        JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines, label: 'HANDOFF' }] } }));
    }
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
    const trace = (enabled: boolean) => fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'),
      JSON.stringify({ routing: { commands: ROUTES }, features: { hookTrace: { enabled } } }));
    trace(false);
    run(SESSION_START, ws, { cwd: ws, session_id: 'S0', source: 'startup' });   // DB
    return { ws, dbPath: path.join(ws, '.claude', 'sessions.db'), trace };
  }
  const ask = (ws: string, sid: string, prompt: string, env: Record<string, string> = {}) =>
    run(USER_PROMPT, ws, { cwd: ws, session_id: sid, prompt }, env);
  const routeRows = (dbPath: string, sid: string) => {
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare('SELECT session_id, project FROM session_route WHERE session_id = ?').all(sid) as Array<{ session_id: string; project: string }>; }
    finally { db.close(); }
  };
  /** 파일 원천 id 를 디스크에서 다시 잰다 — 범위의 줄을 다시 잘라 sha1 앞 10 */
  function fileSource(ws: string, id: string) {
    const m = /^(.+):(\d+)-(\d+)@([0-9a-f]{10})(?:~(\d+))?$/.exec(id);
    expect(m, `file source id shape: ${id}`).not.toBeNull();
    const [, rel, a, b, sha, shown] = m!;
    const all = fs.readFileSync(path.join(ws, rel), 'utf8').split(/\r?\n/);
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const from = Number(a), to = Number(b);
    const rangeText = all.slice(from - 1, to).join('\n');
    expect(crypto.createHash('sha1').update(rangeText).digest('hex').slice(0, 10), `${id}: range hash = bytes on disk`).toBe(sha);
    return { rel, from, to, sha, shown: shown === undefined ? undefined : Number(shown), rangeText };
  }
  const fragText = (body: Buffer, f: Frag) => body.subarray(f.at, f.at + f.bytes).toString('utf8');

  it('명령 턴: ids = 실제 session_route 행 + 파일 경로:범위@sha1 — 디스크·DB·본문과 결속 · trace on/off 본문 동일', () => {
    const { ws, dbPath, trace } = routedWs('# 최신\n- 다음: N174-020 원장 결속\n- 정지: DEMO_STOP 유지\n');
    const off = ask(ws, 'A', '/ashfall 이어서');
    trace(true);
    const on = ask(ws, 'B', '/ashfall 이어서');
    expect(on).toBe(off);
    expect(on).toContain('N174-020 원장 결속');                         // 양성: 카드가 실제로 나왔다
    const body = Buffer.from(on.replace(/\r?\n$/, ''), 'utf8');
    const { frags } = ledger(ws, 'user-prompt');
    expect(frags.map(f => f.src)).toEqual(['routed-card']);
    audit(body, frags, /^$/);
    const ids = frags[0].ids!.split(',');
    const rows = routeRows(dbPath, 'B');
    expect(rows).toHaveLength(1);
    expect(ids[0]).toBe(`session_route:${rows[0].session_id}/${rows[0].project}`);
    expect(ids).toHaveLength(2);
    const src = fileSource(ws, ids[1]);
    expect(src.rel).toBe('apps/game/docs/HANDOFF.md');
    expect(src.shown).toBeUndefined();                                 // 안 잘렸다
    const text = fragText(body, frags[0]);
    expect(text).toContain(`\`docs/HANDOFF.md:${src.from}-${src.to}\``);  // 범위 = 실제 낸 카드의 범위
    expect(text).toContain(`sha1 ${src.sha}`);
  });

  it('잘린 카드: 범위·해시는 선택 범위 그대로 + 보인 끝 줄 표시 · 조각 바이트는 잘린 뒤 실제 출력', () => {
    const long = '# 최신\n' + Array.from({ length: 39 }, (_, i) => `- 줄 ${i + 1} ${'가나다라마바사'.repeat(6)}`).join('\n') + '\n';
    const { ws, trace } = routedWs(long, 40);
    trace(true);
    const out = ask(ws, 'A', '/ashfall', { PASSBATON_CARD_CHARS: '400' });
    expect(out).toContain('truncated');
    const body = Buffer.from(out.replace(/\r?\n$/, ''), 'utf8');
    const { frags } = ledger(ws, 'user-prompt');
    audit(body, frags, /^$/);
    const src = fileSource(ws, frags[0].ids!.split(',')[1]);
    expect([src.from, src.to]).toEqual([1, 40]);
    expect(src.shown).toBeGreaterThanOrEqual(1);
    expect(src.shown).toBeLessThan(src.to);
    expect(frags[0].bytes).toBe(body.length);
    expect(frags[0].bytes).toBeLessThan(Buffer.byteLength(src.rangeText));   // 잘림 전 원천 길이가 아니다
  });

  it('명령 없는 턴의 재발행: 원천이 바뀌면 해시가 바뀐 새 id · 같은 행 · SessionStart(compact) 도 같은 형식', () => {
    const { ws, dbPath, trace } = routedWs('# 최신\n- 다음: 첫 판\n');
    ask(ws, 'A', '/ashfall');
    fs.writeFileSync(path.join(ws, 'apps', 'game', 'docs', 'HANDOFF.md'), '# 최신\n- 다음: 바뀐 판 N174\n');
    trace(true);
    const out = ask(ws, 'A', '계속 해줘');
    expect(out).toContain('바뀐 판 N174');
    const body = Buffer.from(out.replace(/\r?\n$/, ''), 'utf8');
    const up = ledger(ws, 'user-prompt').frags;
    expect(up.map(f => f.src)).toEqual(['routed-card']);
    audit(body, up, /^$/);
    const [rowId, fileId] = up[0].ids!.split(',');
    const rows = routeRows(dbPath, 'A');
    expect(rowId).toBe(`session_route:${rows[0].session_id}/${rows[0].project}`);
    expect(fileSource(ws, fileId).rangeText).toContain('바뀐 판 N174');
    const ss = run(SESSION_START, ws, { cwd: ws, session_id: 'A', source: 'compact' });
    expect(ss).toContain('바뀐 판 N174');
    const card = ledger(ws, 'session-start').frags.find(f => f.src === 'routed-card')!;
    expect(card.ids).toBe(up[0].ids);
  });

  it('해제: 지운 그 행의 id 만 · 행이 없던 세션은 조각도 id 도 없다(만들지 않는다) · 선언 없는 대상은 파일 id 없음', () => {
    const { ws, dbPath, trace } = routedWs('# 최신\n- 다음: 해제 시험\n');
    ask(ws, 'A', '/ashfall');
    const before = routeRows(dbPath, 'A');
    expect(before).toHaveLength(1);
    trace(true);
    const out = ask(ws, 'A', '/home');
    expect(out).toContain('Route released');
    expect(routeRows(dbPath, 'A')).toHaveLength(0);
    const rel = ledger(ws, 'user-prompt').frags;
    expect(rel.map(f => [f.src, f.ids])).toEqual([['route-released', `session_route:${before[0].session_id}/${before[0].project}`]]);
    audit(Buffer.from(out.replace(/\r?\n$/, ''), 'utf8'), rel, /^$/);

    fs.rmSync(path.join(ws, '.claude', 'hook-trace.log'));
    expect(ask(ws, 'C', '/home')).toBe('');                               // 행 없음 → 낼 것 없음
    expect(ledger(ws, 'user-prompt').frags).toEqual([]);

    fs.rmSync(path.join(ws, 'apps', 'other', '.claude', 'passbaton.config.json'));
    const other = ask(ws, 'D', '/other');
    expect(other).toContain('declares no continuity.sources');
    const o = ledger(ws, 'user-prompt').frags;
    const rowsD = routeRows(dbPath, 'D');
    expect(o.map(f => [f.src, f.ids])).toEqual([['routed-card', `session_route:${rowsD[0].session_id}/${rowsD[0].project}`]]);
  });
});
