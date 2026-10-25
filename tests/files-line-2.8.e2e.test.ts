// PB195-500 ① (원장 L-48 · fb1025 P2) — files 줄: 예상된 건너뜀은 잡음 없이 · 실제 실패는 보이게
//
// 원문: `files: no qualifying observations within checked scope (1/3 roots, boundary=turn_start, declared 1 (valid 1),
//        skipped: agent-a55b2e4e5b7a512f3: failed; agent-a8532af7390a1993e: failed)`
// 원인(재현): 등록된 루트가 끝난 보조 에이전트의 워크트리(`.claude/worktrees/agent-*`)였고 Stop 때 디렉터리가 이미 없었다 →
//   없는 cwd 로 git 을 띄워 ENOENT → 「failed」. git 이 없는 것·저장소가 깨진 것과 같은 말이 됐다.
// 계약: 사라진 루트 = `removed`(roots·skipped 에 안 셈) · 디렉터리가 있는데 git 이 실패 = 그대로 `skipped: <이름>: failed`.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const built = [PROMPT, SESSION_END, SESSION_START].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function gitInit(dir: string) {
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf-8', windowsHide: true });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'x\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
}
function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(d);
  return d;
}

/** 진짜 git 워크스페이스 · 이 턴 시작(UserPromptSubmit 이 루트 등록) · 추가 루트를 session_roots 에 심는다 */
function turnWithRoots(extra: string[]): { ws: string } {
  const ws = tmp('pb-195f-');
  gitInit(ws);
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  new Database(path.join(ws, '.claude', 'sessions.db')).close();
  spawnSync('node', [PROMPT], { input: JSON.stringify({ cwd: ws, session_id: 's1', prompt_id: 'p1', prompt: '지도 문서 읽어줘' }), encoding: 'utf-8' });
  const db = new Database(path.join(ws, '.claude', 'sessions.db'));
  const reg = db.prepare('SELECT project FROM session_roots WHERE session_id = ?').get('s1') as { project: string } | undefined;
  expect(reg, 'UserPromptSubmit 이 루트를 등록했다').toBeTruthy();
  const ins = db.prepare('INSERT INTO session_roots (session_id, project, root, head_baseline) VALUES (?, ?, ?, NULL)');
  for (const r of extra) ins.run('s1', reg!.project, r);
  db.close();
  const tdir = tmp('pb-195t-');
  const t = path.join(tdir, 't.jsonl');
  fs.writeFileSync(t, [
    { uuid: 'u0', type: 'user', message: { content: '지도 문서 읽어줘' } },
    { uuid: 'a0', type: 'assistant', message: { content: [{ type: 'text', text: '문서를 읽었습니다.' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSync('node', [SESSION_END], { input: JSON.stringify({ cwd: ws, session_id: 's1', prompt_id: 'p1', transcript_path: t }), encoding: 'utf-8' });
  expect(r.status, r.stderr?.slice(0, 300)).toBe(0);
  // Recent Sessions 는 15 자 넘는 요약만 싣는다 — 요약 글만 바꾸고 커버리지(이 시험의 대상)는 훅이 쓴 그대로 둔다
  const db2 = new Database(path.join(ws, '.claude', 'sessions.db'));
  db2.prepare("UPDATE sessions SET last_work = '지도 문서를 끝까지 읽고 정리했다 — 고친 파일 없음'").run();
  db2.close();
  return { ws };
}
const coverageOf = (ws: string) => {
  const db = new Database(path.join(ws, '.claude', 'sessions.db'), { readonly: true });
  const row = db.prepare('SELECT file_coverage FROM sessions ORDER BY id DESC LIMIT 1').get() as { file_coverage: string };
  db.close();
  return (JSON.parse(row.file_coverage) as { workspace: { roots: number; checked: number; uncovered: string[]; removed?: string[] } }).workspace;
};
const filesLine = (ws: string) => {
  const r = spawnSync('node', [SESSION_START], { input: JSON.stringify({ cwd: ws, session_id: 's2', source: 'compact' }), encoding: 'utf-8' });
  expect(r.status, r.stderr?.slice(0, 300)).toBe(0);
  return r.stdout.split(/\r?\n/).filter(l => l.startsWith('  files') || l.startsWith('  coverage'));
};
/** 지워진 보조 에이전트 워크트리 — 한때 있었고 지금은 없다 */
function removedWorktree(): string {
  const parent = tmp('pb-195w-');
  const d = path.join(parent, 'agent-a55b2e4e5b7a512f3');
  fs.mkdirSync(d);
  fs.rmSync(d, { recursive: true });
  return d;
}
/** 디렉터리는 있는데 git 이 실패하는 저장소(색인 파손) — 실제 실패 */
function brokenRepo(): string {
  const d = path.join(tmp('pb-195b-'), 'broken-repo');
  fs.mkdirSync(d);
  gitInit(d);
  fs.writeFileSync(path.join(d, '.git', 'index'), 'not an index file at all');
  return d;
}

describe.skipIf(!built || !gitOk)('PB195-500 ① L-48 files 줄 — 예상된 건너뜀 vs 실제 실패', () => {
  it('사라진 보조 에이전트 워크트리 둘 → 기록은 removed 로 남고 · 주입 줄은 정상 완전 검사의 짧은 꼴(잡음 없음)', () => {
    const { ws } = turnWithRoots([removedWorktree(), removedWorktree()]);
    const w = coverageOf(ws);
    expect(w.removed).toEqual(['agent-a55b2e4e5b7a512f3', 'agent-a55b2e4e5b7a512f3']);
    expect(w.uncovered).toEqual([]);
    expect(w.roots).toBe(1);
    expect(w.checked).toBe(1);
    const l = filesLine(ws);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatch(/^ {2}files: 0 obs in checked scope · 1\/1 roots · boundary=turn_start/);
    expect(l[0]).not.toContain('failed');
    expect(l[0]).not.toContain('agent-');
  });

  it('실제 실패(디렉터리는 있는데 git 실패) → 긴 꼴 · skipped: broken-repo: failed 가 보인다 · 사라진 것은 여전히 안 보인다', () => {
    const { ws } = turnWithRoots([removedWorktree(), brokenRepo()]);
    const w = coverageOf(ws);
    expect(w.uncovered).toEqual(['broken-repo: failed']);
    expect(w.removed).toEqual(['agent-a55b2e4e5b7a512f3']);
    expect(w.roots).toBe(2);
    const l = filesLine(ws);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatch(/^ {2}files: no qualifying observations within checked scope \(1\/2 roots, boundary=turn_start/);
    expect(l[0]).toContain('skipped: broken-repo: failed');
    expect(l[0]).not.toContain('agent-');
  });
});
