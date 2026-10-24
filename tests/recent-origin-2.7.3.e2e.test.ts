// 2.7.3 — 대화 카드의 Recent Sessions 에서 확인된 loop 행 제외 (Astra reply-154 PB154-B) + 첫 줄 경고의 훅 경로(PB154-D)
//
// 계약: 출처 필터를 먼저(WHERE) 걸고 LIMIT 3 · 현재 세션이 loop 면 기존 동작 · unknown(옛 행 포함)은 남기되 표시 ·
// DB 행 삭제 없음 · 공회전 저장 생략 기각(변경 0 기록도 남는다).
// 역검증(reply-154 §4 B): 최신 loop 3 행 앞에 대화 행 배치 → 대화 슬롯이 비거나 loop 가 나오면 빨강 ·
// 커밋 없는 BLOCKED·진단 결과 → DB 에서 사라지면 빨강.

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
const built = fs.existsSync(SESSION_START);
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

type Row = { work: string; origin: 'loop' | 'unknown' | null; at: string; intent?: string };

function workspace(rows: Row[], withOriginColumn = true) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-273b-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  const dbPath = path.join(ws, '.claude', 'sessions.db');
  const db = new Database(dbPath);
  migrateSchema(db);
  if (withOriginColumn) {
    const ins = db.prepare("INSERT INTO sessions (project, last_work, timestamp, run_origin, user_intent) VALUES ('game', ?, ?, ?, ?)");
    for (const r of rows) ins.run(r.work, r.at, r.origin, r.intent ?? null);
  } else {
    db.exec('ALTER TABLE sessions DROP COLUMN run_origin');      // 2.7.2 까지의 모양
    const ins = db.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES ('game', ?, ?)");
    for (const r of rows) ins.run(r.work, r.at);
  }
  db.close();
  return { ws, proj, dbPath };
}

function start(ws: string, proj: string, role?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws };
  delete env.PASSBATON_ROLE;
  if (role !== undefined) env.PASSBATON_ROLE = role;
  const r = spawnSync('node', [SESSION_START], { input: JSON.stringify({ cwd: proj, session_id: 'S', source: 'startup' }), encoding: 'utf-8', env });
  expect(r.status, r.stderr?.slice(0, 300)).toBe(0);
  return r.stdout;
}

const recent = (out: string) => {
  const lines = out.split(/\r?\n/);
  const i = lines.indexOf('## Recent Sessions');
  if (i < 0) return [];
  const rest = lines.slice(i + 1);
  const end = rest.findIndex(l => !l.startsWith('- ') && !l.startsWith('  '));
  return (end < 0 ? rest : rest.slice(0, end)).filter(l => l.startsWith('- '));
};
const count = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project = 'game'").get() as { n: number }).n;
  db.close();
  return n;
};

// 대화 행 둘(오래됨) → 그 뒤 최신 loop 행 셋 · 하나는 커밋 없는 BLOCKED 진단
const ROWS: Row[] = [
  { work: '대화 A — 지도 렌더 조사 결과와 다음 단계 정리', origin: 'unknown', at: '2026-10-23 01:00:00' },
  { work: '대화 B — 미니맵 H 요청서를 정리하고 체크리스트를 만들었다', origin: null, at: '2026-10-23 02:00:00' },
  { work: '루프 1 — 이번 루프에서도 아무것도 하지 않았습니다', origin: 'loop', at: '2026-10-23 03:00:00' },
  { work: 'BLOCKED — 원인: 빌드 서버 응답 없음 / 재개 조건: 재기동', origin: 'loop', at: '2026-10-23 04:00:00' },
  { work: '루프 3 — 이번 루프에서도 아무것도 하지 않았습니다', origin: 'loop', at: '2026-10-23 05:00:00' },
];

describe.skipIf(!built)('PB154-B 대화 카드의 Recent Sessions — 필터 먼저, LIMIT 나중', () => {
  it('최신 loop 3 행 앞의 대화 행이 슬롯을 채운다 · loop 행은 안 나온다 · unknown 은 표시', () => {
    const { ws, proj } = workspace(ROWS);
    const r = recent(start(ws, proj));
    expect(r).toHaveLength(2);
    expect(r.join('\n')).not.toContain('루프');
    expect(r.join('\n')).not.toContain('BLOCKED');
    expect(r[0]).toContain('대화 B');
    expect(r[1]).toContain('대화 A');
    for (const l of r) expect(l).toMatch(/^- \[2026-10-23\] \[origin unknown\] /);
  });

  it('대화 행이 넷 이상이면 3 칸이 모두 대화 행', () => {
    const more: Row[] = [
      ...ROWS,
      { work: '대화 C — 원천 직접 읽기 계약을 다시 확인했다', origin: 'unknown', at: '2026-10-23 00:30:00' },
      { work: '대화 D — 오래된 기록이지만 대화 세션의 것이다', origin: null, at: '2026-10-22 23:00:00' },
    ];
    const { ws, proj } = workspace(more);
    const r = recent(start(ws, proj));
    expect(r).toHaveLength(3);
    expect(r.map(l => l.match(/대화 [A-D]/)?.[0])).toEqual(['대화 B', '대화 A', '대화 C']);
  });

  it('현재 세션이 loop 면 기존 동작 — 최신 3 행(loop 포함) · 표시 없음', () => {
    const { ws, proj } = workspace(ROWS);
    const r = recent(start(ws, proj, 'loop'));
    expect(r).toHaveLength(3);
    expect(r[0]).toContain('루프 3');
    expect(r[1]).toContain('BLOCKED');
    expect(r.join('\n')).not.toContain('[origin unknown]');
  });

  it('잘못된 값(Loop)은 loop 가 아니다 → 대화 카드 취급', () => {
    const { ws, proj } = workspace(ROWS);
    expect(recent(start(ws, proj, 'Loop')).join('\n')).not.toContain('루프');
  });

  it('DB 행은 지워지지 않는다 — BLOCKED·공회전 loop 행이 그대로', () => {
    const { ws, proj, dbPath } = workspace(ROWS);
    start(ws, proj);
    start(ws, proj, 'loop');
    expect(count(dbPath)).toBe(ROWS.length);
    const db = new Database(dbPath, { readonly: true });
    const blocked = db.prepare("SELECT run_origin FROM sessions WHERE last_work LIKE 'BLOCKED%'").get() as { run_origin: string } | undefined;
    db.close();
    expect(blocked?.run_origin).toBe('loop');
  });

  it('출처 칸이 없는 옛 DB → 거르지 않고 전부 [origin unknown] (loop 로 확인된 행이 없다)', () => {
    const { ws, proj } = workspace(ROWS, false);
    const r = recent(start(ws, proj));
    expect(r).toHaveLength(3);
    for (const l of r) expect(l).toContain('[origin unknown]');
  });

  // reply-165 PB165-210 (O3): 2.7.2 가 쓴 랄프 행은 출처가 NULL 이다 — 요청 글(intent)·요약 문구로 loop 라고 소급하지 않는다.
  //   그 행은 계약대로 남고(unknown 표시) · 명시적 loop 행만 빠지며 · 필터는 LIMIT 앞이다.
  it('NULL 출처 + 랄프 같은 intent·요약 → 남는다(intent 로 출처 추정 안 함) · 명시 loop 만 빠진다', () => {
    const rows: Row[] = [
      { work: '대화 A — 지도 렌더 조사 결과와 다음 단계 정리', origin: 'unknown', at: '2026-10-23 01:00:00' },
      { work: '실행 래퍼(b81qgl3wk)가 10 분 시간 제한으로 정리됐습니다', origin: null, at: '2026-10-24 02:00:00', intent: 'Ashfall — Ralph 루프 지침' },
      { work: '루프 1 — 이번 루프에서도 아무것도 하지 않았습니다', origin: 'loop', at: '2026-10-24 03:00:00', intent: 'Ashfall — Ralph 루프 지침' },
      { work: '루프 2 — 게이트 실행 기록을 정비했습니다', origin: 'loop', at: '2026-10-24 04:00:00', intent: 'Ashfall — Ralph 루프 지침' },
      { work: '루프 3 — 이번 루프에서도 아무것도 하지 않았습니다', origin: 'loop', at: '2026-10-24 05:00:00', intent: 'Ashfall — Ralph 루프 지침' },
    ];
    const { ws, proj } = workspace(rows);
    const r = recent(start(ws, proj));
    expect(r).toEqual([
      '- [2026-10-24] [origin unknown] 실행 래퍼(b81qgl3wk)가 10 분 시간 제한으로 정리됐습니다 _(via unknown)_',
      '- [2026-10-23] [origin unknown] 대화 A — 지도 렌더 조사 결과와 다음 단계 정리 _(via unknown)_',
    ]);
  });
});

describe.skipIf(!built)('PB154-D 훅 경로 — 경고는 카드 첫 줄', () => {
  it('SessionStart 출력에서 카드의 첫 줄이 ⚠ CURRENT TASK UNKNOWN', () => {
    const { ws, proj } = workspace(ROWS);
    fs.mkdirSync(path.join(proj, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.ralph', 'fix_plan.md'), '# fix_plan\r\n\r\n## 이력\r\n- [x] 끝\r\n');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources: [
      { path: '.ralph/fix_plan.md', block: '지금 할 일', role: 'current-task' },
    ] } }));
    const lines = start(ws, proj).split(/\r?\n/);
    const head = lines.findIndex(l => l.startsWith('# game - Session Resumed'));
    const firstCardLine = lines.slice(head + 1).find(l => l.trim() !== '');
    expect(firstCardLine).toMatch(/^⚠ CURRENT TASK UNKNOWN — block "지금 할 일" not found/);
  });
});
