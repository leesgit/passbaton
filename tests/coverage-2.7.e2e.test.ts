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
});
