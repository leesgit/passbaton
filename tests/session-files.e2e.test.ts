// modified_files 가 「이 턴에 이 세션이 고친 것」이 되는가 — 실물 훅 2개 e2e
//
// 이 결함은 단위 테스트로 잡을 수 없다. 원인이 한 함수 안이 아니라 **두 훅이
// 공유하던 저장 위치**에 있었기 때문이다:
//
//   post-tool-use → active_context.recent_files   (프로젝트당 한 칸)
//   session-end   ← active_context.recent_files
//
// 프로젝트당 한 칸이므로 같은 프로젝트에 동시에 붙은 두 세션이 서로를 덮었고,
// 그래서 sessions.modified_files 는 세션 diff 가 아니라 **아무나 최근에 만진
// 파일들의 스냅샷**이었다. 같은 payload 가 여러 행에 그대로 복제됐고(실측:
// 1,261 B 동일 payload ×4), 남의 %TEMP% 스크래치패드가 18.0% 를 차지했다.
//
// 그래서 검사 축은 셋이다:
//   1. 자기 세션 것만 가져가는가 (교차 오염)
//   2. 가져간 뒤 비워지는가 (턴 diff — 안 비우면 스냅샷과 같아진다)
//   3. session_id 가 없으면 예전 동작으로 떨어지는가 (후퇴 금지)

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const POST_TOOL = path.resolve(here, '../dist/hooks/post-tool-use.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const built = fs.existsSync(POST_TOOL) && fs.existsSync(SESSION_END);

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
    CREATE TABLE IF NOT EXISTS hot_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      file_path TEXT NOT NULL, access_count INTEGER DEFAULT 1,
      last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP, path_type TEXT DEFAULT 'file',
      UNIQUE(project, file_path)
    );
  `);
  db.close();
}

const roots: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-sf-'));
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  initSchema(path.join(ws, '.claude', 'sessions.db'));
  roots.push(ws);
  return ws;
}

/** 실물 PostToolUse 훅을 Edit 한 번으로 발화시킨다. */
function edit(ws: string, sessionId: string | null, filePath: string): void {
  const payload: Record<string, unknown> = {
    cwd: ws,
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'a\nb' },
  };
  if (sessionId) payload.session_id = sessionId;
  spawnSync('node', [POST_TOOL], { input: JSON.stringify(payload), encoding: 'utf-8' });
}

/**
 * 실물 Stop 훅을 발화시키고 **그 발화가 새로 만든 행**의 modified_files 를 준다.
 *
 * ★ 「가장 최근 행」을 그냥 읽으면 안 된다. session-end 에는 Jaccard 유사도
 * dedup 이 있어서 두 턴의 요약이 비슷하면 두 번째 INSERT 가 조용히 통과되고
 * 직전 행이 다시 읽힌다. 그러면 이 테스트는 파일 추적과 무관한 이유로 빨개지고,
 * 더 나쁘게는 무관한 이유로 초록이 될 수도 있다. 행이 늘었는지 먼저 본다.
 */
function stop(ws: string, sessionId: string | null, summary: string): string[] {
  const countRows = (): number => {
    const d = new Database(path.join(ws, '.claude', 'sessions.db'), { readonly: true });
    const n = (d.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c;
    d.close();
    return n;
  };
  const before = countRows();

  const tpath = path.join(ws, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(
    tpath,
    [
      { type: 'user', message: { content: summary } },
      { type: 'assistant', message: { content: `구현 완료 — ${summary} 를 처리했고 검증까지 마쳤습니다.` } },
      { type: 'assistant', message: { content: `작업 완료 — ${summary} 반영 후 테스트가 통과했습니다.` } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
  );

  const payload: Record<string, unknown> = { cwd: ws, transcript_path: tpath };
  if (sessionId) payload.session_id = sessionId;
  spawnSync('node', [SESSION_END], { input: JSON.stringify(payload), encoding: 'utf-8' });

  if (countRows() !== before + 1) {
    throw new Error(`Stop 훅이 새 행을 만들지 못했다 (dedup 의심): "${summary}"`);
  }

  const db = new Database(path.join(ws, '.claude', 'sessions.db'), { readonly: true });
  const row = db.prepare('SELECT modified_files FROM sessions ORDER BY id DESC LIMIT 1').get() as
    | { modified_files: string | null }
    | undefined;
  db.close();
  return row?.modified_files ? (JSON.parse(row.modified_files) as string[]) : [];
}

afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe.skipIf(!built)('modified_files — 턴 단위 diff', () => {
  it('자기 세션이 고친 파일만 담는다 (교차 오염 없음)', () => {
    const ws = makeWorkspace();
    const mine = path.join(ws, 'mine.ts');
    const theirs = path.join(ws, 'theirs.ts');

    edit(ws, 'session-A', mine);
    edit(ws, 'session-B', theirs);   // 같은 프로젝트의 다른 세션

    const files = stop(ws, 'session-A', 'A 의 작업');
    expect(files).toContain(mine);
    expect(files).not.toContain(theirs);   // ★ 이게 스냅샷 시절엔 들어왔다
  });

  it('행이 저장되면 목록이 비워져 다음 턴이 겹치지 않는다', () => {
    const ws = makeWorkspace();
    const first = path.join(ws, 'first.ts');
    const second = path.join(ws, 'second.ts');

    edit(ws, 'session-A', first);
    const turn1 = stop(ws, 'session-A', '지형 청크 로더의 경계 계산을 바로잡았다');
    expect(turn1).toEqual([first]);

    edit(ws, 'session-A', second);
    const turn2 = stop(ws, 'session-A', '식량 소비 곡선을 인구 티어별로 나눴다');
    expect(turn2).toEqual([second]);        // ★ first 가 다시 나오면 스냅샷이다
  });

  it('편집이 없던 턴은 남의 파일을 빌려오지 않는다', () => {
    const ws = makeWorkspace();
    const theirs = path.join(ws, 'theirs.ts');
    edit(ws, 'session-B', theirs);

    const files = stop(ws, 'session-A', 'A 는 아무것도 안 고쳤다');
    expect(files).not.toContain(theirs);
  });

  it('%TEMP% 스크래치패드는 애초에 기록되지 않는다', () => {
    const ws = makeWorkspace();
    const real = path.join(ws, 'real.ts');
    const scratch = path.join(os.tmpdir(), 'claude', 'other-session', 'scratchpad', 'heartbeat.py');

    edit(ws, 'session-A', real);
    edit(ws, 'session-A', scratch);

    const files = stop(ws, 'session-A', '실제 파일만 남아야 한다');
    expect(files).toEqual([real]);
  });

  it('session_id 가 없으면 예전 스냅샷 경로로 떨어진다 (후퇴 금지)', () => {
    const ws = makeWorkspace();
    const f = path.join(ws, 'legacy.ts');

    edit(ws, null, f);                       // session_id 없는 훅 페이로드
    const files = stop(ws, null, '구버전 호스트의 턴');
    expect(files).toContain(f);              // active_context.recent_files 폴백
  });
});
