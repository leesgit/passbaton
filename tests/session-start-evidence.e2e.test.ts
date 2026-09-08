// SessionStart 가 파일 증거를 어떻게 내는가 — 실물 훅 e2e
//
// 다음 세션은 이 출력만 보고 어디서 이어갈지 정한다. 그래서 과대주장의 실패
// 모드는 **엉뚱한 파일을 고치는 것**이고, 과소주장의 실패 모드는 **이미 아는 것을
// 다시 알아내는 것**이다. 이 파일이 고정하는 것:
//
//   1. 두 관측을 합치지 않고 근거를 표시한다 ([E,M] / [M] / [E])
//   2. **파일시스템에서만 보인 것(M)을 먼저** 낸다 — 그게 이 기능의 기여분이다
//   3. 커버리지를 파일 **바로 앞**에 둔다 — 목록의 부재를 해석하는 근거다
//   4. 아무것도 없을 때 「변경 없음」이 아니라 「검사한 범위에 관측 없음」이라 쓴다

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(here, '../dist/hooks/session-start.js');
const built = fs.existsSync(HOOK);

const roots: string[] = [];

function workspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ss-')));
  roots.push(ws);
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  const db = new Database(path.join(ws, '.claude', 'sessions.db'));
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, last_work TEXT NOT NULL,
      current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
      verification_result TEXT, duration_minutes INTEGER,
      session_id TEXT, prompt_id TEXT, user_intent TEXT,
      file_coverage TEXT, workspace_writes TEXT
    );
    CREATE TABLE active_context (
      project TEXT PRIMARY KEY, current_state TEXT, active_tasks TEXT,
      recent_files TEXT, blockers TEXT, last_verification TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'observation', tags TEXT, project TEXT,
      importance INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP, access_count INTEGER DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE user_directives (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, directive TEXT NOT NULL,
      context TEXT, source TEXT, priority TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE project_context (
      project TEXT PRIMARY KEY, tech_stack TEXT, architecture_decisions TEXT,
      code_patterns TEXT, special_notes TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE solutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT,
      error_signature TEXT NOT NULL, error_message TEXT, solution TEXT NOT NULL,
      related_files TEXT, keywords TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();
  return ws;
}

function insert(ws: string, row: Record<string, unknown>): void {
  const db = new Database(path.join(ws, '.claude', 'sessions.db'));
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO sessions (project, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`
  ).run(path.basename(ws), ...cols.map(c => row[c]));
  db.close();
}

function run(ws: string): string {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ cwd: ws, source: 'startup' }),
    encoding: 'utf-8',
  });
  return (r.stdout || '') + (r.stderr || '');
}

afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe.skipIf(!built)('SessionStart — 파일 증거 렌더링', () => {
  it('세 근거 그룹을 구분해 낸다', () => {
    const ws = workspace();
    const root = path.join(ws, 'repo');

    insert(ws, {
      last_work: '지형 청크 로더의 경계 계산을 바로잡고 커밋했다',
      user_intent: '청크 경계가 한 칸 밀리는 걸 고쳐줘',
      modified_files: JSON.stringify([path.join(root, 'both.cs'), path.join(root, 'tool-only.cs')]),
      workspace_writes: JSON.stringify([
        { root, written: [path.join(root, 'both.cs'), path.join(root, 'shell-only.cs')], status: 'checked' },
      ]),
      file_coverage: JSON.stringify({
        workspace: { boundary: 'turn_start', scope: 'registered roots only', roots: 1, checked: 1, uncovered: [] },
      }),
    });

    const out = run(ws);
    expect(out).toContain('both.cs [E,M]');        // 두 관측 모두
    expect(out).toContain('shell-only.cs [M]');    // 파일시스템만 — 이 기능의 기여분
    expect(out).toContain('tool-only.cs [E]');     // 도구만 — 커밋·되돌림으로 표본에 없음
    expect(out).toContain('intent:');
  });

  it('파일시스템에서만 보인 것을 먼저 낸다', () => {
    const ws = workspace();
    const root = path.join(ws, 'repo');
    insert(ws, {
      last_work: '식량 소비 곡선을 인구 티어별로 나눴다',
      modified_files: JSON.stringify([path.join(root, 'aaa-tool.cs')]),
      workspace_writes: JSON.stringify([{ root, written: [path.join(root, 'zzz-shell.cs')], status: 'checked' }]),
      file_coverage: JSON.stringify({ workspace: { boundary: 'turn_start', roots: 1, checked: 1, uncovered: [] } }),
    });

    const out = run(ws);
    expect(out.indexOf('zzz-shell.cs')).toBeLessThan(out.indexOf('aaa-tool.cs'));
  });

  it('커버리지를 파일 바로 앞에 둔다', () => {
    const ws = workspace();
    const root = path.join(ws, 'repo');
    insert(ws, {
      last_work: '교역로 가중치를 거리 제곱으로 바꿨다',
      workspace_writes: JSON.stringify([{ root, written: [path.join(root, 'a.cs')], status: 'checked' }]),
      file_coverage: JSON.stringify({
        workspace: { boundary: 'turn_start', scope: 'registered roots only', roots: 3, checked: 2,
                     uncovered: ['other: not_a_worktree'] },
      }),
    });

    const out = run(ws);
    expect(out).toContain('2/3 roots');
    expect(out).toContain('not_a_worktree');
    expect(out).toContain('registered roots only');   // 놓친 것 전부를 열거한다는 뜻이 아님
    expect(out.indexOf('coverage:')).toBeLessThan(out.indexOf('a.cs'));
  });

  it('관측이 없으면 「변경 없음」이 아니라 「검사 범위에 관측 없음」이다', () => {
    const ws = workspace();
    insert(ws, {
      last_work: '문서만 읽고 아무 파일도 고치지 않았다',
      modified_files: '[]',
      file_coverage: JSON.stringify({
        workspace: { boundary: 'turn_start', scope: 'registered roots only', roots: 1, checked: 1, uncovered: [] },
      }),
    });

    const out = run(ws);
    expect(out).toContain('no qualifying observations within checked scope');
    expect(out).not.toContain('No files changed');
  });

  it('잘릴 때 경로를 반토막 내지 않고 항목을 버리며 개수를 밝힌다', () => {
    const ws = workspace();
    const root = path.join(ws, 'repo');
    const many = Array.from({ length: 30 }, (_, i) => path.join(root, `f${String(i).padStart(2, '0')}.cs`));
    insert(ws, {
      last_work: '많은 파일을 한꺼번에 고쳤고 전부 빌드까지 확인했다',
      workspace_writes: JSON.stringify([{ root, written: many, status: 'checked' }]),
      file_coverage: JSON.stringify({ workspace: { boundary: 'turn_start', roots: 1, checked: 1, uncovered: [] } }),
    });

    const out = run(ws);
    expect(out).toMatch(/… \d+ more observed path\(s\) not listed/);
    for (const line of out.split('\n').filter(l => l.includes('.cs ['))) {
      expect(line).toMatch(/f\d\d\.cs \[[EM,]+\]$/);   // 반토막 난 경로가 없다
    }
  });

  it('구스키마 DB 에서도 죽지 않는다', () => {
    const ws = workspace();
    const db = new Database(path.join(ws, '.claude', 'sessions.db'));
    db.exec('ALTER TABLE sessions RENAME TO sessions_new');
    db.exec(`CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, last_work TEXT NOT NULL,
      current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
      verification_result TEXT, duration_minutes INTEGER
    )`);
    db.prepare('INSERT INTO sessions (project, last_work) VALUES (?, ?)')
      .run(path.basename(ws), '구스키마에서도 요약은 나와야 한다');
    db.close();

    const out = run(ws);
    expect(out).toContain('구스키마에서도 요약은 나와야 한다');
  });
});
