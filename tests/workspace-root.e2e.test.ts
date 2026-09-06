// P0-6 e2e (2026-09-07 감사) — 훅이 apps/<app> 의 함정 DB 대신 모노레포 루트에 쓰는가.
//
// 유실 메커니즘을 그대로 재현한다: 훅은 테이블을 만들지 않으므로, 스키마가 없는
// apps/<app>/.claude/sessions.db 를 열면 INSERT 가 실패하고 fail-soft 로 조용히
//넘어간다. 실측에서 hero-maker 는 훅이 265번 발화하고 세션 행이 0건이었다.
//
// `npm run build` 가 선행돼야 한다 (dist/hooks/*.js 를 spawn 한다).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const built = fs.existsSync(SESSION_END);

function initSchema(dbPath: string): void {
  const db = new Database(dbPath);
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
    CREATE TABLE IF NOT EXISTS user_directives (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      directive TEXT NOT NULL, context TEXT, source TEXT DEFAULT 'explicit',
      priority TEXT DEFAULT 'normal', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project, directive)
    );
  `);
  db.close();
}

/** 모노레포 + apps/<app> 함정 DB 를 만든다. 루트만 스키마를 갖는다. */
function makeMonorepoWithTrap(app: string): { root: string; appDir: string; rootDb: string; trapDb: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-p06-')));
  createdDirs.push(root);
  const appDir = path.join(root, 'apps', app);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(appDir, '.claude'), { recursive: true });

  const rootDb = path.join(root, '.claude', 'sessions.db');
  const trapDb = path.join(appDir, '.claude', 'sessions.db');
  initSchema(rootDb);
  fs.writeFileSync(trapDb, Buffer.alloc(4096)); // 스키마 없는 4096바이트 — 실물과 같다

  return { root, appDir, rootDb, trapDb };
}

function runSessionEnd(input: object, cwd: string): void {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
  delete env.WORKSPACE_ROOT; // 환경변수가 아니라 탐색 규칙 자체를 검사한다
  spawnSync('node', [SESSION_END], { input: JSON.stringify(input), encoding: 'utf-8', env });
}

/**
 * 함정 파일이 손대지지 않았는지 본다. **열지 않는다** — 실물 함정 파일은
 * 유효한 SQLite 헤더조차 없어서(SQLITE_NOTADB) 여는 것 자체가 실패한다.
 * 바이트가 그대로면 훅이 여기에 아무것도 쓰지 않은 것이다.
 */
function untouched(dbPath: string, bytes: number): boolean {
  const buf = fs.readFileSync(dbPath);
  return buf.length === bytes && buf.every((b) => b === 0);
}

const createdDirs: string[] = [];

// 임시 워크스페이스를 지운다. 안 지우면 %TEMP% 에 쌓인다 — 실측으로 84개가
// 남아 있었고, 「워크스페이스 탐지가 새 DB 를 만들었나」를 잴 때 잡음이 된다.
afterAll(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 정리 실패가 테스트를 빨갛게 만들지는 않는다
    }
  }
});

describe.skipIf(!built)('P0-6 워크스페이스 루트 탐지', () => {
  beforeAll(() => {
    expect(built).toBe(true);
  });

  it('apps/<app> 에서 실행해도 세션이 루트 DB 에 저장된다', () => {
    const { root, appDir, rootDb, trapDb } = makeMonorepoWithTrap('hero-maker');
    const tpath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(tpath, JSON.stringify({
      type: 'user',
      message: { content: '보스 스킬 테스트가 넉 달째 빨간데 원인을 찾아줘' },
    }) + '\n');

    runSessionEnd({ session_id: 'p06-a', transcript_path: tpath, cwd: appDir }, appDir);

    const db = new Database(rootDb, { readonly: true });
    const row = db.prepare('SELECT project, last_work FROM sessions ORDER BY id DESC LIMIT 1').get() as
      | { project: string; last_work: string }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.project).toBe('hero-maker');
    expect(row!.last_work.length).toBeGreaterThan(0);

    // 함정 파일은 손대지 않은 채 그대로여야 한다 (사이드카도 안 생겨야 한다)
    expect(untouched(trapDb, 4096)).toBe(true);
    expect(fs.existsSync(trapDb + '-wal')).toBe(false);
  });
});
