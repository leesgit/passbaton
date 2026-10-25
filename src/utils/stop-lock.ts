/**
 * Stop 훅 처리 진입 락 (2.8 · Astra reply-195 PB195-300 · 원장 L-06).
 *
 * 역할 = **같은 Stop 이벤트 재전달의 처리 진입 중복 방지**. DB 상호배제가 아니다(DB 는 BEGIN IMMEDIATE +
 * 조건부 INSERT 가 따로 막는다). 락은 DB 판정이 못 막는 것 — 행 밖 부작용(로그·파싱·active_context·해법·기억)과
 * 식별 못 한 이벤트(DB 가 일부러 중복 억제를 안 함) — 의 두 번째 처리를 막는다.
 *
 * 2.7.1 부터 키에 턴이 들어가 키가 Stop 마다 새로 생긴다 → 예전 락(숫자만 적은 파일)은 다시 쓰이지도 지워지지도
 * 않아 Stop 마다 하나씩 쌓였다(L-06). 여기서 바꾼 것:
 *   - 내용 = `{v:2, pid, at, token}`. 주인 pid 가 살아 있으면 5 초가 지나도 막는다(처리 중 상호배제 공백 메움).
 *   - 끝날 때 내 토큰이면 `doneAt` 을 적는다 → 완료 뒤 WINDOW 동안 재전달을 막는다(예전 5 초 창 유지).
 *   - 처리에 들어갈 때마다 **v2 락만** 쓸어 낸다: 완료 후 RETAIN 지남 · 미완료인데 주인 pid 죽음(강제 종료) · MAX_HOLD 지남.
 *   ⛔ 옛 형식 락은 지우지 않는다 — 기존 파일 일괄 삭제는 기각된 방법(reply-195 §5). 같은 키로 만나면 예전 규칙(5 초)대로만 본다.
 *   ⚠ 한계: 낡은 락을 치우는 순간의 경합은 「내용이 그대로일 때만 지움 + wx 재시도」 로 좁혔을 뿐 0 은 아니다 —
 *     그때 새는 재전달은 DB 정체성 판정이 한 번 더 거른다(식별 못 한 이벤트는 못 거른다).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const STOP_LOCK_WINDOW_MS = 5_000;
export const STOP_LOCK_RETAIN_MS = 60_000;
export const STOP_LOCK_MAX_HOLD_MS = 10 * 60_000;

const LOCK_RE = /^\.session-end-.+\.lock$/;

type LockState =
  | { kind: 'v2'; raw: string; pid: number; at: number; token: string; doneAt: number | null }
  | { kind: 'legacy'; raw: string; at: number }
  | { kind: 'missing' };

export function stopLockPath(dir: string, key: string): string {
  return path.join(dir, `.session-end-${key}.lock`);
}

function readLock(p: string): LockState {
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch { return { kind: 'missing' }; }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j && typeof j === 'object' && j.v === 2 && typeof j.pid === 'number' && typeof j.at === 'number' && typeof j.token === 'string') {
      return { kind: 'v2', raw, pid: j.pid, at: j.at, token: j.token, doneAt: typeof j.doneAt === 'number' ? j.doneAt : null };
    }
  } catch { /* 옛 형식 */ }
  const n = Number(raw.trim());
  let at = Number.isFinite(n) && n > 0 ? n : NaN;
  if (Number.isNaN(at)) {
    try { at = fs.statSync(p).mtimeMs; } catch { at = 0; }
  }
  return { kind: 'legacy', raw, at };
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 이 락이 지금 들어오는 같은 키의 처리를 막는가 */
function blocks(s: LockState, now: number): boolean {
  if (s.kind === 'missing') return false;
  if (s.kind === 'legacy') return now - s.at < STOP_LOCK_WINDOW_MS;
  if (s.doneAt !== null) return now - s.doneAt < STOP_LOCK_WINDOW_MS;
  return pidAlive(s.pid) && now - s.at < STOP_LOCK_MAX_HOLD_MS;
}

/** 다른 키의 v2 락 중 더는 아무것도 막지 않는 것 */
function sweepable(s: LockState, now: number): boolean {
  if (s.kind !== 'v2') return false;
  if (s.doneAt !== null) return now - s.doneAt > STOP_LOCK_RETAIN_MS;
  return now - s.at > STOP_LOCK_MAX_HOLD_MS || !pidAlive(s.pid);
}

function sweep(dir: string, own: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!LOCK_RE.test(name)) continue;
    const p = path.join(dir, name);
    if (p === own) continue;
    const s = readLock(p);
    if (!sweepable(s, now)) continue;
    try {
      // 읽은 뒤 바뀌었으면(누가 새로 잡음) 안 지운다
      if (fs.readFileSync(p, 'utf-8') === (s as { raw: string }).raw) fs.unlinkSync(p);
    } catch { /* 이미 없음 · 권한 — 다음 Stop 이 다시 본다 */ }
  }
}

export type StopLock = { proceed: true; release: () => void } | { proceed: false; reason: string };

export function acquireStopLock(dir: string, key: string, now: number = Date.now()): StopLock {
  const p = stopLockPath(dir, key);
  const token = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ v: 2, pid: process.pid, at: now, token });
  const release = () => {
    const s = readLock(p);
    if (s.kind !== 'v2' || s.token !== token) return;   // 내 것이 아니면 손대지 않는다
    try { fs.writeFileSync(p, JSON.stringify({ v: 2, pid: s.pid, at: s.at, token, doneAt: Date.now() })); } catch { /* fail-soft */ }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(p, body, { flag: 'wx' });
      sweep(dir, p, now);
      return { proceed: true, release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { proceed: true, release: () => {} };   // 락을 못 만들면 예전처럼 fail-soft
    }
    const cur = readLock(p);
    if (blocks(cur, now)) return { proceed: false, reason: cur.kind === 'v2' && cur.doneAt === null ? 'in-progress' : 'recent' };
    // 낡은 락(완료 후 창 지남 · 주인 죽음 · 옛 형식 5 초 지남) — 내용이 그대로일 때만 치우고 다시 원자 생성
    try {
      if (cur.kind !== 'missing' && fs.readFileSync(p, 'utf-8') === cur.raw) fs.unlinkSync(p);
    } catch { /* 이미 치워짐 */ }
  }
  return { proceed: false, reason: 'contended' };
}
