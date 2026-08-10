// Regression tests for the 2026-08-10 audit-7 fixes (P0-1/P0-2/P1-1/P1-2/P1-3).
//
// These spawn the REAL compiled hooks against isolated temp DBs. Unit-importing
// the target functions is impossible: session-end.ts calls main() at module load
// and exports nothing, so the only honest way to test them is through the hook
// boundary — the same reason session-end-toggles.e2e.test.ts works this way.
//
// Requires `npm run build` first (reads dist/hooks/*.js). Skips if dist is
// missing rather than failing spuriously.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const PRE_COMPACT = path.resolve(here, '../dist/hooks/pre-compact.js');
const built = fs.existsSync(SESSION_END) && fs.existsSync(SESSION_START) && fs.existsSync(PRE_COMPACT);

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

function makeWorkspace(): { ws: string; dbPath: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-audit-'));
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  const dbPath = path.join(ws, '.claude', 'sessions.db');
  initSchema(dbPath);
  return { ws, dbPath };
}

function runHook(hook: string, input: object, ws: string): string {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ws },
  });
  return res.stdout || '';
}

describe.skipIf(!built)('audit-7 2026-08-10 regression', () => {
  beforeAll(() => {
    expect(built).toBe(true);
  });

  // ---- P1-2: next_tasks was unreachable in normal sessions ----
  describe('P1-2 next_tasks extraction', () => {
    // A transcript that DOES produce a lastWork via the 2c path (allRequests),
    // which is exactly the case where the old code never reached extractNextTasks.
    function transcriptWithNextTasks(): string {
      const lines = [
        { type: 'user', message: { content: '세션 종료 훅의 next_tasks 저장을 고쳐줘' } },
        { type: 'assistant', message: { content: '수정을 적용했습니다. 남은 작업: 글로벌 패키지를 재설치하고 회귀 테스트를 돌리기' } },
      ];
      return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    }

    it('stores next_tasks even when lastWork is filled by the normal path', () => {
      const { ws, dbPath } = makeWorkspace();
      const tpath = path.join(ws, 'transcript.jsonl');
      fs.writeFileSync(tpath, transcriptWithNextTasks());

      runHook(SESSION_END, { session_id: 'p12', transcript_path: tpath, cwd: ws }, ws);

      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT last_work, next_tasks FROM sessions ORDER BY id DESC LIMIT 1').get() as
        | { last_work: string; next_tasks: string }
        | undefined;
      db.close();

      expect(row).toBeDefined();
      // lastWork is populated -> the old code would have skipped extraction entirely.
      expect(row!.last_work.length).toBeGreaterThan(0);
      const tasks = JSON.parse(row!.next_tasks || '[]') as string[];
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.join(' ')).toContain('재설치');
    });

    it('leaves next_tasks empty when the transcript states no follow-up', () => {
      const { ws, dbPath } = makeWorkspace();
      const tpath = path.join(ws, 'transcript.jsonl');
      fs.writeFileSync(
        tpath,
        [
          { type: 'user', message: { content: '빌드 한번 돌려줘 그리고 결과만 알려줘' } },
          { type: 'assistant', message: { content: '빌드 성공했습니다. 테스트 133개 전부 통과했습니다.' } },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n'
      );

      runHook(SESSION_END, { session_id: 'p12b', transcript_path: tpath, cwd: ws }, ws);

      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT next_tasks FROM sessions ORDER BY id DESC LIMIT 1').get() as
        | { next_tasks: string }
        | undefined;
      db.close();

      const tasks = JSON.parse(row?.next_tasks || '[]') as string[];
      expect(tasks).toEqual([]);
    });
  });

  // ---- P1-1: high-priority directives were immortal ----
  describe('P1-1 directive eviction / TTL', () => {
    it('evicts directives older than 90 days regardless of priority', () => {
      const { ws, dbPath } = makeWorkspace();
      const db = new Database(dbPath);
      const project = path.basename(ws);
      db.prepare(
        `INSERT INTO user_directives (project, directive, priority, created_at)
         VALUES (?, ?, 'high', datetime('now','-200 days'))`
      ).run(project, '아주 오래된 high 지시문 — 반드시 삭제되어야 함');
      db.prepare(
        `INSERT INTO user_directives (project, directive, priority, created_at)
         VALUES (?, ?, 'high', datetime('now'))`
      ).run(project, '최근 high 지시문 — 남아 있어야 함');
      db.close();

      runHook(SESSION_START, { cwd: ws, source: 'startup' }, ws);
      runHook(
        path.resolve(here, '../dist/hooks/user-prompt-submit.js'),
        { cwd: ws, prompt: '계속 진행해줘', session_id: 'p11' },
        ws
      );

      const check = new Database(dbPath, { readonly: true });
      const rows = check.prepare('SELECT directive FROM user_directives').all() as Array<{ directive: string }>;
      check.close();

      const joined = rows.map((r) => r.directive).join(' | ');
      expect(joined).not.toContain('아주 오래된');
      expect(joined).toContain('최근 high');
    });
  });

  // ---- P1-3: 60-char truncation made summaries useless ----
  describe('P1-3 session summary truncation', () => {
    it('injects up to 140 chars of last_work instead of 60', () => {
      const { ws, dbPath } = makeWorkspace();
      const project = path.basename(ws);
      const longWork =
        '세션 연속성 훅의 next_tasks 추출 경로를 폴백 밖으로 옮기고 한국어 구어체 정규식을 추가한 뒤 회귀 테스트까지 붙였다 그리고 글로벌 패키지 재설치로 반영했다';
      const db = new Database(dbPath);
      db.prepare('INSERT INTO sessions (project, last_work) VALUES (?, ?)').run(project, longWork);
      db.close();

      const out = runHook(SESSION_START, { cwd: ws, source: 'startup' }, ws);

      // The 61st..140th chars must now appear in the injected context.
      const beyond60 = longWork.slice(70, 100);
      expect(out).toContain(beyond60);
    });
  });

  // ---- P0-1 / P0-2: compaction recovery ----
  describe('P0-1/P0-2 compaction recovery', () => {
    function compactTranscript(): string {
      const lines = [
        { type: 'user', message: { content: 'pre-compact 훅이 transcript_path를 읽도록 고쳐줘' } },
        { type: 'assistant', message: { content: 'src/hooks/pre-compact.ts 를 수정했습니다. 남은 작업: 빌드 후 재설치' } },
      ];
      return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    }

    it('reads transcript_path and persists recovery state to active_context', () => {
      const { ws, dbPath } = makeWorkspace();
      const tpath = path.join(ws, 'transcript.jsonl');
      fs.writeFileSync(tpath, compactTranscript());

      runHook(PRE_COMPACT, { session_id: 'p02', transcript_path: tpath, cwd: ws, hook_event_name: 'PreCompact' }, ws);

      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT current_state FROM active_context').get() as
        | { current_state: string }
        | undefined;
      db.close();

      // Before the fix `handover` was always null, so this row never existed.
      expect(row).toBeDefined();
      expect(row!.current_state.length).toBeGreaterThan(0);
    });

    it('does not wipe sibling columns when updating active_context', () => {
      const { ws, dbPath } = makeWorkspace();
      const project = path.basename(ws);
      const seed = new Database(dbPath);
      seed
        .prepare('INSERT INTO active_context (project, current_state, blockers) VALUES (?, ?, ?)')
        .run(project, 'old state', 'DB 마이그레이션 대기중');
      seed.close();

      const tpath = path.join(ws, 'transcript.jsonl');
      fs.writeFileSync(tpath, compactTranscript());
      runHook(PRE_COMPACT, { session_id: 'p02b', transcript_path: tpath, cwd: ws }, ws);

      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT current_state, blockers FROM active_context').get() as
        | { current_state: string; blockers: string | null }
        | undefined;
      db.close();

      expect(row!.current_state).not.toBe('old state');
      // INSERT OR REPLACE would have nulled this out.
      expect(row!.blockers).toBe('DB 마이그레이션 대기중');
    });

    it('labels the injected state as recovered when source=compact', () => {
      const { ws, dbPath } = makeWorkspace();
      const project = path.basename(ws);
      const db = new Database(dbPath);
      db.prepare('INSERT INTO active_context (project, current_state) VALUES (?, ?)').run(
        project,
        '컴팩션 직전 작업 상태 요약입니다'
      );
      db.close();

      const compactOut = runHook(SESSION_START, { cwd: ws, source: 'compact' }, ws);
      const normalOut = runHook(SESSION_START, { cwd: ws, source: 'startup' }, ws);

      expect(compactOut).toContain('Recovered after compaction');
      expect(normalOut).not.toContain('Recovered after compaction');
      expect(normalOut).toContain('State');
    });
  });
});
