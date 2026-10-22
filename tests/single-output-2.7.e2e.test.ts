// 2.7 — UserPromptSubmit 의 출력은 한 턴에 한 번 (Astra reply-139 PB139-10)
//
// Codex·Gemini 는 훅 stdout 에 JSON 객체 **하나**만 받는다. 조각(거부 알림·과거 문맥·트리거 문맥, 그리고
// 다음에 붙을 라우팅 카드)을 각자 내보내면 객체가 붙어 전부 버려진다. Claude 는 글로 받으므로 조각이
// 각각 정확히 한 번씩 들어 있는지를 본다. 「호출 수」 만 세면 내용이 빠진 것을 못 잡으므로 원시 stdout 을
// 파싱해 내용까지 단언한다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

function workspace(): { ws: string; proj: string; dbPath: string } {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-27-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function run(file: string, ws: string, payload: Record<string, unknown>, argv: string[] = []) {
  const r = spawnSync('node', [file, ...argv], {
    input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws },
  });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

/** 과거 문맥이 잡히도록 세션 기록을 깐다 — 흔한 토큰으로 걸러지지 않게 무관한 기록도 같이 */
function seedPast(dbPath: string): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES ('game', '미니맵 렌더러 깜빡임을 고쳤다', datetime('now'))").run();
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES ('game', ?, datetime('now'))").run(`무관한 작업 ${i} 정리`);
  }
  db.close();
}

const PROMPT = '저번에 미니맵 렌더러 어떻게 고쳤지\n#기억 ' + '서버 설정 메모 '.repeat(30);
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('PB139-10 UserPromptSubmit 단일 출력', () => {
  it.skipIf(!built)('Claude: 거부 알림과 과거 문맥이 한 턴에 각각 정확히 한 번 · 알림이 앞', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    seedPast(dbPath);
    const out = run(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: PROMPT });
    expect(count(out, '<passbaton-notice>')).toBe(1);
    expect(count(out, '<past-context project="game">')).toBe(1);
    expect(out).toContain('미니맵 렌더러 깜빡임을 고쳤다');
    expect(out.indexOf('<passbaton-notice>')).toBeLessThan(out.indexOf('<past-context'));
  });

  it.skipIf(!built)('Codex: stdout 은 JSON 객체 하나 · 과거 문맥이 그 안에 들어 있다(알림은 Claude 전용 그대로)', () => {
    const { ws, proj, dbPath } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 's1' }, ['--codex']);
    seedPast(dbPath);
    const out = run(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: PROMPT }, ['--codex']);
    const obj = JSON.parse(out.trim());   // 객체가 둘이면 여기서 던진다
    expect(obj.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx: string = obj.hookSpecificOutput.additionalContext;
    expect(count(ctx, '<past-context project="game">')).toBe(1);
    expect(ctx).toContain('미니맵 렌더러 깜빡임을 고쳤다');
    expect(ctx).not.toContain('<passbaton-notice>');
  });

  it.skipIf(!built)('낼 것이 없으면 아무것도 내지 않는다(Codex 에 빈 객체도 안 냄)', () => {
    const { ws, proj } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 's1' }, ['--codex']);
    const out = run(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '안녕' }, ['--codex']);
    expect(out.trim()).toBe('');
  });
});
