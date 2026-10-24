// 2.8 — active_context 칸별 쓰기 (Astra reply-170 PB170-010 · C5)
//
// 결함: 쓰는 곳 여섯이 모두 「자기 칸만 적은 INSERT OR REPLACE」 였다. REPLACE 는 행을 지우고 다시 넣으므로
// 적지 않은 칸이 NULL 이 된다 — Edit 한 번에 State·blockers·state_source·검증 기록이 사라지고(턴 중 컴팩션이면
// 카드에 State 가 없다), 그 NULL 이 Stop 의 hadState 를 거짓으로 만들어 「증거 없는 턴은 State 를 안 덮음」 이 무력화됐다.
//
// 계약: 넘긴 칸만 바꾼다 · 생략은 보존 · 명시적 비우기(null·빈 문자열)는 그대로 지운다 · State 글을 바꾸면 출처도 그 글의 것 ·
// recent_files·검증 기록만 바꾸는 쓰기는 State 의 기록 시각(updated_at)을 올리지 않는다 · 신규 행·옛 DB 도 같은 규칙.
// 실제 연결된 쓰기 경로(실물 훅 · 실물 MCP 서버 stdio)로만 쓴다 — 함수 직접 호출은 연결을 증명하지 않는다.
// 정상 결과 보존(양성 대조): 바뀌어야 할 칸은 실제로 바뀌고, 카드에 State·Blocker 가 실제로 나온다 — 「아무것도 안 쓰는」 구현은 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const POST_TOOL = path.resolve(here, '../dist/hooks/post-tool-use.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const SERVER = path.resolve(here, '../dist/index.js');
const built = [POST_TOOL, SESSION_END, SESSION_START, SERVER].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

type Active = { current_state: string | null; state_source: string | null; active_tasks: string | null; recent_files: string | null;
  blockers: string | null; last_verification: string | null; updated_at: string | null };
const SEEDED: Active = {
  current_state: '지형 청크 로더 경계 계산을 고쳤고 골든 스냅샷까지 갱신했다', state_source: 'commit', active_tasks: 'T0 — 미니맵',
  recent_files: '["old.ts"]', blockers: 'B0 — 셰이더 캐시 재생성 대기', last_verification: 'all:passed', updated_at: '2026-10-20 01:00:00',
};

/** 옛 스키마(state_source 칸 없음)로 만든 DB — 훅·서버가 스스로 이행한다(옛 DB 경로). */
function workspace(seed: Active | null = SEEDED, withStateSource = true) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-28ac-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  const dbPath = path.join(ws, '.claude', 'sessions.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE active_context (project TEXT PRIMARY KEY, current_state TEXT, active_tasks TEXT, recent_files TEXT,
    blockers TEXT, last_verification TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP${withStateSource ? ', state_source TEXT' : ''})`);
  if (seed) {
    db.prepare(`INSERT INTO active_context (project, current_state, active_tasks, recent_files, blockers, last_verification, updated_at${withStateSource ? ', state_source' : ''})
      VALUES ('game', ?, ?, ?, ?, ?, ?${withStateSource ? ', ?' : ''})`)
      .run(seed.current_state, seed.active_tasks, seed.recent_files, seed.blockers, seed.last_verification, seed.updated_at,
        ...(withStateSource ? [seed.state_source] : []));
  }
  db.close();
  return { ws, proj, dbPath };
}

function row(dbPath: string): Active | undefined {
  const db = new Database(dbPath, { readonly: true });
  const cols = new Set((db.prepare('PRAGMA table_info(active_context)').all() as Array<{ name: string }>).map(c => c.name));
  const r = db.prepare(`SELECT current_state, active_tasks, recent_files, blockers, last_verification, updated_at${cols.has('state_source') ? ', state_source' : ', NULL AS state_source'}
    FROM active_context WHERE project = 'game'`).get() as Active | undefined;
  db.close();
  return r;
}

function hook(file: string, ws: string, payload: Record<string, unknown>): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws };
  delete env.PASSBATON_ROLE;
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  expect(r.stderr ?? '').not.toMatch(/SqliteError/);
  return r.stdout;
}
const edit = (ws: string, proj: string, file: string, sessionId = 'S') => hook(POST_TOOL, ws, {
  cwd: proj, session_id: sessionId, tool_name: 'Edit', tool_input: { file_path: path.join(proj, file), old_string: 'a', new_string: 'a\nb' },
});
function stop(ws: string, proj: string, sessionId: string, summary: string): void {
  const t = path.join(ws, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(t, [
    { type: 'user', message: { content: summary } },
    { type: 'assistant', message: { content: `구현 완료 — ${summary} 를 처리했고 검증까지 마쳤습니다.` } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  hook(SESSION_END, ws, { cwd: proj, session_id: sessionId, transcript_path: t });
}
const compactStart = (ws: string, proj: string) => hook(SESSION_START, ws, { cwd: proj, session_id: 'S', source: 'compact' });
const stateLines = (out: string) => out.split(/\r?\n/).filter(l => l.startsWith('📍') || l.startsWith('🚧'));

function rpc(ws: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>, extraEnv: Record<string, string> = {}) {
  const msgs = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    ...calls.map((c, i) => ({ jsonrpc: '2.0', id: 1 + i, method: 'tools/call', params: c })),
  ];
  const r = spawnSync('node', [SERVER], {
    input: msgs.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf-8',
    env: { ...process.env, WORKSPACE_ROOT: ws, ...extraEnv }, timeout: 60000,
  });
  const out = r.stdout.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as { id: number; result?: { content?: Array<{ text: string }> } });
  for (let i = 0; i < calls.length; i++) {
    expect(out.find(m => m.id === 1 + i)?.result, `${calls[i].name} answered (stderr: ${r.stderr?.slice(0, 300)})`).toBeTruthy();
  }
  return out;
}

describe.skipIf(!built)('PB170-010 C5 — Edit 뒤 Stop 전(턴 중 컴팩션 구간)', () => {
  it('Edit 는 recent_files 만 바꾼다 — State·state_source·blockers·검증·active_tasks·기록 시각 보존', () => {
    const { ws, proj, dbPath } = workspace();
    edit(ws, proj, 'src/a.ts');
    const r = row(dbPath)!;
    expect(JSON.parse(r.recent_files ?? '[]')).toEqual([path.join(proj, 'src/a.ts'), 'old.ts']);   // 양성: 바뀔 칸은 바뀐다
    expect({ ...r, recent_files: SEEDED.recent_files }).toEqual(SEEDED);
  });

  it('그 사이 컴팩션 카드에 State·출처·Blocker 가 그대로 나온다(양성 대조 — 출력 없음은 빨강)', () => {
    const { ws, proj } = workspace();
    edit(ws, proj, 'src/a.ts');
    expect(stateLines(compactStart(ws, proj))).toEqual([
      `📍 **Last recorded state** (DB · from the last Stop, not from this compaction): ${SEEDED.current_state} _(via commit message · recorded 2026-10-20 01:00 (DB time) · origin unknown · not linked to a session record)_`,
      `🚧 **Blocker**: ${SEEDED.blockers}`,
    ]);
  });

  it('다른 세션의 Edit 뒤 증거 없는 Stop 은 State 를 덮지 않는다 — Edit 가 hadState 를 거짓으로 만들지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    edit(ws, proj, 'src/other.ts', 'OTHER');
    stop(ws, proj, 'S', '경로 한 줄만 물어본 턴');
    const r = row(dbPath)!;
    expect(r.current_state).toBe(SEEDED.current_state);
    expect(r.state_source).toBe('commit');
    expect(r.updated_at).toBe(SEEDED.updated_at);
  });
});

describe.skipIf(!built)('PB170-010 C5 — Edit → Stop', () => {
  it('Stop 은 State·출처·recent_files 만 — blockers·검증·active_tasks 보존', () => {
    const { ws, proj, dbPath } = workspace();
    edit(ws, proj, 'src/a.ts');
    stop(ws, proj, 'S', '식량 소비 곡선을 인구 티어별로 나눴다');
    const r = row(dbPath)!;
    expect(r.current_state).toContain('식량 소비 곡선');                         // 양성: Stop 의 칸은 바뀐다
    expect(r.state_source).not.toBe('commit');                                     // 앞 글의 출처가 새 글에 붙지 않는다
    expect(['assistant-text', 'fallback', 'no-result']).toContain(r.state_source);
    expect(JSON.parse(r.recent_files ?? '[]')).toEqual([path.join(proj, 'src/a.ts')]);
    expect(r.updated_at).not.toBe(SEEDED.updated_at);
    expect(r.blockers).toBe(SEEDED.blockers);
    expect(r.last_verification).toBe(SEEDED.last_verification);
    expect(r.active_tasks).toBe(SEEDED.active_tasks);
  });

  it('신규 행 — 행이 없을 때 Edit 가 행을 만들고(State 없음), 이어지는 Stop 이 State 를 채운다', () => {
    const { ws, proj, dbPath } = workspace(null);
    edit(ws, proj, 'src/a.ts');
    expect(row(dbPath)).toMatchObject({ current_state: null, blockers: null, recent_files: JSON.stringify([path.join(proj, 'src/a.ts')]) });
    stop(ws, proj, 'S', '청크 로더 캐시 무효화 순서를 바로잡았다');
    expect(row(dbPath)?.current_state).toContain('청크 로더 캐시');
  });

  it('옛 DB(state_source 칸 없음) — 이행 뒤에도 다른 칸 보존 · 출처는 새 글의 것', () => {
    const { ws, proj, dbPath } = workspace(SEEDED, false);
    edit(ws, proj, 'src/a.ts');
    expect(row(dbPath)).toMatchObject({ current_state: SEEDED.current_state, blockers: SEEDED.blockers, last_verification: SEEDED.last_verification });
    stop(ws, proj, 'S', '세이브 포맷 이행 시험을 추가했다');
    const r = row(dbPath)!;
    expect(r.current_state).toContain('세이브 포맷');
    expect(r.blockers).toBe(SEEDED.blockers);
    expect(r.last_verification).toBe(SEEDED.last_verification);
  });
});

describe.skipIf(!built)('PB170-010 C5 — MCP 쓰기 경로(실물 서버 stdio)', () => {
  it('session_end: 생략한 blockers·modifiedFiles 는 보존 · State 출처는 unknown(NULL) · 검증 기록 보존', () => {
    const { ws, dbPath } = workspace();
    rpc(ws, [{ name: 'session_end', arguments: { project: 'game', summary: 'MCP 로 남긴 세션 요약 — 경계 시험 정리' } }]);
    const r = row(dbPath)!;
    expect(r.current_state).toBe('MCP 로 남긴 세션 요약 — 경계 시험 정리');
    expect(r.state_source).toBeNull();
    expect(r.blockers).toBe(SEEDED.blockers);
    expect(r.recent_files).toBe(SEEDED.recent_files);
    expect(r.last_verification).toBe(SEEDED.last_verification);
    expect(r.active_tasks).toBe(SEEDED.active_tasks);
  });

  it('session_end: 명시적 비우기(빈 문자열 · null)는 기존 계약대로 지운다 · 넘긴 파일 목록은 적는다', () => {
    const a = workspace();
    rpc(a.ws, [{ name: 'session_end', arguments: { project: 'game', summary: '블로커 해소 — 캐시 재생성 끝', blockers: '', modifiedFiles: ['x.ts'] } }]);
    expect(row(a.dbPath)).toMatchObject({ blockers: null, recent_files: '["x.ts"]', last_verification: SEEDED.last_verification });
    const b = workspace();
    rpc(b.ws, [{ name: 'session_end', arguments: { project: 'game', summary: '블로커 해소 — 캐시 재생성 끝', blockers: null } }]);
    expect(row(b.dbPath)?.blockers).toBeNull();
    const c = workspace();
    rpc(c.ws, [{ name: 'session_end', arguments: { project: 'game', summary: '새 블로커 생김', blockers: 'B1 — 서명 키 없음' } }]);
    expect(row(c.dbPath)?.blockers).toBe('B1 — 서명 키 없음');
  });

  it('project_init: State 글만 — blockers·검증·recent_files 보존', () => {
    const { ws, dbPath } = workspace();
    rpc(ws, [{ name: 'project_init', arguments: { project: 'game' } }]);
    expect(row(dbPath)).toMatchObject({ current_state: 'Project initialized', state_source: null,
      blockers: SEEDED.blockers, last_verification: SEEDED.last_verification, recent_files: SEEDED.recent_files });
  });

  it('verify_build · verify_all: 검증 칸만 — State·출처·blockers·기록 시각 보존', () => {
    const { ws, proj, dbPath } = workspace();
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'game' }));
    const bin = path.join(ws, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '@exit /b 0\r\n');
    fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
    const env = { [key]: `${bin}${path.delimiter}${process.env[key] ?? ''}` };
    rpc(ws, [{ name: 'verify_build', arguments: { project: 'game' } }], env);
    expect(row(dbPath)).toEqual({ ...SEEDED, last_verification: 'build:passed' });   // 양성: 검증 칸은 바뀐다
    rpc(ws, [{ name: 'verify_all', arguments: { project: 'game' } }], env);
    expect(row(dbPath)).toEqual({ ...SEEDED, last_verification: 'all:passed' });
  });
});
