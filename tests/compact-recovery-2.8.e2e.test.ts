// 2.8 — 컴팩션 복구 보완 (Astra reply-174 PB174-010 (b)·(d))
//
// (b) 훅 전용 DB(MCP 서버가 만드는 project_context 표 없음)에서 PreCompact 가 뒤쪽 project_context 조회에서 던져
//     사람용 systemMessage 가 안 나갔다(status=error) — 인계 행은 그 전에 적혀 있었다. 표 **부재만** 건너뛴다.
//     ⛔ 모든 예외를 삼켜 성공으로 만드는 수정은 불허 — 표가 있는데 조회가 깨지면 그대로 status=error 여야 한다.
// (d) SessionStart(compact) 가 「Last human request (a request, not a result): <system-reminder id="…">」 를 냈다.
//     원인 둘: ① `<system-reminder id=…>` 처럼 속성 달린 알림을 못 벗겼다 ② 트랜스크립트의 `api-request-blob`
//     (API 요청 사본 · message.role 'user')을 사람 줄로 셌다(최상위 type 보다 message.role 을 먼저 봤다).
//     사람 요청을 못 가리면 「not identified」 로 쓴다 · 진짜 사람 요청은 그대로 나와야 한다(모두 숨김 = 빨강).
//
// 원칙: 「없음」 단언마다 같은 시험 안에 양의 효과(훅 종료 0 · 인계 행 · 출력)를 같이 본다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { humanTurn } from '../src/utils/human-turn.js';
import { entriesToMessages } from '../src/utils/handover.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const PRE_COMPACT = path.resolve(here, '../dist/hooks/pre-compact.js');
const SERVER = path.resolve(here, '../dist/index.js');
const built = [SESSION_START, PRE_COMPACT, SERVER].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-174c-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function run(file: string, ws: string, payload: Record<string, unknown>) {
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

const tables = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name); }
  finally { db.close(); }
};
const handoverRow = (dbPath: string, sid: string) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT request, active_file FROM compact_handover WHERE session_id = ?').get(sid) as
      { request: string | null; active_file: string | null } | undefined;
  } finally { db.close(); }
};
const lastDebugLine = (ws: string) =>
  fs.readFileSync(path.join(ws, '.claude', 'pre-compact-debug.log'), 'utf8').trim().split(/\r?\n/).pop() ?? '';

type Line = Record<string, unknown>;
const human = (text: string): Line => ({ type: 'user', uuid: '', message: { role: 'user', content: text } });
const reply = (text: string, edit?: string): Line => ({ type: 'assistant', uuid: '', message: { role: 'assistant', content: [
  { type: 'text', text },
  ...(edit ? [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: edit } }] : []),
] } });
/** 실측 모양(2026-10-24 이 PC 메인 트랜스크립트): 다른 세션·에이전트 메시지 알림은 속성 달린 system-reminder */
const REMINDER = '<system-reminder id="a4cc82f88a974ea2">\nAnother Claude session sent a message while you were working:\n'
  + '<agent-message from="a4aba3082f37a0de2">\n[Subagent finished]\n</agent-message>\n</system-reminder>';
/** API 로 보낸 요청 사본 — 대화 줄이 아니다(uuid 없음 · message.role 'user') */
const requestBlob = (): Line => ({ type: 'api-request-blob', sessionId: 's1', hash: 'h1', message: { role: 'user', content: [
  { type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: REMINDER },
] } });
/** 알림 렌더 줄 */
const attachment = (): Line => ({ type: 'attachment', uuid: '', attachment: { type: 'queued_command' }, rendered: [{ content: REMINDER }], renderedRole: 'user' });
/** 같은 알림이 user 줄 글로 온 경우 */
const reminderAsUserLine = (): Line => ({ type: 'user', uuid: '', message: { role: 'user', content: REMINDER } });

function transcript(ws: string, lines: Line[]): string {
  const p = path.join(ws, 't.jsonl');
  fs.writeFileSync(p, lines.map((l, i) => JSON.stringify('uuid' in l ? { ...l, uuid: `u${i}` } : l)).join('\n') + '\n');
  return p;
}

/** SessionStart(새 DB) → PreCompact → SessionStart(compact). 훅만 — MCP 서버 없음 */
function compactCycle(lines: Line[]) {
  const { ws, proj, dbPath } = workspace();
  run(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'startup' });
  const tp = transcript(ws, lines);
  run(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: tp });
  const out = run(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: tp });
  return { out, row: handoverRow(dbPath, 's1') };
}

function rpcInit(ws: string) {
  const msgs = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }];
  const r = spawnSync('node', [SERVER], { input: msgs.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf-8',
    env: { ...process.env, WORKSPACE_ROOT: ws }, timeout: 60000 });
  expect(r.stdout).toContain('"id":0');
}

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!built)('PB174-010 (b) PreCompact — 선택 원천 project_context 부재', () => {
  const precompact = (ws: string, proj: string, sid: string, request: string) => {
    const tp = transcript(ws, [human(request), reply('네, 진행합니다.')]);
    const raw = run(PRE_COMPACT, ws, { cwd: proj, session_id: sid, transcript_path: tp, trigger: 'manual' });
    return JSON.parse(raw) as { continue: boolean; systemMessage?: string };
  };
  const lineCount = (m?: string) => Number(m?.match(/\((\d+)줄\)/)?.[1] ?? NaN);

  it('훅 전용 DB: 인계 행도 저장되고 사람용 systemMessage 도 나온다(status=ok)', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'b1', source: 'startup' });
    expect(tables(dbPath), 'precondition: hooks-only db has no project_context').not.toContain('project_context');
    const out = precompact(ws, proj, 'b1', '청크 경계 고쳐줘');
    expect(out.continue).toBe(true);
    expect(out.systemMessage).toContain('컴팩션 복구 컨텍스트 저장됨');
    expect(handoverRow(dbPath, 'b1')?.request).toBe('청크 경계 고쳐줘');
    expect(lastDebugLine(ws)).toContain('status=ok');
  });

  it('완전 DB(MCP 서버가 만든 project_context): 메시지·인계 둘 다 · tech_stack 행이 있으면 실제로 읽는다(줄 +1)', () => {
    const { ws, proj, dbPath } = workspace();
    rpcInit(ws);
    run(SESSION_START, ws, { cwd: proj, session_id: 'b2', source: 'startup' });
    expect(tables(dbPath), 'precondition: full db has project_context').toContain('project_context');
    const before = precompact(ws, proj, 'b2', '셰이더 캐시 정리해줘');
    expect(before.systemMessage).toContain('컴팩션 복구 컨텍스트 저장됨');
    expect(handoverRow(dbPath, 'b2')?.request).toBe('셰이더 캐시 정리해줘');
    expect(lastDebugLine(ws)).toContain('status=ok');
    const db = new Database(dbPath);
    db.prepare('INSERT INTO project_context (project, tech_stack) VALUES (?, ?)').run('game', JSON.stringify({ engine: 'unreal' }));
    db.close();
    const after = precompact(ws, proj, 'b2', '셰이더 캐시 정리해줘');
    expect(lineCount(after.systemMessage)).toBe(lineCount(before.systemMessage) + 1);
  });

  it('⛔ 표는 있는데 조회가 깨지면(tech_stack 칸 없음) 성공으로 바꾸지 않는다 — status=error · systemMessage 없음', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 'b3', source: 'startup' });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE project_context (project TEXT PRIMARY KEY)');
    db.close();
    const out = precompact(ws, proj, 'b3', '청크 경계 고쳐줘');
    expect(out.continue).toBe(true);                       // 컴팩션은 막지 않는다(fail-soft)
    expect(out.systemMessage).toBeUndefined();
    expect(lastDebugLine(ws)).toMatch(/status=error .*tech_stack/);
    expect(handoverRow(dbPath, 'b3')?.request).toBe('청크 경계 고쳐줘');   // 그 전 단계는 이미 일했다
  });
});

describe('PB174-010 (d) 사람 요청 판별 — 사건 출처와 알림 봉투', () => {
  it('속성 달린 system-reminder 는 벗긴다 · 뒤에 붙은 사람 글은 남는다(양성)', () => {
    expect(humanTurn({ type: 'user', message: { content: REMINDER } }).text).toBe('');
    expect(humanTurn({ type: 'user', message: { content: `${REMINDER}\n청크 경계 고쳐줘` } }).text).toBe('청크 경계 고쳐줘');
    expect(humanTurn({ type: 'user', message: { content: '청크 경계 고쳐줘' } }).text).toBe('청크 경계 고쳐줘');
  });

  it('닫히지 않은(잘린) system-reminder 는 사람 원문이 아니다 — 「가를 수 없음」 표지', () => {
    const t = humanTurn({ type: 'user', message: { content: '<system-reminder id="x1">\nAnother Claude session sent a mess' } });
    expect(t.text).toBe('');
    expect(t.uncertain).toBe(true);
  });

  it('api-request-blob·attachment 는 대화 줄이 아니다 — 최상위 type 이 먼저 · 진짜 user/assistant 줄과 type 없는 줄은 그대로', () => {
    const msgs = entriesToMessages([
      human('청크 경계 고쳐줘'), reply('고칩니다.'), requestBlob(), attachment(),
      { type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: '사본 답' }] } },
      { role: 'user', content: 'type 없는 다른 호스트 줄' },
    ] as never);
    expect(msgs.map(m => `${m.role}:${m.content}`)).toEqual(['user:청크 경계 고쳐줘', 'assistant:고칩니다.', 'user:type 없는 다른 호스트 줄']);
  });
});

describe.skipIf(!built)('PB174-010 (d) SessionStart(compact) 출력', () => {
  it('알림·요청 사본이 뒤에 와도 진짜 사람 요청이 「Last human request」 로 나온다(양성 대조 — 모두 숨김은 빨강)', () => {
    const { out, row } = compactCycle([
      human('청크 경계 고쳐줘'), reply('고칩니다.'), requestBlob(), attachment(), reminderAsUserLine(),
    ]);
    expect(out).toContain('♻️ **Recovered after compaction**');
    expect(out).toContain('- Last human request (a request, not a result): 청크 경계 고쳐줘');
    expect(row?.request).toBe('청크 경계 고쳐줘');
    expect(out).not.toContain('<system-reminder');
    expect(out).not.toContain('Another Claude session');
    expect(out).not.toContain('not identified');
  });

  it('사람 요청이 창에 없으면(알림·사본뿐) 「not identified」 라고 쓴다 — 알림을 사람 요청이라 부르지 않는다', () => {
    const live = 'apps/game/src/a.ts';
    const { out, row } = compactCycle([requestBlob(), reply('편집했습니다.', live), attachment(), reminderAsUserLine()]);
    expect(row?.request ?? null).toBeNull();
    expect(row?.active_file).toContain(live);
    expect(out).toContain('♻️ **Recovered after compaction**');
    expect(out).toContain('- Last human request: not identified');
    expect(out).toContain(`- Active file: ${live}`);
    expect(out).not.toContain('<system-reminder');
    expect(out).not.toContain('Last human request (a request, not a result)');
  });
});
