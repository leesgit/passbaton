// PB195-300 (원장 L-06) — Stop 처리 진입 락: 중복 처리 없이, 남는 락 없이
//
// 락의 역할 = 같은 Stop 이벤트 재전달의 **처리 진입** 중복 방지(src/utils/stop-lock.ts 머리 주석).
// DB 판정이 못 막는 경우를 관측해야 락을 시험할 수 있다 → 두 관측:
//   - 「식별 못 한 이벤트」(세션은 있는데 트랜스크립트에 응답 레코드 없음): DB 가 일부러 중복 억제를 안 한다 → 행 수 = 처리 수
//   - `session-end-debug.log` 의 줄 수 = 락을 통과해 처리에 들어간 수(식별된 이벤트도)
// 네 경우: 정상 종료(누적 없음) · 같은 턴 재전달 · 동시 실행(처리 중 5 초 넘어도) · 강제 종료 뒤 재개.
// 시간은 락 내용의 at/doneAt 으로 흉내 낸다(실제로 60 초를 기다리지 않는다).

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as crypto from 'crypto';
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
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-195l-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  const dir = path.join(ws, '.claude');
  return { ws, proj, dir, dbPath: path.join(dir, 'sessions.db') };
}
const env = (ws: string) => ({ ...process.env, WORKSPACE_ROOT: ws });

function hook(file: string, ws: string, payload: Record<string, unknown>) {
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env: env(ws) });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
}
function hookAsync(ws: string, payload: Record<string, unknown>): Promise<number | null> {
  return new Promise(resolve => {
    const c = spawn('node', [SESSION_END], { env: env(ws), stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('close', code => resolve(code));
    c.stdin.end(JSON.stringify(payload));
  });
}

/** 응답 레코드 없는 트랜스크립트 — DB 가 중복 억제를 안 하는 「식별 못 한 이벤트」 */
function unidentified(ws: string, name = 'u.jsonl'): string {
  const p = path.join(ws, name);
  fs.writeFileSync(p, JSON.stringify({ uuid: 'u0', type: 'user', message: { role: 'user', content: '지도 화면 봐줘' } }) + '\n');
  return p;
}
/** 응답 레코드 있는 트랜스크립트 */
function identified(ws: string, name = 'a.jsonl'): string {
  const p = path.join(ws, name);
  fs.writeFileSync(p, [
    { uuid: 'u0', type: 'user', message: { role: 'user', content: '상점 정렬 고쳐줘' } },
    { uuid: 'a0', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '확인했습니다.' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/** 훅과 같은 키(transcript_path \0 턴) */
function keyOf(t: string, turn: string): string {
  return crypto.createHash('md5').update(`${t}\u0000${turn}`).digest('hex').slice(0, 16);
}
const sizeTurn = (t: string) => `size:${fs.statSync(t).size}`;
const lockFile = (dir: string, key: string) => path.join(dir, `.session-end-${key}.lock`);
const locks = (dir: string) => fs.readdirSync(dir).filter(f => /^\.session-end-.+\.lock$/.test(f)).sort();
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as { v: number; pid: number; at: number; token: string; doneAt?: number };

/** 모든 v2 락의 시각을 ms 만큼 과거로 — 시간 경과 흉내 */
function age(dir: string, ms: number) {
  for (const f of locks(dir)) {
    const p = path.join(dir, f);
    try {
      const j = readJson(p);
      fs.writeFileSync(p, JSON.stringify({ ...j, at: j.at - ms, ...(j.doneAt ? { doneAt: j.doneAt - ms } : {}) }));
    } catch { /* 옛 형식 — 손대지 않음 */ }
  }
}
const rows = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project = 'game'").get() as { n: number }).n;
  db.close();
  return n;
};
const entries = (dir: string, sid: string) => {
  const p = path.join(dir, 'session-end-debug.log');
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf-8').split(/\r?\n/).filter(l => l.includes(`sid=${sid} `)).length;
};
function deadPid(): number {
  const r = spawnSync('node', ['-e', '']);
  return r.pid;
}
function plant(p: string, body: Record<string, unknown>, mtimeMsAgo = 0) {
  fs.writeFileSync(p, JSON.stringify(body));
  if (mtimeMsAgo) { const t = new Date(Date.now() - mtimeMsAgo); fs.utimesSync(p, t, t); }
}

describe.skipIf(!built)('PB195-300 L-06 Stop 락 — 중복 처리 없이 · 남는 락 없이', () => {
  it('정상 종료: 턴마다 락이 생겨도 창이 지나면 다음 Stop 이 치운다 — 네 턴 뒤 락 1 개(마지막 것) · 행 4', () => {
    const { ws, proj, dir, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = identified(ws);
    for (const p of ['p1', 'p2', 'p3', 'p4']) {
      hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: p, transcript_path: t });
      const j = readJson(lockFile(dir, keyOf(t, p)));
      expect(j.v).toBe(2);
      expect(typeof j.doneAt).toBe('number');   // 끝나면 완료 표시
      age(dir, 61_000);
    }
    expect(rows(dbPath)).toBe(4);
    expect(locks(dir)).toEqual([`.session-end-${keyOf(t, 'p4')}.lock`]);
  });

  it('같은 턴 재전달(바로 다시 · 식별 못 한 이벤트): 처리는 한 번 — 행 1 · 진입 1', () => {
    const { ws, proj, dir, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = unidentified(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    expect(rows(dbPath)).toBe(1);
    expect(entries(dir, 'A')).toBe(1);
  });

  it('같은 턴 재전달(창 지난 뒤 · 식별된 이벤트): 락은 비켜 주고 DB 정체성이 거른다 — 행 1 · 남은 락 1', () => {
    const { ws, proj, dir, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = identified(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p1', transcript_path: t });
    age(dir, 6_000);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p1', transcript_path: t });
    expect(rows(dbPath)).toBe(1);
    expect(locks(dir)).toHaveLength(1);
  });

  it('동시 실행: 같은 이벤트 4 개를 한꺼번에 — 처리 1 · 행 1(식별 못 한 이벤트)', async () => {
    const { ws, proj, dir, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = unidentified(ws);
    const payload = { cwd: proj, session_id: 'A', transcript_path: t };
    const codes = await Promise.all([0, 1, 2, 3].map(() => hookAsync(ws, payload)));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(rows(dbPath)).toBe(1);
    expect(entries(dir, 'A')).toBe(1);
    expect(locks(dir)).toHaveLength(1);
  });

  it('동시 실행: 처리 중인 주인(살아 있는 pid)이 5 초 넘게 잡고 있어도 들어가지 않는다', () => {
    const { ws, proj, dir, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = unidentified(ws);
    fs.mkdirSync(dir, { recursive: true });
    plant(lockFile(dir, keyOf(t, sizeTurn(t))), { v: 2, pid: process.pid, at: Date.now() - 30_000, token: 'holder' }, 30_000);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    expect(rows(dbPath)).toBe(0);
    expect(entries(dir, 'A')).toBe(0);
    expect(readJson(lockFile(dir, keyOf(t, sizeTurn(t)))).token).toBe('holder');   // 남의 락을 고치지 않음
  });

  it('강제 종료 뒤 재개: 주인 pid 가 죽은 미완료 락(같은 키)은 비켜 준다 — 행 1 · 락은 새 주인의 완료 표시', () => {
    const { ws, proj, dir, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = unidentified(ws);
    fs.mkdirSync(dir, { recursive: true });
    const p = lockFile(dir, keyOf(t, sizeTurn(t)));
    plant(p, { v: 2, pid: deadPid(), at: Date.now() - 1_000, token: 'crashed' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    expect(rows(dbPath)).toBe(1);
    const j = readJson(p);
    expect(j.token).not.toBe('crashed');
    expect(typeof j.doneAt).toBe('number');
  });

  it('강제 종료 잔류 정리: 다른 키의 죽은 주인 락은 치우고 · 살아 있는 주인 락과 옛 형식 락은 남긴다', () => {
    const { ws, proj, dir } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    fs.mkdirSync(dir, { recursive: true });
    plant(path.join(dir, '.session-end-crashedcrashed01.lock'), { v: 2, pid: deadPid(), at: Date.now() - 1_000, token: 'x' });
    plant(path.join(dir, '.session-end-liveliveliveli02.lock'), { v: 2, pid: process.pid, at: Date.now() - 1_000, token: 'y' });
    const legacy = path.join(dir, '.session-end-legacylegacyle03.lock');
    fs.writeFileSync(legacy, String(Date.now() - 86_400_000));
    const old = new Date(Date.now() - 86_400_000); fs.utimesSync(legacy, old, old);
    const t = identified(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', prompt_id: 'p1', transcript_path: t });
    expect(locks(dir)).toEqual([
      `.session-end-${keyOf(t, 'p1')}.lock`,
      '.session-end-legacylegacyle03.lock',
      '.session-end-liveliveliveli02.lock',
    ].sort());
  });
});
