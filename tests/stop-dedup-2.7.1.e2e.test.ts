// 2.7.1 — Stop 중복 억제는 「같은 Stop 이벤트의 재전달」 만 막는다 (Astra reply-148 PB148-20)
//
// 재현(2026-10-23 시험 작성 중): 턴 식별자 없는 Stop 두 번(다른 세션 · 같은 「(결과 요약 없음)」 · 10 초 안)
// → 두 번째 기록이 사라졌다. 옛 텍스트 경로는 project + 같은 요약만 보고 세션을 가리지 않는다.
// 역검증(reply-148): 다른 세션과 같은 세션의 다른 턴은 보존 · 같은 이벤트 재전달은 한 번만 ·
// 세션이 없는 옛 경로와 호스트 식별자 경로는 그대로.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const built = [SESSION_START, SESSION_END].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-271-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function hook(file: string, ws: string, payload: Record<string, unknown>) {
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
}

/** 사람 요청 n 개 · 마지막 응답은 늘 같은 짧은 말 → 요약이 「(결과 요약 없음)」 류로 같아진다 */
function transcript(ws: string, name: string, requests: string[]): string {
  const p = path.join(ws, name);
  const lines = requests.flatMap((q, i) => [
    { uuid: `${name}-u${i}`, type: 'user', message: { role: 'user', content: q } },
    { uuid: `${name}-a${i}`, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '확인했습니다.' }] } },
  ]);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/** Stop 의 5 초 파일락을 지운다 — 락이 놓친 재전달(서로 다른 프로세스·락 경합)을 DB 판정만으로 시험 */
const dropLocks = (ws: string) => {
  for (const f of fs.readdirSync(path.join(ws, '.claude'))) if (f.startsWith('.session-end-')) fs.rmSync(path.join(ws, '.claude', f));
};
const rows = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare("SELECT session_id, prompt_id, last_work FROM sessions WHERE project = 'game' ORDER BY id").all() as Array<{ session_id: string | null; prompt_id: string | null; last_work: string }>;
  db.close();
  return r;
};

describe.skipIf(!built)('PB148-20 Stop 중복 억제 = 같은 이벤트 재전달만', () => {
  it('다른 세션 · 같은 요약 · 10 초 안 → 둘 다 남는다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: transcript(ws, 'a.jsonl', ['지도 화면 봐줘']) });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'B', transcript_path: transcript(ws, 'b.jsonl', ['지도 화면 봐줘']) });
    const r = rows(dbPath);
    expect(r.map(x => x.session_id)).toEqual(['A', 'B']);
    expect(r[0].last_work).toBe(r[1].last_work);   // 요약이 같아도
    expect(r.every(x => x.prompt_id?.startsWith('tx:'))).toBe(true);
  });

  it('같은 세션의 다음 턴 · 같은 요약 → 둘 다 남는다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = path.join(ws, 'a.jsonl');
    transcript(ws, 'a.jsonl', ['지도 화면 봐줘']);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    dropLocks(ws);
    transcript(ws, 'a.jsonl', ['지도 화면 봐줘', '지도 화면 봐줘']);   // 같은 말을 한 번 더 — 그래도 다른 턴이다
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    expect(rows(dbPath)).toHaveLength(2);
  });

  it('같은 이벤트의 재전달(락이 놓친 경우) → 한 번만', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = transcript(ws, 'a.jsonl', ['지도 화면 봐줘']);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    dropLocks(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    expect(rows(dbPath)).toHaveLength(1);
  });

  it('세션 ID 가 없으면 옛 경로 그대로(가를 근거가 없다) — 같은 요약은 한 번', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    hook(SESSION_END, ws, { cwd: proj, transcript_path: transcript(ws, 'a.jsonl', ['지도 화면 봐줘']) });
    hook(SESSION_END, ws, { cwd: proj, transcript_path: transcript(ws, 'b.jsonl', ['지도 화면 봐줘']) });
    const r = rows(dbPath);
    expect(r).toHaveLength(1);
    expect(r[0].prompt_id).toBeNull();
  });

  // ── reply-149 보완 ──
  it('PB149-01 사람 요청 수·마지막 응답이 같고 완료 레코드만 다른 두 이벤트(기계 알림 턴) → 둘 다 · 락 유지', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = transcript(ws, 'a.jsonl', ['지도 화면 봐줘']);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    // 사람 입력이 아닌 하네스 알림으로 이어진 턴 — 사람 요청 수는 그대로, 응답 문장도 같다
    fs.appendFileSync(t, [
      { uuid: 'n1', type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>' } },
      { uuid: 'n1a', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '확인했습니다.' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });   // 락을 지우지 않는다
    expect(rows(dbPath)).toHaveLength(2);
  });

  it('PB149-02 빈 파일 · 없는 파일 · JSON 아닌 파일 → 고정 키를 만들지 않고 보존 · 「식별 못 함」 을 기록', () => {
    for (const kind of ['empty', 'missing', 'garbage'] as const) {
      const { ws, proj, dbPath } = workspace();
      hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
      const t = path.join(ws, `${kind}.jsonl`);
      if (kind === 'empty') fs.writeFileSync(t, '');
      if (kind === 'garbage') fs.writeFileSync(t, 'not json\n{oops\n');
      // 트랜스크립트는 못 읽어도 근거는 있다(Stop 입력의 마지막 응답) — 근거가 아예 없는 턴은 원래 안 적는다
      const last = '지도 화면의 깜빡임을 고치고 회귀 시험을 붙였습니다. 다음은 미니맵입니다.';
      hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t, last_assistant_message: last });
      dropLocks(ws);
      hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t, last_assistant_message: last });
      const db = new Database(dbPath, { readonly: true });
      const r = db.prepare("SELECT prompt_id, file_coverage FROM sessions WHERE project = 'game'").all() as Array<{ prompt_id: string | null; file_coverage: string }>;
      db.close();
      expect(r, kind).toHaveLength(2);                            // 중복 가능성을 감수하고 보존
      for (const x of r) {
        expect(x.prompt_id, kind).toBeNull();
        expect(JSON.parse(x.file_coverage).dedup, kind).toMatch(/unidentified Stop event/);
      }
    }
  });

  it('PB149-03 락을 유지한 채: 빠른 p1 → p2 는 둘 · 같은 이벤트 재전달(바로 다시)은 하나', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = transcript(ws, 'a.jsonl', ['지도 화면 봐줘']);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p1', transcript_path: t });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p2', transcript_path: t });   // 5 초 안 · 다른 턴
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p2', transcript_path: t });   // 재전달
    expect(rows(dbPath).map(x => x.prompt_id)).toEqual(['p1', 'p2']);
    // ID 없는 호스트: 같은 트랜스크립트 그대로 바로 다시 → 하나
    const b = workspace();
    hook(SESSION_START, b.ws, { cwd: b.proj, session_id: 'B' });
    const tb = transcript(b.ws, 'b.jsonl', ['상점 정렬 고쳐줘']);
    hook(SESSION_END, b.ws, { cwd: b.proj, session_id: 'B', transcript_path: tb });
    hook(SESSION_END, b.ws, { cwd: b.proj, session_id: 'B', transcript_path: tb });
    expect(rows(b.dbPath)).toHaveLength(1);
  });

  it('호스트 턴 id 가 세션마다 다시 세는 값이어도(turn-1) 다른 세션은 둘 — 판정은 세션 안에서만', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', turn_id: 'turn-1', transcript_path: transcript(ws, 'a.jsonl', ['지도 화면 봐줘']) });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'B', turn_id: 'turn-1', transcript_path: transcript(ws, 'b.jsonl', ['상점 정렬 고쳐줘']) });
    expect(rows(dbPath).map(x => x.session_id)).toEqual(['A', 'B']);
  });

  it('호스트가 턴 식별자를 주면 그것이 정체성 — 다른 id 는 둘 · 같은 id 재전달은 하나', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = transcript(ws, 'a.jsonl', ['지도 화면 봐줘']);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p1', transcript_path: t });
    dropLocks(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p1', transcript_path: t });
    dropLocks(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p2', transcript_path: t });
    expect(rows(dbPath).map(x => x.prompt_id)).toEqual(['p1', 'p2']);
  });
});
