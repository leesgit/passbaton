// 2.7.3 — 요약(last_work · State)의 생성 출처 표시 (Astra reply-165 PB165-200)
//
// 계약: Stop 이 요약을 저장할 때 **실제로 고른 분기**(commit · assistant-text · fallback · no-result)를 같은 행에 함께 적고,
// 그 기록이 보이는 자리(📍 State · Recent Sessions 행)에 같은 기록의 값을 낸다 · 옛 행(NULL·칸 없음) = via unknown(소급·추정 없음) ·
// 본문·BLOCKED·실패 정보 그대로 · loop 카드·카드 없는 출력 유지 · assistant 요약을 줄이거나 빼지 않는다(2.7.4 로 이월).
// 역검증(reply-165 §1 200): 출처 바꿔치기 · 다른 행의 출처 결합 · 옛 행 출처 추정 → 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { migrateSchema } from '../src/db/migrate.js';

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
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-165s-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function hook(file: string, ws: string, payload: Record<string, unknown>, role?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws };
  delete env.PASSBATON_ROLE;
  if (role !== undefined) env.PASSBATON_ROLE = role;
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  expect(r.stderr ?? '').not.toMatch(/Error|SqliteError/);
  return r.stdout;
}

type Entry = { user?: string; text?: string; commit?: string };
let seq = 0;
/** 트랜스크립트를 쓰고 Stop 을 한 번 부른다. 세션마다 다른 트랜스크립트 — 턴 정체성이 겹치지 않게. */
function stop(ws: string, proj: string, session: string, entries: Entry[], extra: Record<string, unknown> = {}) {
  const t = path.join(ws, `t-${session}-${seq++}.jsonl`);
  const lines = entries.map((e, i) => e.user !== undefined
    ? { uuid: `u${i}`, type: 'user', message: { role: 'user', content: e.user } }
    : { uuid: `a${i}`, type: 'assistant', message: { role: 'assistant', content: [
        ...(e.commit ? [{ type: 'tool_use', id: `c${i}`, name: 'Bash', input: { command: `git commit -m "${e.commit}"` } }] : []),
        ...(e.text ? [{ type: 'text', text: e.text }] : []),
      ] } });
  fs.writeFileSync(t, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  hook(SESSION_END, ws, { cwd: proj, session_id: session, transcript_path: t, ...extra });
  for (const f of fs.readdirSync(path.join(ws, '.claude'))) if (f.startsWith('.session-end-')) fs.rmSync(path.join(ws, '.claude', f));
}
const start = (ws: string, proj: string, role?: string) => hook(SESSION_START, ws, { cwd: proj, session_id: 'S', source: 'startup' }, role);
const stateLine = (out: string) => out.split(/\r?\n/).find(l => l.startsWith('📍')) ?? '';
const recent = (out: string) => {
  const lines = out.split(/\r?\n/);
  const i = lines.indexOf('## Recent Sessions');
  if (i < 0) return [];
  const rest = lines.slice(i + 1);
  const end = rest.findIndex(l => !l.startsWith('- ') && !l.startsWith('  '));
  return (end < 0 ? rest : rest.slice(0, end)).filter(l => l.startsWith('- '));
};
function rows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare("SELECT session_id, last_work, summary_source FROM sessions WHERE project = 'game' ORDER BY id").all() as
    Array<{ session_id: string; last_work: string; summary_source: string | null }>;
  const a = db.prepare("SELECT current_state, state_source FROM active_context WHERE project = 'game'").get() as
    { current_state: string; state_source: string | null } | undefined;
  db.close();
  return { rows: r, active: a };
}

const COMMIT = 'feat: 지도 셰이더 캐시를 다시 쓰게 고쳤다';
const SAID = '✅ 미니맵 깜빡임 원인을 찾아 기록했다 — 촬영은 아직 하지 않았다';

describe.skipIf(!built)('PB165-200 Stop 이 고른 분기를 같은 행에 · 같은 기록에서 표시', () => {
  it('커밋 메시지 → commit · State·Recent 에 via commit message · 본문 그대로', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'A', [{ user: '셰이더 캐시 고쳐줘' }, { commit: COMMIT, text: '커밋했습니다. 테스트는 돌리지 않았습니다.' }]);
    const { rows: r, active } = rows(dbPath);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ last_work: COMMIT, summary_source: 'commit' });
    expect(active).toEqual({ current_state: COMMIT, state_source: 'commit' });
    const out = start(ws, proj);
    expect(stateLine(out)).toMatch(new RegExp(`^📍 \\*\\*State\\*\\*: ${COMMIT} _\\(via commit message · recorded `));
    expect(recent(out)).toEqual([expect.stringMatching(new RegExp(`\\] \\[origin unknown\\] ${COMMIT} _\\(via commit message\\)_$`))]);
  });

  it('assistant 문장(last_assistant_message) → assistant-text · 요약을 줄이거나 빼지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'B', [{ user: '미니맵 봐줘' }, { text: '보는 중' }], { last_assistant_message: SAID });
    const { rows: r, active } = rows(dbPath);
    const said = SAID.replace(/^✅\s*/, '');
    expect(r[0]).toMatchObject({ last_work: said, summary_source: 'assistant-text' });
    expect(active?.state_source).toBe('assistant-text');
    const out = start(ws, proj);
    expect(stateLine(out)).toContain(`${said} _(via assistant text · recorded `);
    expect(recent(out)[0]).toMatch(/ _\(via assistant text\)_$/);
  });

  it('트랜스크립트의 assistant 문장(2c)도 assistant-text', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'B2', [{ user: '미니맵 봐줘' }, { text: SAID }]);
    expect(rows(dbPath).rows[0].summary_source).toBe('assistant-text');
  });

  it('BLOCKED 문장은 본문 그대로 · 출처만 덧붙는다', () => {
    const { ws, proj, dbPath } = workspace();
    const blocked = 'BLOCKED — 원인: 빌드 서버 응답 없음 / 영향: 패키지 못 만듦 / 재개 조건: 재기동';
    stop(ws, proj, 'K', [{ user: '패키지 만들어줘' }, { text: blocked }]);
    expect(rows(dbPath).rows[0]).toMatchObject({ last_work: blocked, summary_source: 'assistant-text' });
    expect(stateLine(start(ws, proj))).toContain(`${blocked} _(via assistant text · `);
  });

  it('파일 목록 폴백 → fallback', () => {
    const { ws, proj, dbPath } = workspace();
    const db = new Database(dbPath);
    migrateSchema(db);
    db.prepare('INSERT INTO session_files (session_id, project, file_path) VALUES (?, ?, ?)').run('F', 'game', path.join(proj, 'src', 'map.ts'));
    db.close();
    fs.writeFileSync(path.join(proj, 'src', 'map.ts'), 'export {};\n');
    stop(ws, proj, 'F', [{ user: '지도 파일 손봐줘' }]);
    const { rows: r, active } = rows(dbPath);
    expect(r[0].last_work).toMatch(/^Modified files: /);
    expect(r[0].summary_source).toBe('fallback');
    expect(active?.state_source).toBe('fallback');
    expect(stateLine(start(ws, proj))).toContain('_(via fallback (action line or file list) · recorded ');
  });

  it('결과를 못 뽑음 → no-result · 「(결과 요약 없음)」 그대로', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'N', [{ user: '이거 뭐였지' }]);
    expect(rows(dbPath).rows[0]).toMatchObject({ last_work: '(결과 요약 없음)', summary_source: 'no-result' });
    expect(stateLine(start(ws, proj))).toContain('(결과 요약 없음) _(via no result · recorded ');
  });

  it('다른 행의 출처를 붙이지 않는다 — State 는 active_context 의 값 · Recent 는 행마다 자기 값', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'A', [{ user: '셰이더 캐시 고쳐줘' }, { commit: COMMIT }]);
    // 일한 증거 없는 다음 턴(다른 세션) — State 는 그대로, 최신 sessions 행만 assistant-text
    stop(ws, proj, 'Q', [{ user: '경로만 알려줘' }], { last_assistant_message: SAID });
    const { rows: r, active } = rows(dbPath);
    expect(r.map(x => x.summary_source)).toEqual(['commit', 'assistant-text']);
    expect(active).toEqual({ current_state: COMMIT, state_source: 'commit' });
    const out = start(ws, proj);
    expect(stateLine(out)).toMatch(new RegExp(`^📍 \\*\\*State\\*\\*: ${COMMIT} _\\(via commit message · `));
    const rec = recent(out);
    expect(rec).toHaveLength(2);
    // 두 행이 같은 초에 들어가 순서는 정해지지 않는다 — 글로 찾아 각 행의 출처를 본다
    expect(rec.find(l => l.includes('미니맵 깜빡임'))).toMatch(/ _\(via assistant text\)_$/);
    expect(rec.find(l => l.includes(COMMIT))).toMatch(/ _\(via commit message\)_$/);
  });

  it('loop 기록을 대신한 sessions 행이면 **그 행의** 출처 — loop State 의 출처를 붙이지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    const db = new Database(dbPath);
    migrateSchema(db);
    const ins = db.prepare("INSERT INTO sessions (project, last_work, timestamp, run_origin, summary_source) VALUES ('game', ?, ?, ?, ?)");
    ins.run('대화 B — 미니맵 H 요청서와 체크리스트를 정리했다', '2026-10-23 02:00:00', null, 'commit');
    ins.run('루프 — 이번 루프에서도 아무것도 하지 않았습니다', '2026-10-23 05:00:00', 'loop', 'assistant-text');
    db.prepare("INSERT INTO active_context (project, current_state, updated_at, state_source) VALUES ('game', ?, ?, ?)")
      .run('루프 — 이번 루프에서도 아무것도 하지 않았습니다', '2026-10-23 05:00:01', 'assistant-text');
    db.close();
    expect(stateLine(start(ws, proj))).toBe('📍 **State**: 대화 B — 미니맵 H 요청서와 체크리스트를 정리했다 _(via commit message · recorded 2026-10-23 02:00 (DB time) · origin unknown · newer loop records excluded)_');
    // loop 카드는 active_context 그대로 — 그 행의 출처
    expect(stateLine(start(ws, proj, 'loop'))).toBe('📍 **State**: 루프 — 이번 루프에서도 아무것도 하지 않았습니다 _(via assistant text)_');
  });

  it('옛 행(NULL)은 글이 커밋처럼 생겨도 via unknown — 추정하지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    const db = new Database(dbPath);
    migrateSchema(db);
    db.prepare("INSERT INTO sessions (project, last_work, timestamp, issues) VALUES ('game', ?, ?, ?)")
      .run(`${COMMIT}; fix: 미니맵 갱신 주기`, '2026-10-23 02:00:00', JSON.stringify({ commits: [COMMIT], decisions: [], errorsSolved: [] }));
    db.prepare("INSERT INTO active_context (project, current_state, updated_at) VALUES ('game', ?, ?)").run(`${COMMIT}; fix: 미니맵 갱신 주기`, '2026-10-23 02:00:01');
    db.close();
    const out = start(ws, proj);
    expect(stateLine(out)).toMatch(/ _\(via unknown · recorded 2026-10-23 02:00 \(DB time\) · origin unknown\)_$/);
    expect(recent(out)[0]).toMatch(/ _\(via unknown\)_$/);
    expect(out).not.toMatch(/via commit message|via assistant text/);
  });

  it('출처 칸 없는 옛 DB(2.7.2 모양) → 오류 없이 via unknown · SessionStart 는 칸을 만들지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_work TEXT, current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
      session_id TEXT, prompt_id TEXT, user_intent TEXT, file_coverage TEXT, workspace_writes TEXT)`);
    old.exec(`CREATE TABLE active_context (project TEXT PRIMARY KEY, current_state TEXT, active_tasks TEXT, recent_files TEXT,
      blockers TEXT, last_verification TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    old.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES ('game', '옛 기록 — 게이트 실행 기록을 정비했다', '2026-10-22 10:00:00')").run();
    old.prepare("INSERT INTO active_context (project, current_state, updated_at) VALUES ('game', '옛 기록 — 게이트 실행 기록을 정비했다', '2026-10-22 10:00:01')").run();
    old.close();
    const out = start(ws, proj);
    expect(stateLine(out)).toBe('📍 **State**: 옛 기록 — 게이트 실행 기록을 정비했다 _(via unknown · recorded 2026-10-22 10:00 (DB time) · origin unknown)_');
    expect(recent(out)).toEqual(['- [2026-10-22] [origin unknown] 옛 기록 — 게이트 실행 기록을 정비했다 _(via unknown)_']);
    const db = new Database(dbPath, { readonly: true });
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);
    const s = cols('sessions'), a = cols('active_context');
    db.close();
    expect(s).not.toContain('summary_source');
    expect(a).not.toContain('state_source');
    // 이어서 2.7.3 Stop → 칸이 생기고 옛 행은 NULL 그대로(소급 없음) · 새 행만 값
    stop(ws, proj, 'A', [{ user: '셰이더 캐시 고쳐줘' }, { commit: COMMIT }]);
    const after = new Database(dbPath, { readonly: true });
    const v = after.prepare("SELECT last_work, summary_source FROM sessions ORDER BY id").all() as Array<{ last_work: string; summary_source: string | null }>;
    after.close();
    expect(v).toEqual([{ last_work: '옛 기록 — 게이트 실행 기록을 정비했다', summary_source: null }, { last_work: COMMIT, summary_source: 'commit' }]);
  });

  it('다른 도구가 active_context 를 덮으면(INSERT OR REPLACE) 출처는 unknown 으로 돌아간다', () => {
    const { ws, proj, dbPath } = workspace();
    stop(ws, proj, 'A', [{ user: '셰이더 캐시 고쳐줘' }, { commit: COMMIT }]);
    const db = new Database(dbPath);
    // MCP session_end 가 State 를 쓰는 모양(src/index.ts) — state_source 를 모른다
    db.prepare("INSERT OR REPLACE INTO active_context (project, current_state, updated_at) VALUES ('game', ?, datetime('now'))").run('MCP 가 적은 상태 — 세션 기록과 같은 글이 아니다');
    db.close();
    expect(stateLine(start(ws, proj))).toMatch(/^📍 \*\*State\*\*: MCP 가 적은 상태 — 세션 기록과 같은 글이 아니다 _\(via unknown · recorded /);
  });
});
