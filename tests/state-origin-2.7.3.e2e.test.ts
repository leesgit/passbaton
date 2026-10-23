// 2.7.3 — 대화 카드의 📍 State 줄에서 확인된 loop 기록 제외 + 공용 검증 기록 표지 (Astra reply-156 PB156-100)
//
// 계약: 대화 카드(현재 출처 ≠ loop)는 확인된 loop 기록을 뺀 뒤 최신 적격 기록 **하나**를 고른다 ·
// 상태·시각·출처는 같은 기록에서(행을 섞으면 실패) · 적격 기록이 없으면 none(loop 로 대체 안 함) ·
// 연결할 수 없는 active_context 는 대화 출처로 추정하지 않는다(origin unknown) · 「마지막 대화 상태」 라고 부르지 않는다 ·
// verification ledger 는 출처로 거르지 않고 「프로젝트 공용 검증 기록」 임을 밝힌다.
// 역검증(reply-156 §4 100): 최신 loop 3 행·이전 명시 출처 행·unknown 행에 서로 다른 상태 → 필터·행 연결을 끊으면 빨강 ·
// loop 실패 기록을 ledger 에서 빼면 빨강. (300) 옛 DB 의 첫 SessionStart(Stop 이전) · 같은 Stop 재전달 중복 없음.

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

type Row = {
  work: string; origin: 'loop' | 'unknown' | null; at: string; issues?: string | null;
  coverage?: string | null; writes?: string | null; files?: string | null; verification?: string | null;
};

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-273s-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function seed(dbPath: string, rows: Row[], active?: { state: string; at: string; blockers?: string | null }) {
  const db = new Database(dbPath);
  migrateSchema(db);
  db.exec('ALTER TABLE sessions ADD COLUMN verification_result TEXT');   // MCP 쪽 스키마(database.ts)에만 있는 칸
  const ins = db.prepare(`INSERT INTO sessions (project, last_work, timestamp, run_origin, issues, file_coverage, workspace_writes, modified_files, verification_result)
    VALUES ('game', ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.work, r.at, r.origin, r.issues ?? null, r.coverage ?? null, r.writes ?? null, r.files ?? null, r.verification ?? null);
  if (active) {
    db.prepare("INSERT INTO active_context (project, current_state, blockers, updated_at) VALUES ('game', ?, ?, ?)")
      .run(active.state, active.blockers ?? null, active.at);
  }
  db.close();
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
const start = (ws: string, proj: string, role?: string) => hook(SESSION_START, ws, { cwd: proj, session_id: 'S', source: 'startup' }, role);
const stateLines = (out: string) => out.split(/\r?\n/).filter(l => l.startsWith('📍') || l.startsWith('🚧'));

// 오래된 대화 쪽 행 둘(NULL 출처 · 명시 unknown 출처 — 상태가 서로 다르다) → 최신 loop 행 셋(상태가 또 다르다)
const ROWS: Row[] = [
  { work: '대화 상태 A — 지도 렌더 조사 결과를 남겼다', origin: null, at: '2026-10-23 01:00:00', issues: 'A 의 블로커 — 셰이더 캐시' },
  { work: '대화 상태 B — 미니맵 H 요청서와 체크리스트를 정리했다', origin: 'unknown', at: '2026-10-23 02:00:00' },
  { work: '루프 상태 1 — 이번 루프에서도 아무것도 하지 않았습니다', origin: 'loop', at: '2026-10-23 03:00:00' },
  { work: 'BLOCKED — 원인: 빌드 서버 응답 없음 / 재개 조건: 재기동', origin: 'loop', at: '2026-10-23 04:00:00' },
  { work: '루프 상태 3 — 게이트 실행 기록을 정비했습니다', origin: 'loop', at: '2026-10-23 05:00:00' },
];
// Stop 이 마지막으로 적은 State = 최신 loop 행의 글(Stop 은 같은 글을 sessions·active_context 둘 다에 적는다)
const LOOP_ACTIVE = { state: ROWS[4].work, at: '2026-10-23 05:00:01', blockers: 'loop 쪽 블로커' };

describe.skipIf(!built)('PB156-100 대화 카드의 State — 확인된 loop 기록을 뺀 최신 적격 기록 하나', () => {
  it('최신 loop 3 행 → State = 명시 unknown 행 B 의 글·시각·출처(한 행) · loop 글·다른 행의 Blocker 없음', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS, LOOP_ACTIVE);
    const s = stateLines(start(ws, proj));
    expect(s).toEqual([
      '📍 **State**: 대화 상태 B — 미니맵 H 요청서와 체크리스트를 정리했다 _(recorded 2026-10-23 02:00 (DB time) · origin unknown · newer loop records excluded)_',
    ]);
  });

  it('「마지막 대화 상태」 라고 부르지 않는다 — unknown 도 적격이다', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS, LOOP_ACTIVE);
    const out = start(ws, proj);
    expect(out).not.toMatch(/conversation state|last conversation|대화 상태\*\*/i);
    expect(out).toContain('origin unknown');
  });

  it('행 연결: 더 최신의 「일한 증거 없음」 비-loop 행은 건너뛴다(Stop 의 State 규칙) — 글과 시각은 같은 행', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, [
      ...ROWS,
      { work: '대화 상태 C — 경로 한 줄 묻고 끝난 턴이라 State 가 아니다', origin: null, at: '2026-10-23 02:30:00',
        coverage: JSON.stringify({ source: 'turn_scoped' }), files: '[]', writes: null },
      { work: '대화 상태 D — 셸로 파일을 고친 턴(작업 증거 있음)', origin: null, at: '2026-10-23 01:30:00',
        coverage: JSON.stringify({ source: 'turn_scoped' }), files: '[]', writes: JSON.stringify([{ root: 'x', written: ['a.ts'] }]) },
    ], LOOP_ACTIVE);
    const s = stateLines(start(ws, proj));
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('대화 상태 B');
    expect(s[0]).toContain('recorded 2026-10-23 02:00');
    expect(s[0]).not.toContain('대화 상태 C');
  });

  it('같은 행의 Blocker 만 — MCP 형식(issues 글) 행이 고르면 그 행의 것', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, [ROWS[0], ...ROWS.slice(2)], LOOP_ACTIVE);
    const s = stateLines(start(ws, proj));
    expect(s).toEqual([
      '📍 **State**: 대화 상태 A — 지도 렌더 조사 결과를 남겼다 _(recorded 2026-10-23 01:00 (DB time) · origin unknown · newer loop records excluded)_',
      '🚧 **Blocker**: A 의 블로커 — 셰이더 캐시',
    ]);
  });

  it('적격 기록이 없으면 none — loop 상태로 대체하지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS.slice(2), LOOP_ACTIVE);
    const s = stateLines(start(ws, proj));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatch(/^📍 \*\*State\*\*: none _\(no eligible record/);
    expect(s[0]).not.toContain('루프 상태');
    expect(s[0]).not.toContain('BLOCKED');
  });

  it('현재 세션이 loop 면 기존 동작 — active_context 그대로 · 표시 없음', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS, LOOP_ACTIVE);
    expect(stateLines(start(ws, proj, 'loop'))).toEqual([
      `📍 **State**: ${ROWS[4].work}`,
      '🚧 **Blocker**: loop 쪽 블로커',
    ]);
  });

  it('잘못된 값(Loop)은 loop 가 아니다 → 대화 카드 취급', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS, LOOP_ACTIVE);
    expect(stateLines(start(ws, proj, 'Loop'))[0]).toContain('대화 상태 B');
  });

  it('비-loop 행과 연결된 active_context → 그대로 · origin unknown (대화라고 단정하지 않는다)', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS, { state: ROWS[1].work, at: '2026-10-23 02:00:01', blockers: '대화 블로커' });
    expect(stateLines(start(ws, proj))).toEqual([
      `📍 **State**: ${ROWS[1].work} _(recorded 2026-10-23 02:00 (DB time) · origin unknown)_`,
      '🚧 **Blocker**: 대화 블로커',
    ]);
  });

  it('연결할 수 없는 active_context(다른 도구가 적은 글) → 대화 출처로 추정하지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS, { state: 'update_active_context 가 적은 상태 — 어느 세션 행과도 같지 않다', at: '2026-10-23 06:00:00' });
    const s = stateLines(start(ws, proj));
    expect(s).toEqual(['📍 **State**: update_active_context 가 적은 상태 — 어느 세션 행과도 같지 않다 _(recorded 2026-10-23 06:00 (DB time) · origin unknown · not linked to a session record)_']);
  });

  it('DB 는 바뀌지 않는다 — 행·active_context 그대로', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, ROWS, LOOP_ACTIVE);
    start(ws, proj);
    const db = new Database(dbPath, { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project = 'game'").get() as { n: number }).n;
    const a = db.prepare("SELECT current_state FROM active_context WHERE project = 'game'").get() as { current_state: string };
    db.close();
    expect(n).toBe(ROWS.length);
    expect(a.current_state).toBe(LOOP_ACTIVE.state);
  });
});

describe.skipIf(!built)('PB156-100 verification ledger — 출처로 거르지 않는다 · 공용 기록 표지', () => {
  const RED: Row[] = [
    { work: '대화 상태 B — 미니맵 H 요청서와 체크리스트를 정리했다', origin: 'unknown', at: '2026-10-23 02:00:00' },
    { work: 'BLOCKED — 원인: 빌드 실패 / 재개 조건: 링커 오류 해결', origin: 'loop', at: '2026-10-23 04:00:00', verification: 'build FAIL (exit 2)' },
  ];
  const ledgerLine = (out: string) => out.split(/\r?\n/).find(l => l.includes('Heads up')) ?? '';
  const localTs = (dbPath: string, at: string) => {
    const db = new Database(dbPath, { readonly: true });
    const v = (db.prepare("SELECT datetime(?, 'localtime') AS t").get(at) as { t: string }).t;
    db.close();
    return v;
  };

  it('대화 카드에도 loop 실패 기록이 그대로(대상·시점·결과) — 「project-wide verification record」 표지', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, RED, { state: RED[0].work, at: '2026-10-23 02:00:01' });
    const line = ledgerLine(start(ws, proj));
    expect(line).toBe(`⚠️ **Heads up** (project-wide verification record — sessions of every origin, loop runs included): a recent session (${localTs(dbPath, RED[1].at)}) ended with the build was failing. Check before building on top.`);
  });

  it('loop 카드도 같은 줄', () => {
    const { ws, proj, dbPath } = workspace();
    seed(dbPath, RED, { state: RED[0].work, at: '2026-10-23 02:00:01' });
    expect(ledgerLine(start(ws, proj, 'loop'))).toContain(`(${localTs(dbPath, RED[1].at)}) ended with the build was failing`);
  });
});

describe.skipIf(!built)('PB156-300 옛 DB(2.7.2 · run_origin 칸 없음) — 첫 SessionStart 는 Stop 이전에도 오류 없음', () => {
  function oldDb(dbPath: string) {
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_work TEXT, current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
      session_id TEXT, prompt_id TEXT, user_intent TEXT, file_coverage TEXT, workspace_writes TEXT)`);
    old.exec(`CREATE TABLE active_context (project TEXT PRIMARY KEY, current_state TEXT, active_tasks TEXT, recent_files TEXT,
      blockers TEXT, last_verification TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    old.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES ('game', '옛 루프 기록 — 게이트 실행 기록을 정비했다', '2026-10-22 10:00:00')").run();
    old.prepare("INSERT INTO active_context (project, current_state, updated_at) VALUES ('game', '옛 루프 기록 — 게이트 실행 기록을 정비했다', '2026-10-22 10:00:01')").run();
    old.close();
  }

  it('첫 SessionStart: 오류 없이 State 를 origin unknown 으로 · 출처 칸을 만들지 않는다(이행은 Stop 몫)', () => {
    const { ws, proj, dbPath } = workspace();
    oldDb(dbPath);
    const s = stateLines(start(ws, proj));
    expect(s).toEqual(['📍 **State**: 옛 루프 기록 — 게이트 실행 기록을 정비했다 _(recorded 2026-10-22 10:00 (DB time) · origin unknown)_']);
    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name);
    db.close();
    expect(cols).not.toContain('run_origin');
  });

  it('이어서 loop Stop → 같은 Stop 재전달 → 한 행 · 다음 대화 카드 State 에 그 loop 글 없음', () => {
    const { ws, proj, dbPath } = workspace();
    oldDb(dbPath);
    start(ws, proj, 'loop');
    const t = path.join(ws, 'l.jsonl');
    fs.writeFileSync(t, [
      { uuid: 'lu', type: 'user', message: { role: 'user', content: '랄프 루프 지침' } },
      { uuid: 'la', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '루프 — 체크리스트 자기검사를 붙였습니다.' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    const dropLocks = () => { for (const f of fs.readdirSync(path.join(ws, '.claude'))) if (f.startsWith('.session-end-')) fs.rmSync(path.join(ws, '.claude', f)); };
    hook(SESSION_END, ws, { cwd: proj, session_id: 'L', transcript_path: t }, 'loop');
    dropLocks();
    hook(SESSION_END, ws, { cwd: proj, session_id: 'L', transcript_path: t }, 'loop');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT last_work, run_origin FROM sessions WHERE project = 'game' AND session_id = 'L'").all() as Array<{ last_work: string; run_origin: string | null }>;
    const active = db.prepare("SELECT current_state FROM active_context WHERE project = 'game'").get() as { current_state: string };
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].run_origin).toBe('loop');
    const s = stateLines(start(ws, proj)).join('\n');
    // Stop 이 State 를 덮었든(첫 기록) 안 덮었든 — 대화 카드에 loop 글은 나오지 않는다
    if (active.current_state === rows[0].last_work) expect(s).not.toContain(rows[0].last_work);
    expect(s).not.toContain('체크리스트 자기검사');
  });
});
