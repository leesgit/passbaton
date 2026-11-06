// 2.10 — Stop 요약의 근거(원문 위치·턴·역할) 저장·표시 (Astra P5 reply-5 C2 · Ashfall P5-05) — 실제 훅(dist) 경로
//
// 계약: assistant 글에서 고른 행만 summary_basis / state_basis 에 {role, msg, kind, line, turn} · 표시는 같은 행의 것 ·
//   제목형 문구만 = 「(결과 요약 없음)」(no-result · basis NULL) · 커밋 출처 행은 basis NULL · 옛 행 소급 없음.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { writeActiveContext } from '../src/utils/active-context.js';

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
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-210b-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function hook(file: string, ws: string, payload: Record<string, unknown>): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws };
  delete env.PASSBATON_ROLE;
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  expect(r.stderr ?? '').not.toMatch(/Error|SqliteError/);
  return r.stdout;
}

let seq = 0;
function stop(ws: string, proj: string, session: string, user: string, reply: string, extra: Record<string, unknown> = {}) {
  const t = path.join(ws, `t-${session}-${seq++}.jsonl`);
  const lines = [
    { uuid: 'u0', type: 'user', message: { role: 'user', content: user } },
    { uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
  ];
  fs.writeFileSync(t, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  hook(SESSION_END, ws, { cwd: proj, session_id: session, transcript_path: t, last_assistant_message: reply, ...extra });
  for (const f of fs.readdirSync(path.join(ws, '.claude'))) if (f.startsWith('.session-end-')) fs.rmSync(path.join(ws, '.claude', f));
}
const start = (ws: string, proj: string) => hook(SESSION_START, ws, { cwd: proj, session_id: 'S', source: 'startup' });
const stateLine = (out: string) => out.split(/\r?\n/).find(l => l.startsWith('📍')) ?? '';
function read(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare("SELECT last_work, summary_source, summary_basis FROM sessions WHERE project = 'game' ORDER BY id").all() as
    Array<{ last_work: string; summary_source: string | null; summary_basis: string | null }>;
  const a = db.prepare("SELECT current_state, state_source, state_basis FROM active_context WHERE project = 'game'").get() as
    { current_state: string; state_source: string | null; state_basis: string | null } | undefined;
  db.close();
  return { rows: r, active: a };
}

const STATUS_REPLY = ['정리했습니다.', '', '- 현재 상태: A 통과 — 시험 13 · 변이 6 RED', '- 다음 작업: P5-06', '', '다음은 P5-06 을 진행하겠습니다.'].join('\n');

describe.skipIf(!built)('2.10 summary basis — 실제 Stop·SessionStart', () => {
  it('a status line is stored with its line, message, turn and role, and shown with the State', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'A', 'P5-05 해줘', STATUS_REPLY, { prompt_id: 'turn-77' });
    const { rows, active } = read(dbPath);
    expect(rows[0]).toMatchObject({ last_work: '현재 상태: A 통과 — 시험 13 · 변이 6 RED', summary_source: 'assistant-text' });
    expect(JSON.parse(rows[0].summary_basis!)).toEqual({ role: 'assistant', msg: 'last', kind: 'status', line: 3, turn: 'turn-77' });
    expect(active?.state_basis).toBe(rows[0].summary_basis);
    const out = start(ws, proj);
    expect(stateLine(out)).toContain('현재 상태: A 통과 — 시험 13 · 변이 6 RED _(via assistant text · status line L3 of the last reply · recorded ');
    expect(out).toMatch(/ _\(via assistant text · status line L3 of the last reply\)_/);
  });

  it('a heading-only reply records no result — not the heading', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'H', 'Astra 답 정리해줘', '## Astra의 총평\n\n| C1 | 7 |\n|---|---|\n', { prompt_id: 'turn-1' });
    const { rows } = read(dbPath);
    expect(rows[0]).toMatchObject({ last_work: '(결과 요약 없음)', summary_source: 'no-result', summary_basis: null });
    expect(start(ws, proj)).not.toContain('Astra의 총평 _(');
  });

  it('a reply that is only a future plan is not stored as the state', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'F', '다음 뭐 해?', "I'll run the full suite next and report back.", { prompt_id: 'turn-2' });
    expect(read(dbPath).rows[0]).toMatchObject({ last_work: '(결과 요약 없음)', summary_source: 'no-result', summary_basis: null });
  });

  it('a State written later without a basis does not keep the old basis', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'A', 'P5-05 해줘', STATUS_REPLY, { prompt_id: 'turn-77' });
    const db = new Database(dbPath);
    // MCP session_end 처럼 State 글만 칸별 쓰기로 넘기는 경로 — 출처·근거를 넘기지 않으면 둘 다 NULL 이어야 한다
    writeActiveContext(db, 'game', { current_state: 'MCP 가 적은 상태 — 세션 기록과 같은 글이 아니다' });
    db.close();
    expect(read(dbPath).active).toMatchObject({ state_source: null, state_basis: null });
    expect(stateLine(start(ws, proj))).toMatch(/MCP 가 적은 상태 — 세션 기록과 같은 글이 아니다 _\(via unknown · recorded /);
  });
});
