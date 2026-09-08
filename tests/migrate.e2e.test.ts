// 기존 DB 가 새 컬럼을 얻는가 — 서버 기동 경로
//
// 왜 이 파일이 있는가: `CREATE TABLE IF NOT EXISTS` 로는 컬럼을 늘릴 수 없다.
// 테이블이 이미 있으면 통째로 건너뛴다. 그래서 스키마 문자열에 컬럼만 적어두면
// **새 DB 에서만 생기고 기존 DB 에서는 조용히 없다.**
//
// 2026-09-08 에 이걸로 서버가 기동조차 못 했다 — 뒤따르는
// `CREATE INDEX ... ON sessions(project, session_id, prompt_id)` 가
// `SqliteError: no such column: session_id` 로 던졌다. 새 DB 로만 테스트했다면
// 전부 초록이었을 것이다.
//
// 그래서 이 테스트는 **반드시 옛 스키마 DB 로 시작한다.**

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../dist/index.js');
const built = fs.existsSync(SERVER);

const roots: string[] = [];

/** 새 컬럼이 하나도 없는, 배포 이전 형태의 sessions 테이블. */
function oldSchemaWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-mig-'));
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  const db = new Database(path.join(ws, '.claude', 'sessions.db'));
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, last_work TEXT NOT NULL,
      current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
      verification_result TEXT, duration_minutes INTEGER
    );
    CREATE TABLE session_files (
      session_id TEXT NOT NULL, project TEXT NOT NULL, file_path TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, project, file_path)
    );
  `);
  db.prepare("INSERT INTO sessions (project, last_work) VALUES ('demo', '기존 행은 살아남아야 한다')").run();
  db.close();
  roots.push(ws);
  return ws;
}

function columns(ws: string, table: string): string[] {
  const db = new Database(path.join(ws, '.claude', 'sessions.db'), { readonly: true });
  const c = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(x => x.name);
  db.close();
  return c;
}

afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe.skipIf(!built)('initDatabase — 기존 DB 마이그레이션', () => {
  it('옛 스키마 DB 로 서버가 기동하고 컬럼이 보강된다', () => {
    const ws = oldSchemaWorkspace();

    expect(columns(ws, 'sessions')).not.toContain('session_id');   // 전제 확인

    // 서버를 stdio 로 띄우고 initialize 만 보낸 뒤 닫는다. 기동 중 initDatabase 가 돈다.
    const req = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'migrate-test', version: '1' } },
    });
    const res = spawnSync('node', [SERVER], {
      input: req + '\n',
      encoding: 'utf-8',
      env: { ...process.env, WORKSPACE_ROOT: ws },
      timeout: 30000,
    });

    const output = (res.stdout || '') + (res.stderr || '');
    expect(output).not.toContain('no such column');   // ★ 오늘의 실패 신호
    expect(output).not.toContain('SqliteError');

    const after = columns(ws, 'sessions');
    expect(after).toContain('session_id');
    expect(after).toContain('prompt_id');
    expect(after).toContain('user_intent');
    expect(columns(ws, 'session_files')).toContain('prompt_id');
  });

  it('기존 행을 잃지 않는다', () => {
    const ws = oldSchemaWorkspace();
    spawnSync('node', [SERVER], {
      input: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }) + '\n',
      encoding: 'utf-8',
      env: { ...process.env, WORKSPACE_ROOT: ws },
      timeout: 30000,
    });

    const db = new Database(path.join(ws, '.claude', 'sessions.db'), { readonly: true });
    const row = db.prepare('SELECT last_work, session_id FROM sessions').get() as
      { last_work: string; session_id: string | null };
    db.close();

    expect(row.last_work).toBe('기존 행은 살아남아야 한다');
    expect(row.session_id).toBeNull();   // 과거 행은 식별자를 소급하지 않는다
  });
});
