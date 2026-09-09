// 부트스트랩 회귀 테스트 (2026-09-09, relaydesk G3 로 발견)
//
// 훅 다섯 개가 전부 `if (!fs.existsSync(dbPath)) return` 으로 빠져나가는데 **만드는 훅이
// 하나도 없었다.** DB 를 만드는 곳은 `src/db/database.ts` 뿐이고 그건 `.git` 을 모른다.
// 그래서 `apps/` 도 없고 DB 도 아직 없는 **평범한 git 레포는 세션이 조용히 사라졌다** —
// 실패 로그도, 빈 DB 도 남지 않았다. `~/.claude/sessions.db` 에 project 가 윈도우
// 사용자명인 행 101개가 그 시절의 잔해다.
//
// 여기서 지키는 것은 둘이다:
//   1. 표식(.git·apps/·기존 DB)이 있는 루트에는 **만든다**
//   2. 표식이 없으면 **안 만든다** — `~/Downloads` 에서 한 번 띄웠다고 DB 가 생기면 안 된다

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveWorkspaceRoot, canBootstrapDb } from '../src/utils/workspace.js';
import { ensureSessionsDb, dbPathFor } from '../src/db/bootstrap.js';

let tmp: string;
const savedEnv = process.env.WORKSPACE_ROOT;

function mk(...segments: string[]): string {
  const p = path.join(tmp, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** `.git` 디렉터리만 있으면 탐지에는 충분하다 — 진짜 git 레포일 필요는 없다. */
function gitRepo(...segments: string[]): string {
  const p = mk(...segments);
  fs.mkdirSync(path.join(p, '.git'), { recursive: true });
  return p;
}

beforeEach(() => {
  delete process.env.WORKSPACE_ROOT;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-')));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = savedEnv;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // 윈도우에서 잠긴 파일은 그냥 둔다
  }
});

describe('resolveWorkspaceRoot 의 판정 근거', () => {
  it('.git 으로 잡으면 reason 이 git 이다', () => {
    const repo = gitRepo('repo');
    expect(resolveWorkspaceRoot(repo)).toEqual({ root: repo, reason: 'git' });
  });

  it('apps/ 가 있으면 reason 이 apps 이고 레포 경계를 넘는다', () => {
    const mono = mk('mono');
    const inner = gitRepo('mono', 'apps', 'inner');
    expect(resolveWorkspaceRoot(inner)).toEqual({ root: mono, reason: 'apps' });
  });

  it('기존 DB 로 잡으면 reason 이 db 이다', () => {
    const repo = gitRepo('repo');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(dbPathFor(repo), Buffer.alloc(0));
    const nested = mk('repo', 'src', 'deep');
    expect(resolveWorkspaceRoot(nested)).toEqual({ root: repo, reason: 'db' });
  });

  it('표식이 하나도 없으면 reason 이 cwd 이다', () => {
    const bare = mk('bare');
    expect(resolveWorkspaceRoot(bare).reason).toBe('cwd');
  });

  it('WORKSPACE_ROOT 가 있으면 reason 이 env 이다', () => {
    process.env.WORKSPACE_ROOT = tmp;
    expect(resolveWorkspaceRoot(mk('anything'))).toEqual({ root: tmp, reason: 'env' });
  });
});

describe('canBootstrapDb', () => {
  it('표식으로 잡은 루트는 만들어도 된다', () => {
    // 임시 디렉터리 안이지만 .git 이 있으므로 임시 취급이 아니다
    expect(canBootstrapDb(resolveWorkspaceRoot(gitRepo('repo')))).toBe(true);
  });

  it('표식 없이 cwd 로 잡힌 루트에는 만들지 않는다', () => {
    expect(canBootstrapDb(resolveWorkspaceRoot(mk('bare')))).toBe(false);
  });
});

describe('ensureSessionsDb', () => {
  it('평범한 git 레포에 DB 를 만든다 — 이것이 G3 가 잡은 구멍이다', () => {
    const repo = gitRepo('plain');
    const resolved = resolveWorkspaceRoot(repo);

    expect(fs.existsSync(dbPathFor(repo))).toBe(false);
    expect(ensureSessionsDb(resolved)).toBe('created');
    expect(fs.existsSync(dbPathFor(repo))).toBe(true);
  });

  it('만든 DB 에는 훅이 쓰는 sessions 테이블이 실제로 있다', () => {
    // 빈 파일만 만들면 INSERT 가 던지고 fail-soft 로 삼켜진다 — 예전에 그렇게 당했다.
    const repo = gitRepo('plain');
    ensureSessionsDb(resolveWorkspaceRoot(repo));

    const db = new Database(dbPathFor(repo), { readonly: true });
    const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>)
      .map((t) => t.name);
    const columns = (db.prepare('pragma table_info(sessions)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    db.close();

    expect(tables).toContain('sessions');
    for (const c of ['id', 'project', 'session_id', 'timestamp', 'last_work']) {
      expect(columns).toContain(c);
    }
  });

  it('두 번째 호출은 exists 를 돌려주고 덮어쓰지 않는다', () => {
    const repo = gitRepo('plain');
    const resolved = resolveWorkspaceRoot(repo);
    ensureSessionsDb(resolved);

    const db = new Database(dbPathFor(repo));
    db.prepare("insert into sessions (project, timestamp, last_work) values ('p', '2026-09-09', 'keep me')").run();
    db.close();

    expect(ensureSessionsDb(resolved)).toBe('exists');

    const check = new Database(dbPathFor(repo), { readonly: true });
    const row = check.prepare('select last_work from sessions').get() as { last_work: string };
    check.close();
    expect(row.last_work).toBe('keep me');
  });

  it('표식 없는 디렉터리에는 아무것도 만들지 않는다', () => {
    const bare = mk('bare');
    expect(ensureSessionsDb(resolveWorkspaceRoot(bare))).toBe('refused');
    expect(fs.existsSync(path.join(bare, '.claude'))).toBe(false);
  });
});
