// last_work 는 「무엇을 했는가」인가, 그리고 턴 정체성은 텍스트가 아닌가 — 실물 훅 e2e
//
// 고치기 전의 실측(최근 50행): 사용자 프롬프트 원문 22 / **실제 결과 요약 3** /
// 슬래시·기계 토큰 오염 25. 게다가 누적이었다 — `firstRequest ... 직전 + 최신`
// 구조라 237행 중 94.1% 에 `' + '`, 83.1% 에 `' ... '` 가 들어 있었다.
//
// 그래서 이 파일이 고정하는 것은 셋이다:
//   1. 턴 사이 연결이 없다 (' + ' / ' ... ' 누적 금지)
//   2. 결과를 못 뽑으면 요청으로 메우지 않고 「결과 없음」이라고 적는다
//   3. 같은 턴인가는 prompt_id 로 판정한다 — 텍스트 유사도가 아니라

import { describe, it, expect, afterEach } from 'vitest';
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
  `);
  db.close();
}

const roots: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-lw-'));
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  initSchema(path.join(ws, '.claude', 'sessions.db'));
  roots.push(ws);
  return ws;
}

interface Turn { requests: string[]; assistant: string[] }

interface Row {
  last_work: string;
  user_intent: string | null;
  session_id: string | null;
  prompt_id: string | null;
}

function stop(ws: string, ids: { session?: string; prompt?: string }, turn: Turn): void {
  const lines: unknown[] = [];
  for (const r of turn.requests) lines.push({ type: 'user', message: { content: r } });
  for (const a of turn.assistant) lines.push({ type: 'assistant', message: { content: a } });

  const tpath = path.join(ws, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tpath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const payload: Record<string, unknown> = { cwd: ws, transcript_path: tpath };
  if (ids.session) payload.session_id = ids.session;
  if (ids.prompt) payload.prompt_id = ids.prompt;
  if (turn.assistant.length) payload.last_assistant_message = turn.assistant[turn.assistant.length - 1];

  spawnSync('node', [SESSION_END], { input: JSON.stringify(payload), encoding: 'utf-8' });
}

function rows(ws: string): Row[] {
  const db = new Database(path.join(ws, '.claude', 'sessions.db'), { readonly: true });
  const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name);
  const has = cols.includes('user_intent');
  const out = db.prepare(
    has
      ? 'SELECT last_work, user_intent, session_id, prompt_id FROM sessions ORDER BY id'
      : "SELECT last_work, NULL AS user_intent, NULL AS session_id, NULL AS prompt_id FROM sessions ORDER BY id"
  ).all() as Row[];
  db.close();
  return out;
}

afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe.skipIf(!built)('last_work — 결과이지 요청이 아니다', () => {
  it('결과가 있으면 그것을 적고, 요청은 user_intent 로 간다', () => {
    const ws = makeWorkspace();
    stop(ws, { session: 's1', prompt: 'p1' }, {
      requests: ['지형 청크 로더 좀 고쳐줘'],
      assistant: ['구현 완료 — 청크 경계에서 좌표가 한 칸 밀리던 것을 바로잡았고 테스트를 붙였습니다.'],
    });

    const [r] = rows(ws);
    expect(r.last_work).toContain('구현 완료');
    expect(r.last_work).not.toContain('고쳐줘');   // ★ 요청이 결과 자리에 오면 안 된다
    expect(r.user_intent).toBe('지형 청크 로더 좀 고쳐줘');
  });

  it('결과를 못 뽑으면 요청으로 메우지 않고 「결과 요약 없음」을 적는다', () => {
    const ws = makeWorkspace();
    stop(ws, { session: 's1', prompt: 'p1' }, {
      requests: ['식량 소비 곡선을 인구 티어별로 나눠줘'],
      assistant: ['네'],                            // 추출할 결과가 없다
    });

    const [r] = rows(ws);
    expect(r.last_work).toBe('(결과 요약 없음)');
    expect(r.user_intent).toBe('식량 소비 곡선을 인구 티어별로 나눠줘');
  });

  it('턴 사이를 연결하지 않는다 — 옛 누적기의 서명이 없다', () => {
    const ws = makeWorkspace();
    const req = ['첫 요청은 지형이었다', '두 번째는 식량이었다', '세 번째는 인구였다',
                 '네 번째는 교역이었다', '다섯 번째는 전투였다', '여섯 번째는 저장이었다'];

    stop(ws, { session: 's1', prompt: 'p1' }, {
      requests: req,
      assistant: ['수정 완료 — 저장 포맷의 버전 필드를 올리고 마이그레이션을 붙였습니다.'],
    });

    const [r] = rows(ws);
    expect(r.last_work).not.toContain(' + ');   // ★ 옛 join(' + ')
    expect(r.last_work).not.toContain(' ... '); // ★ 옛 first ... last2
    expect(r.user_intent).toBe('여섯 번째는 저장이었다');  // 이 턴의 요청 = 마지막 것
  });

  it('아무 증거도 없는 턴은 여전히 건너뛴다', () => {
    const ws = makeWorkspace();
    stop(ws, { session: 's1', prompt: 'p1' }, { requests: [], assistant: ['네'] });
    expect(rows(ws)).toHaveLength(0);
  });
});

describe.skipIf(!built)('턴 정체성 — 텍스트가 아니라 prompt_id', () => {
  it('같은 prompt_id 의 재발화는 한 행만 만든다', () => {
    const ws = makeWorkspace();
    const turn: Turn = {
      requests: ['빌드 돌려줘'],
      assistant: ['빌드 성공 — 경고 없이 통과했습니다.'],
    };
    stop(ws, { session: 's1', prompt: 'p1' }, turn);
    stop(ws, { session: 's1', prompt: 'p1' }, turn);   // Stop 중첩 발화
    expect(rows(ws)).toHaveLength(1);
  });

  it('문장이 거의 같아도 prompt_id 가 다르면 둘 다 남는다', () => {
    const ws = makeWorkspace();
    // 옛 Jaccard ≥ 0.85 는 이 둘을 같은 것으로 보고 두 번째를 삼켰다.
    stop(ws, { session: 's1', prompt: 'p1' }, {
      requests: ['빌드'], assistant: ['빌드 성공 — 경고 없이 통과했습니다.'],
    });
    stop(ws, { session: 's1', prompt: 'p2' }, {
      requests: ['빌드'], assistant: ['빌드 성공 — 경고 없이 통과했습니다.'],
    });

    const all = rows(ws);
    expect(all).toHaveLength(2);                       // ★ 정상 턴을 삼키지 않는다
    expect(all.map(r => r.prompt_id)).toEqual(['p1', 'p2']);
    expect(all.every(r => r.session_id === 's1')).toBe(true);
  });

  it('「결과 요약 없음」이 반복돼도 턴이 사라지지 않는다', () => {
    const ws = makeWorkspace();
    for (const p of ['p1', 'p2', 'p3']) {
      stop(ws, { session: 's1', prompt: p }, {
        requests: [`${p} 에서의 요청`], assistant: ['네'],
      });
    }
    const all = rows(ws);
    expect(all).toHaveLength(3);                       // ★ 텍스트 dedup 이었다면 1
    expect(all.every(r => r.last_work === '(결과 요약 없음)')).toBe(true);
    expect(all.map(r => r.user_intent)).toEqual(['p1 에서의 요청', 'p2 에서의 요청', 'p3 에서의 요청']);
  });

  it('prompt_id 가 없는 호스트에서는 옛 텍스트 dedup 이 그대로 돈다 (후퇴 금지)', () => {
    const ws = makeWorkspace();
    const turn: Turn = { requests: ['빌드'], assistant: ['빌드 성공 — 경고 없이 통과했습니다.'] };
    stop(ws, { session: 's1' }, turn);
    stop(ws, { session: 's1' }, turn);
    expect(rows(ws)).toHaveLength(1);                  // exact 24h 차단이 살아 있다
  });
});
