// 2.7 — coverage 표시가 「볼 곳이 없었다」 와 「기준선이 없어 못 봤다」 를 가른다 (Astra reply-139 PB139-11)
//
// 근거(2026-10-22 실측): 재설치로 passbaton 이 잠깐 없던 사이 UserPromptSubmit 이 안 돈 턴의 기록이
// `coverage: boundary=none, 0/0 roots (registered roots only)` 로만 나왔다 — 루트 1 개를 선언했는데도.
// 원인: 기준선이 없으면 Stop 이 등록 루트 0 일 때 이유를 비웠다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const built = [SESSION_START, SESSION_END, USER_PROMPT].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/** 모노레포 + apps/game 을 별도 git 워킹트리로 · 루트 config 가 그 루트를 선언 */
function workspace(): { ws: string; proj: string; dbPath: string } {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-27c-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ workspace: { roots: ['apps/game'] } }));
  const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf-8' });
  git(['init', '-q'], proj);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], proj);
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function hook(file: string, ws: string, payload: Record<string, unknown>): string {
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

function transcript(ws: string): string {
  const p = path.join(ws, 't.jsonl');
  const lines = [
    { uuid: 'u0', type: 'user', message: { role: 'user', content: '지도 화면 버그 고쳐줘' } },
    { uuid: 'u1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '고쳤습니다.' }] } },
  ];
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const coverageLine = (out: string) => out.split('\n').find(l => l.includes('roots')) ?? '';

describe('PB139-11 coverage 표시', () => {
  it.skipIf(!built)('기준선 없는 턴: boundary=none · 선언 1 · 「no turn-start baseline」 이유가 보인다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    // UserPromptSubmit 없이 Stop — 실측 그 턴의 모양
    hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws) });
    const db = new Database(dbPath);
    const cov = JSON.parse((db.prepare('SELECT file_coverage FROM sessions ORDER BY id DESC').get() as { file_coverage: string }).file_coverage);
    // Recent Sessions 는 15 자 이하 요약을 안 보인다 — 이 시험의 대상은 coverage 줄이므로 요약만 길게
    db.prepare("UPDATE sessions SET last_work = '지도 화면 깜빡임을 고치고 회귀 시험을 붙였다'").run();
    db.close();
    expect(cov.workspace.boundary).toBe('none');
    expect(cov.workspace.declared).toBe(1);
    expect(cov.workspace.uncovered.join(' ')).toContain('no turn-start baseline');
    const line = coverageLine(hook(SESSION_START, ws, { cwd: proj, session_id: 's2' }));
    expect(line).toContain('boundary=none');
    expect(line).toContain('declared 1');
    expect(line).toContain('no turn-start baseline');
  });

  it.skipIf(!built)('정상 턴(UserPromptSubmit → Stop): boundary=turn_start · 선언 루트를 실제로 봤다 · 기준선 이유 없음', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '지도 화면 버그 고쳐줘' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws) });
    const db = new Database(dbPath, { readonly: true });
    const cov = JSON.parse((db.prepare('SELECT file_coverage FROM sessions ORDER BY id DESC').get() as { file_coverage: string }).file_coverage);
    db.close();
    expect(cov.workspace.boundary).toBe('turn_start');
    expect(cov.workspace.checked).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(cov.workspace.uncovered)).not.toContain('no turn-start baseline');
  });

  it.skipIf(!built)('옛 기록(declared 없음 · 파일 [E] 있음)도 깨지지 않고 이유가 보인다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    const db = new Database(dbPath);
    // 실측(10-22)과 같은 모양: 도구로 고친 파일 [E] 가 있고 기준선은 없다 → 「파일 있음」 표시 분기
    db.prepare("INSERT INTO sessions (project, last_work, modified_files, file_coverage, timestamp) VALUES ('game', '옛 판이 남긴 작업 기록 한 줄입니다', ?, ?, datetime('now'))")
      .run(JSON.stringify([path.join(proj, 'memo.md')]), JSON.stringify({ source: 'turn_scoped', workspace: { boundary: 'none', scope: 'registered roots only', roots: 0, checked: 0, elapsedMs: 0, uncovered: ['no turn-start baseline'] } }));
    db.close();
    const line = coverageLine(hook(SESSION_START, ws, { cwd: proj, session_id: 's2' }));
    expect(line).toContain('boundary=none');
    expect(line).toContain('no turn-start baseline');
    expect(line).not.toContain('declared');
  });
  // reply-147 PB139-11 보완: 선언·유효·관측을 가른다 · 못 읽은 선언을 「선언 0」 으로 위장하지 않는다
  const lastCov = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true });
    const c = JSON.parse((db.prepare('SELECT file_coverage FROM sessions ORDER BY id DESC').get() as { file_coverage: string }).file_coverage);
    db.close();
    return c.workspace;
  };
  const setConfig = (ws: string, text: string) => fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), text);

  it.skipIf(!built)('유효 + 없는 경로 + 워크스페이스 밖이 섞인 선언: declared 3 · valid 1 · 정상 턴은 관측 1 — 두 표시 분기 모두', () => {
    const { ws, proj, dbPath } = workspace();
    setConfig(ws, JSON.stringify({ workspace: { roots: ['apps/game', 'apps/missing', '../outside'] } }));
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '지도 화면 버그 고쳐줘' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws) });
    const w = lastCov(dbPath);
    expect([w.declared, w.valid, w.boundary]).toEqual([3, 1, 'turn_start']);
    expect(w.checked).toBeGreaterThanOrEqual(1);
    // 기준선 없는 턴(파일 없음 분기) — Stop 은 10 초 안의 같은 project+요약을 중복으로 건너뛴다(session-end 1332) — 새 워크스페이스
    {
      const b = workspace();
      setConfig(b.ws, JSON.stringify({ workspace: { roots: ['apps/game', 'apps/missing', '../outside'] } }));
      hook(SESSION_START, b.ws, { cwd: b.proj, session_id: 'nobase' });
      hook(SESSION_END, b.ws, { cwd: b.proj, session_id: 'nobase', transcript_path: transcript(b.ws) });
      const nb = lastCov(b.dbPath);
      expect([nb.declared, nb.valid, nb.boundary]).toEqual([3, 1, 'none']);
      const db = new Database(b.dbPath);
      db.prepare("UPDATE sessions SET last_work = '지도 화면 깜빡임을 고치고 회귀 시험을 붙였다'").run();
      db.close();
      expect(coverageLine(hook(SESSION_START, b.ws, { cwd: b.proj, session_id: 's2' }))).toContain('declared 3 (valid 1)');
    }
    // 파일 [E] 있는 분기
    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO sessions (project, last_work, modified_files, file_coverage, timestamp) VALUES ('game', '파일을 고친 판이 남긴 기록 한 줄입니다', ?, ?, datetime('now', '+1 minute'))")
      .run(JSON.stringify([path.join(proj, 'memo.md')]), JSON.stringify({ source: 'turn_scoped', workspace: { ...w, boundary: 'none', checked: 0, uncovered: ['no turn-start baseline'] } }));
    db2.close();
    const line = coverageLine(hook(SESSION_START, ws, { cwd: proj, session_id: 's3' }));
    expect(line).toContain('coverage:');
    expect(line).toContain('declared 3 (valid 1)');
  });

  it.skipIf(!built)('못 읽는 설정(JSON 아님) · 모양 틀린 roots → 「선언 0」 이 아니라 상태로 남고 보인다', () => {
    for (const [text, status] of [['{ "workspace": ', 'unreadable'], [JSON.stringify({ workspace: { roots: 'apps/game' } }), 'malformed']] as const) {
      const { ws, proj, dbPath } = workspace();
      setConfig(ws, text);
      hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
      hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws) });
      const w = lastCov(dbPath);
      expect(w.declStatus, status).toBe(status);
      const db = new Database(dbPath);
      db.prepare("UPDATE sessions SET last_work = '지도 화면 깜빡임을 고치고 회귀 시험을 붙였다'").run();
      db.close();
      const line = coverageLine(hook(SESSION_START, ws, { cwd: proj, session_id: 's2' }));
      expect(line, status).toContain(`root declaration ${status}`);
      expect(line, status).not.toContain('declared 0');
    }
  });

  it.skipIf(!built)('설정 파일 자체가 없으면 declared 0 (상태 없음 — 못 읽은 것과 다르다)', () => {
    const { ws, proj, dbPath } = workspace();
    fs.rmSync(path.join(ws, '.claude', 'passbaton.config.json'));
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws) });
    const w = lastCov(dbPath);
    expect([w.declared, w.valid, w.declStatus]).toEqual([0, 0, undefined]);
  });
});

