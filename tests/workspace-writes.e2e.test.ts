// 셸이 고친 파일을 워킹트리에서 잡는가 — 실물 git 레포 e2e
//
// 왜 이 파일이 있는가: PostToolUse 는 `Edit`·`Write` 로만 등록돼 셸이 고친 파일을
// 하나도 못 본다. 실측(2026-09-08) — 도구 호출 578건 중 Bash 397 + PowerShell 87,
// Edit·Write 는 73건. 셸 명령 문자열에서 경로를 뽑는 방법은 **0/113** 으로 죽었다.
//
// ★ 그래서 이 테스트는 반드시 **진짜 git 레포**를 만든다. `os.tmpdir()` 아래의
// 평범한 디렉터리는 워킹트리가 아니라 이 경로를 통째로 건너뛴다 — 그런 워크스페이스로
// 검사하면 코드가 무엇을 하든 초록이다.
//
// 검사 축:
//   1. Edit/Write 를 거치지 않은 쓰기가 workspace_writes 에 잡히는가
//   2. modified_files 와 **합쳐지지 않는가** (근거의 종류가 다르다)
//   3. 턴 시작 이전의 쓰기는 안 잡히는가 (경계가 실제로 작동하는가)
//   4. 기준선이 없으면 「변경 없음」이 아니라 「검사 안 함」으로 적는가

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
const built = fs.existsSync(PROMPT) && fs.existsSync(SESSION_END);

const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;

const roots: string[] = [];

/** 커밋이 하나 있는 진짜 git 워킹트리 + passbaton 스키마. */
function gitWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ww-')));
  roots.push(ws);

  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: ws, encoding: 'utf-8', windowsHide: true });

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(ws, 'tracked.txt'), 'original\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  const db = new Database(path.join(ws, '.claude', 'sessions.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, last_work TEXT NOT NULL,
      current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
      verification_result TEXT, duration_minutes INTEGER
    );
    CREATE TABLE IF NOT EXISTS solutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT,
      error_signature TEXT NOT NULL, error_message TEXT, solution TEXT NOT NULL,
      related_files TEXT, keywords TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'observation', tags TEXT, project TEXT,
      importance INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP, access_count INTEGER DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS project_context (
      project TEXT PRIMARY KEY, tech_stack TEXT, architecture_decisions TEXT,
      code_patterns TEXT, special_notes TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS active_context (
      project TEXT PRIMARY KEY, current_state TEXT, active_tasks TEXT,
      recent_files TEXT, blockers TEXT, last_verification TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();
  return ws;
}

/** UserPromptSubmit — 턴 경계를 찍고 이 워킹트리를 등록한다. */
function startTurn(ws: string, sessionId: string, promptId: string): void {
  spawnSync('node', [PROMPT], {
    input: JSON.stringify({
      cwd: ws, session_id: sessionId, prompt_id: promptId,
      prompt: '이 턴에서 무언가를 고쳐줘',
    }),
    encoding: 'utf-8',
  });
}

interface Row { modified_files: string | null; workspace_writes: string | null; file_coverage: string | null }

function stopTurn(ws: string, sessionId: string, promptId: string, summary: string): Row {
  // ★ 트랜스크립트는 워크스페이스 **밖**에 둔다. 실제로도 ~/.claude/projects 에
  //   있고, 안에 두면 그것 자체가 「이 턴에 쓰인 파일」로 잡혀 테스트가 자기 꼬리를 문다.
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tr-'));
  roots.push(tdir);
  const tpath = path.join(tdir, `t-${promptId}.jsonl`);
  fs.writeFileSync(tpath, [
    { type: 'user', message: { content: summary } },
    { type: 'assistant', message: { content: `구현 완료 — ${summary}` } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  spawnSync('node', [SESSION_END], {
    input: JSON.stringify({ cwd: ws, session_id: sessionId, prompt_id: promptId, transcript_path: tpath }),
    encoding: 'utf-8',
  });

  const db = new Database(path.join(ws, '.claude', 'sessions.db'), { readonly: true });
  const row = db.prepare(
    'SELECT modified_files, workspace_writes, file_coverage FROM sessions ORDER BY id DESC LIMIT 1'
  ).get() as Row;
  db.close();
  return row;
}

const written = (row: Row): string[] => {
  if (!row.workspace_writes) return [];
  return (JSON.parse(row.workspace_writes) as Array<{ written: string[] }>).flatMap(w => w.written);
};

afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe.skipIf(!built || !gitOk)('workspace_writes — 셸이 고친 파일', () => {
  it('Edit/Write 를 안 거친 쓰기를 잡는다 (이 기능의 존재 이유)', () => {
    const ws = gitWorkspace();
    startTurn(ws, 's1', 'p1');

    // 훅이 전혀 모르는 경로로 쓴다 — 셸·생성기가 하는 일과 같다
    fs.writeFileSync(path.join(ws, 'tracked.txt'), 'changed by a shell command\n');
    fs.writeFileSync(path.join(ws, 'generated.txt'), 'brand new\n');

    const row = stopTurn(ws, 's1', 'p1', '셸로 두 파일을 고쳤다');
    const w = written(row);

    expect(w.some(p => p.endsWith('tracked.txt'))).toBe(true);
    expect(w.some(p => p.endsWith('generated.txt'))).toBe(true);
  });

  it('modified_files 와 합치지 않는다 — 근거의 종류가 다르다', () => {
    const ws = gitWorkspace();
    startTurn(ws, 's1', 'p1');
    fs.writeFileSync(path.join(ws, 'tracked.txt'), 'shell wrote this\n');

    const row = stopTurn(ws, 's1', 'p1', '셸로 고쳤다');

    // Edit/Write 로 관측한 것은 없다 → modified_files 는 비어야 한다
    expect(JSON.parse(row.modified_files || '[]')).toEqual([]);
    // 그런데 워킹트리에서는 보인다 → 별도 필드에 있어야 한다
    expect(written(row).length).toBeGreaterThan(0);
  });

  it('턴 시작 이전의 쓰기는 잡지 않는다 — 경계가 실제로 작동한다', () => {
    const ws = gitWorkspace();

    fs.writeFileSync(path.join(ws, 'tracked.txt'), 'written BEFORE the turn\n');
    // mtime 이 확실히 턴 시작보다 앞서도록 과거로 밀어 둔다
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(ws, 'tracked.txt'), past, past);

    startTurn(ws, 's1', 'p1');
    const row = stopTurn(ws, 's1', 'p1', '이 턴에는 아무것도 안 고쳤다');

    expect(written(row)).toEqual([]);
    // ★ 그런데 「검사했고 없었다」여야 한다 — 아래 테스트의 「검사 안 함」과 다르다
    const cov = JSON.parse(row.file_coverage!);
    expect(cov.workspace.boundary).toBe('turn_start');
    expect(cov.workspace.checked).toBe(1);
  });

  it('기준선이 없으면 「변경 없음」이 아니라 「검사 안 함」으로 적는다', () => {
    const ws = gitWorkspace();
    // startTurn 을 부르지 않는다 → 턴 경계가 없다
    fs.writeFileSync(path.join(ws, 'tracked.txt'), 'changed with no baseline\n');

    const row = stopTurn(ws, 's1', 'p1', '기준선 없는 턴');

    expect(written(row)).toEqual([]);
    const cov = JSON.parse(row.file_coverage!);
    expect(cov.workspace.boundary).toBe('none');   // ★ 델타를 만들어내지 않는다
    expect(cov.workspace.checked).toBe(0);
  });

  it('git 워킹트리가 아니면 검사하지 않았다고 적는다', () => {
    const ws = gitWorkspace();
    fs.rmSync(path.join(ws, '.git'), { recursive: true, force: true });   // 레포가 아니게 만든다

    startTurn(ws, 's1', 'p1');
    fs.writeFileSync(path.join(ws, 'tracked.txt'), 'no repo here\n');

    const row = stopTurn(ws, 's1', 'p1', '레포가 아닌 곳');
    const cov = JSON.parse(row.file_coverage!);

    expect(written(row)).toEqual([]);
    expect(cov.workspace.roots).toBe(0);          // 등록될 워킹트리가 없다
  });
});
