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
function seedPast(dbPath: string, project = 'game'): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES (?, '미니맵 렌더러 깜빡임을 고쳤다', datetime('now'))").run(project);
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO sessions (project, last_work, timestamp) VALUES (?, ?, datetime('now'))").run(project, `무관한 작업 ${i} 정리`);
  }
  db.close();
}

/** 트리거 문맥(명시적 과거 참조 없음)이 잡히도록 메모리를 깐다 — IDF 를 넘게 무관한 메모리도 같이 */
function seedMemories(dbPath: string, project: string): void {
  const db = new Database(dbPath);
  // 메모리 표는 MCP 서버가 만든다(훅은 안 만든다) — 서버 스키마(src/db/database.ts)의 필요한 부분만
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'observation', tags TEXT, project TEXT, importance INTEGER DEFAULT 5,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      access_count INTEGER DEFAULT 0, metadata TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;`);
  const ins = db.prepare('INSERT INTO memories (content, memory_type, project, importance) VALUES (?, ?, ?, ?)');
  ins.run('셰이더 노이즈 텍스처는 256 으로 고정 (깜빡임 원인)', 'decision', project, 8);
  for (let i = 0; i < 15; i++) ins.run(`관련 없는 메모 ${i} 빌드 순서`, 'observation', project, 3);
  db.close();
}

/** 루트 config 에 routing · apps/game 에 재개 카드 선언 — 루트 cwd 턴에서 라우팅 카드가 겹친다 */
function routedWorkspace(): { ws: string; root: string; dbPath: string } {
  const { ws, proj, dbPath } = workspace();
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), '# 최신\n- 다음: N146-000 목표판\n');
  fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
    JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }] } }));
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ routing: { commands: { '/ashfall': 'apps/game', '/home': '.' } } }));
  return { ws, root: path.basename(ws), dbPath };
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

  // reply-147 PB139-10 보완: 한 조각짜리만 시험하면 「두 번째 출력」 을 못 잡는다 — 라우팅 카드까지 한 턴에 겹친다
  it.skipIf(!built)('Claude 루트 턴: 알림 + 과거 문맥 + 라우팅 카드가 각각 한 번 · 알림 → 과거 → 카드 순', () => {
    const { ws, root, dbPath } = routedWorkspace();
    run(SESSION_START, ws, { cwd: ws, session_id: 's1' });
    seedPast(dbPath, root);
    const out = run(USER_PROMPT, ws, { cwd: ws, session_id: 's1', prompt: '/ashfall ' + PROMPT });
    expect(count(out, '<passbaton-notice>')).toBe(1);
    expect(count(out, `<past-context project="${root}">`)).toBe(1);
    expect(count(out, '<routed-context project="game"')).toBe(1);
    expect(out).toContain('미니맵 렌더러 깜빡임을 고쳤다');
    expect(out).toContain('다음: N146-000 목표판');
    expect(out.indexOf('<passbaton-notice>')).toBeLessThan(out.indexOf('<past-context'));
    expect(out.indexOf('<past-context')).toBeLessThan(out.indexOf('<routed-context'));
  });

  // reply-148 PB148-02: JSON 호스트는 Codex 와 Gemini 둘 다 — Codex 결과를 Gemini 로 승계하지 않고 실제 분기로 돌린다
  it.skipIf(!built).each([['--codex'], ['--gemini']])('%s 루트 턴: 과거 문맥 + 라우팅 카드가 JSON 객체 하나 안에 둘 다', (host) => {
    const { ws, root, dbPath } = routedWorkspace();
    run(SESSION_START, ws, { cwd: ws, session_id: 's1' }, [host]);
    seedPast(dbPath, root);
    const out = run(USER_PROMPT, ws, { cwd: ws, session_id: 's1', prompt: '/ashfall ' + PROMPT }, [host]);
    const obj = JSON.parse(out.trim());   // 객체가 둘이면 여기서 던진다
    expect(obj.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx: string = obj.hookSpecificOutput.additionalContext;
    expect(count(ctx, `<past-context project="${root}">`)).toBe(1);
    expect(count(ctx, '<routed-context project="game"')).toBe(1);
    expect(ctx).toContain('미니맵 렌더러 깜빡임을 고쳤다');
    expect(ctx).toContain('다음: N146-000 목표판');
    expect(ctx).not.toContain('<passbaton-notice>');
  });

  it.skipIf(!built)('트리거 분기: 트리거 문맥 + 라우팅 카드 — Claude 는 순서대로 한 번씩 · Codex·Gemini 는 객체 하나', () => {
    for (const argv of [[], ['--codex'], ['--gemini']]) {
      const { ws, root, dbPath } = routedWorkspace();
      run(SESSION_START, ws, { cwd: ws, session_id: 's1' }, argv);
      seedMemories(dbPath, root);
      const out = run(USER_PROMPT, ws, { cwd: ws, session_id: 's1', prompt: '/ashfall 셰이더 노이즈 텍스처 다시 맞춰줘' }, argv);
      const ctx: string = argv.length ? JSON.parse(out.trim()).hookSpecificOutput.additionalContext : out;
      expect(count(ctx, '<triggered-context'), argv.join() || 'claude').toBe(1);
      expect(ctx).toContain('셰이더 노이즈 텍스처는 256 으로 고정');
      expect(count(ctx, '<routed-context project="game"')).toBe(1);
      expect(ctx.indexOf('<triggered-context')).toBeLessThan(ctx.indexOf('<routed-context'));
    }
  });

  it.skipIf(!built).each([['--codex'], ['--gemini']])('%s: 낼 것이 없으면 아무것도 내지 않는다(빈 객체도 안 냄 · 루트 라우팅 턴 포함)', (host) => {
    const { ws, proj } = workspace();
    run(SESSION_START, ws, { cwd: proj, session_id: 's1' }, [host]);
    expect(run(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '안녕' }, [host]).trim()).toBe('');
    const r = routedWorkspace();
    run(SESSION_START, r.ws, { cwd: r.ws, session_id: 's2' }, [host]);
    run(USER_PROMPT, r.ws, { cwd: r.ws, session_id: 's2', prompt: '/ashfall' }, [host]);
    expect(run(USER_PROMPT, r.ws, { cwd: r.ws, session_id: 's2', prompt: '안녕' }, [host]).trim()).toBe('');   // 카드 반복 억제 턴
  });
});
