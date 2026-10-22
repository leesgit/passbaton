// 2.6.0 — 「DB 요약이 아니라 레포 정본을 먼저」 · 정규식 조각을 결정으로 주입하지 않기
//
// 근거: Ashfall 2026-10-22 실측(passbaton-feedback-2026-10-22 · Astra reply-133).
//   - 자동 추출 기억 146 개 전부 `instead of …` 뒤를 자른 조각 · type=decision · 조회 0 회
//   - SessionStart 의 State 가 직전 「경로만 답해」 세션의 결과로 덮였다
//   - Directives 에 「해야 할 것」 · 「…있는가.」 · 잘린 영어 문서 줄
//   - 연속성의 정본은 HANDOFF.md 맨 위 · fix_plan 「지금 할 일」 블록인데 passbaton 은 그것을 몰랐다
//
// 각 기능마다 **빨개야 하는 쪽**(역검증)도 같이 고정한다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isValidDirective, isDirectiveSource } from '../src/utils/directive.js';
import { buildResumeCard, readSource } from '../src/utils/resume-card.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const SERVER = path.resolve(here, '../dist/index.js');
const built = fs.existsSync(SESSION_START) && fs.existsSync(SESSION_END) && fs.existsSync(SERVER);

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(d);
  return d;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, last_work TEXT NOT NULL,
    current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
    verification_result TEXT, duration_minutes INTEGER
  );
  CREATE TABLE IF NOT EXISTS active_context (
    project TEXT PRIMARY KEY, current_state TEXT, active_tasks TEXT,
    recent_files TEXT, blockers TEXT, last_verification TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'observation', tags TEXT, project TEXT,
    importance INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP, access_count INTEGER DEFAULT 0,
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS user_directives (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, directive TEXT NOT NULL,
    context TEXT, source TEXT, priority TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project, directive)
  );
  CREATE TABLE IF NOT EXISTS project_context (
    project TEXT PRIMARY KEY, tech_stack TEXT, architecture_decisions TEXT,
    code_patterns TEXT, special_notes TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS solutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT,
    error_signature TEXT NOT NULL, error_message TEXT, solution TEXT NOT NULL,
    related_files TEXT, keywords TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

/** 모노레포 모양: <ws>/.claude/sessions.db + <ws>/apps/<name>/ */
function monorepo(name = 'game'): { ws: string; proj: string; dbPath: string } {
  const ws = tmp('pb-26-');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  const proj = path.join(ws, 'apps', name);
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.ralph'), { recursive: true });
  // 루트 표지 — workspace 해석이 이 폴더를 루트로 보게 한다
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  const dbPath = path.join(ws, '.claude', 'sessions.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.close();
  return { ws, proj, dbPath };
}

function writeCardConfig(proj: string, sources: unknown): void {
  fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
    JSON.stringify({ continuity: { sources } }, null, 2));
}

function sessionStart(cwd: string, ws: string): string {
  const r = spawnSync('node', [SESSION_START], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf-8',
    env: { ...process.env, WORKSPACE_ROOT: ws },
  });
  return r.stdout;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('isValidDirective — 저장·주입 양쪽 게이트', () => {
  it.each([
    ['해야 할 것'],                                 // 「반드시 해야 할 것」 제목의 잔해
    ['해소해야 하는 것이 있는가.'],                   // 질문
    ['다음 단계로 넘어가도 될까요?'],                  // 질문
    ['be silently written for S10); or any attack clip\\n\\n**Most likely'], // 잘린 문서
    ['use the cache rather than polling'],          // 소문자 시작 = 산문 파편
    ['— 사용자 밥줄이다 그러니 지킨다'],              // 실 DB: 문장 중간에서 시작
    ['수정·엔진 결합되므로). 그래서 둔다'],            // 실 DB: 괄호 짝 안 맞음
    ['유지하되 이번 프리뷰만 예외 승인, 기록은'],       // 실 DB: 조사로 끝남
    ['재확인해야 합니다 자료 편차 존재</result>'],      // 실 DB: 태그 조각
  ])('거부: %s', (d) => {
    expect(isValidDirective(d)).toBe(false);
  });

  it.each([
    ['main 브랜치에 직접 푸시하지 말 것'],
    ['Never use float in the deterministic core'],
    ['커밋 전에 루프를 초록으로 만든다'],
  ])('통과: %s', (d) => {
    expect(isValidDirective(d)).toBe(true);
  });
});

describe('isDirectiveSource — 사람이 쓴 짧은 메시지에서만', () => {
  it('하네스·에이전트 턴과 긴 붙여넣기는 거부, #기억 은 언제나 통과', () => {
    expect(isDirectiveSource('<task-notification> <task-id>a1</task-id> 반드시 커밋 전에 돌린다')).toBe(false);
    expect(isDirectiveSource('# Ashfall — Ralph 루프 지침 ' + 'x'.repeat(400))).toBe(false);
    expect(isDirectiveSource('당신은 Ashfall 의 설계 검토자다. ' + '가'.repeat(320))).toBe(false);
    expect(isDirectiveSource('반드시 커밋 전에 루프를 초록으로 만든다')).toBe(true);
    expect(isDirectiveSource('긴 설명 '.repeat(80) + ' #기억 Meshy 영구 크레딧은 만료 없음')).toBe(true);
    expect(isDirectiveSource(null)).toBe(true);           // 출처 모르는 옛 행 → 문장 검사만
  });
});

describe('resume card — 레포 정본 발췌', () => {
  it('맨 위 N 줄 · 줄 범위 · 해시 · 블록(같은 깊이 직전까지)', () => {
    const proj = tmp('pb-card-');
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.writeFileSync(path.join(proj, 'HANDOFF.md'), ['# 최신 절', '- N132 진행 중', '- 다음: N132-199', '# 옛 절', '- 랄프 정지'].join('\n'));
    fs.writeFileSync(path.join(proj, 'plan.md'), [
      '# 계획',
      '- [x] **M125** 끝남',
      '- [ ] **N132** 마을 지면 · ⛔ 지금 할 일',
      '  - [x] N132-101 길',
      '  - [ ] N132-199 패키지',
      '  설명 줄',
      '- [ ] **D6** 사람 확인',
    ].join('\n'));
    writeCardConfig(proj, [
      { path: 'HANDOFF.md', lines: 3, label: 'HANDOFF' },
      { path: 'plan.md', block: '지금 할 일', label: '지금 할 일' },
    ]);

    const card = buildResumeCard(proj, 4000)!;
    expect(card).not.toBeNull();
    const [h, b] = card.items;
    expect(h).toMatchObject({ outcome: 'ok', from: 1, to: 3, totalLines: 5 });
    expect(h.excerpt).toContain('다음: N132-199');
    expect(h.excerpt).not.toContain('랄프 정지');            // 3 줄 밖
    expect(b).toMatchObject({ outcome: 'ok', from: 3, to: 6 });
    expect(b.excerpt).toContain('N132-199 패키지');
    expect(b.excerpt).toContain('설명 줄');
    expect(b.excerpt).not.toContain('D6');                   // 같은 깊이 다음 항목 직전에서 멈춤
    expect(b.excerpt).not.toContain('M125');
    expect(card.text).toContain('`HANDOFF.md:1-3` (of 5)');
    expect(card.text).toMatch(/plan\.md:3-6` \(of 7\) · sha1 [0-9a-f]{10}/);
  });

  it('역검증: 내용이 바뀌면 해시가 바뀌고, 줄 번호는 매번 다시 읽는다', () => {
    const proj = tmp('pb-card-');
    fs.mkdirSync(path.join(proj, '.claude'));
    writeCardConfig(proj, [{ path: 'H.md', lines: 2 }]);
    fs.writeFileSync(path.join(proj, 'H.md'), 'a\nb\nc');
    const s1 = readSource(proj, { path: 'H.md', lines: 2 }, 1000).sha;
    fs.writeFileSync(path.join(proj, 'H.md'), 'NEW\na\nb\nc');           // 앞에 덧붙임
    const s2 = readSource(proj, { path: 'H.md', lines: 2 }, 1000);
    expect(s2.sha).not.toBe(s1);
    expect(s2.excerpt).toBe('NEW\na');
  });

  it('못 읽은 원천은 숨기지 않는다 · 폴더 밖 경로는 받지 않는다 · 자르면 표시한다', () => {
    const proj = tmp('pb-card-');
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.writeFileSync(path.join(proj, 'big.md'), Array.from({ length: 50 }, (_, i) => `line ${i} ` + 'x'.repeat(80)).join('\n'));
    writeCardConfig(proj, [
      { path: 'gone.md', lines: 5 },
      { path: 'plan.md', block: '없는 블록' },
      { path: '../../etc/passwd', lines: 5 },
      { path: 'big.md', lines: 50 },
    ]);
    fs.writeFileSync(path.join(proj, 'plan.md'), '- [ ] 다른 것');
    const card = buildResumeCard(proj, 1600)!;
    expect(card.text).toContain('`gone.md` · ⚠ NOT READ (file not found)');
    expect(card.text).toContain('`plan.md` · ⚠ NOT READ (block not found)');
    expect(card.invalid).toContain('../../etc/passwd');
    const big = card.items.find(i => i.path === 'big.md')!;
    expect(big.truncated).toBe(true);
    expect(card.text).toContain('· truncated');
  });

  it('선언이 없으면 카드가 없다', () => {
    const proj = tmp('pb-card-');
    expect(buildResumeCard(proj, 1000)).toBeNull();
  });
});

describe.skipIf(!built)('SessionStart — 카드 먼저 · 조각 기억·지시문은 주입하지 않음', () => {
  function seed(dbPath: string, project: string): void {
    const db = new Database(dbPath);
    db.prepare("INSERT INTO active_context (project, current_state) VALUES (?, ?)").run(project, '현재 작업 폴더 경로만 한 줄로 답해');
    const mem = db.prepare('INSERT INTO memories (content, memory_type, tags, project, importance) VALUES (?, ?, ?, ?, ?)');
    mem.run('instead of a box, and moving a slider rebuilds it. It isn', 'decision', '["auto-extracted"]', project, 7);
    mem.run('rather than polling the cache from the overlay loop here', 'observation', '["auto-extracted","unverified"]', project, 9);
    mem.run('Meshy 영구 크레딧 2,044 는 만료되지 않는다 (MESHY_MS130.md)', 'decision', '["manual"]', project, 8);
    mem.run('feat: 지형 로더가 청크 경계에서 한 칸 밀리던 것 고침', 'learning', '["auto-extracted","commit"]', project, 6);
    const dir = db.prepare("INSERT INTO user_directives (project, directive, priority) VALUES (?, ?, 'high')");
    dir.run(project, '해야 할 것');
    dir.run(project, '해소해야 하는 것이 있는가.');
    dir.run(project, '게임 코어에는 float 을 쓰지 말 것');
    // 옛 판 오탐: 원문은 짧은 사람 말인데 지금 규칙으로는 지시가 아니다(콜론 없는 「중요」)
    db.prepare("INSERT INTO user_directives (project, directive, priority, context) VALUES (?, ?, 'normal', ?)")
      .run(project, '인물 승격 진행해 주세요 지금', '이름이랑 중요 인물 승격 진행해 주세요 지금');
    // 역검증 짝: 원문을 다시 뽑아도 같은 지시가 나오면 남는다
    db.prepare("INSERT INTO user_directives (project, directive, priority, context) VALUES (?, ?, 'high', ?)")
      .run(project, '세이브 포맷 순서를 바꾸지 말 것', '절대 세이브 포맷 순서를 바꾸지 말 것');
    // 문장은 멀쩡하지만 출처가 서브에이전트 알림 → 주입 안 됨
    db.prepare("INSERT INTO user_directives (project, directive, priority, context) VALUES (?, ?, 'high', ?)")
      .run(project, 'Never iterate the dictionary in the movement phase', '<task-notification> <task-id>w7z</task-id> …');
    // 전역 일반 상식(learning) 은 빠지고, 전역 reference 는 남는다
    mem.run('TypeScript는 JavaScript에 정적 타입을 추가한 언어다', 'learning', '["typescript"]', null, 9);
    mem.run('스테이징 서버는 10.0.0.5:8443 (VPN 필요)', 'reference', '["infra"]', null, 9);
    db.close();
  }

  it('카드가 맨 앞 · State 는 「마지막 기록」 으로 강등 · 조각은 빠지고 진짜 기억·지시는 남는다', () => {
    const { ws, proj, dbPath } = monorepo('game');
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), '# 2026-10-22 N132 진행\n- 다음: N132-199 패키지\n');
    writeCardConfig(proj, [{ path: 'docs/HANDOFF.md', lines: 10, label: 'HANDOFF' }]);
    seed(dbPath, 'game');

    const out = sessionStart(proj, ws);
    const cardAt = out.indexOf('## Resume card');
    const stateAt = out.indexOf('Last recorded state');
    expect(cardAt).toBeGreaterThan(-1);
    expect(stateAt).toBeGreaterThan(cardAt);
    expect(out).toContain('다음: N132-199 패키지');
    expect(out).toContain('`docs/HANDOFF.md:1-3`');

    expect(out).not.toContain('instead of a box');           // 옛 판 decision 조각
    expect(out).not.toContain('rather than polling');         // unverified
    expect(out).toContain('Meshy 영구 크레딧');               // 사람이 넣은 결정은 남는다
    expect(out).toContain('지형 로더가 청크 경계');            // 커밋 기억은 남는다

    expect(out).not.toContain('해야 할 것\n');
    expect(out).not.toContain('있는가');
    expect(out).toContain('float 을 쓰지 말 것');
    expect(out).not.toContain('Never iterate the dictionary');
    expect(out).not.toContain('인물 승격');
    expect(out).toContain('세이브 포맷 순서를 바꾸지 말 것');
    expect(out).not.toContain('TypeScript는');
    expect(out).toContain('스테이징 서버는 10.0.0.5');

    // 옛 조각은 지우지 않고 격리한다
    const db = new Database(dbPath, { readonly: true });
    const q = db.prepare("SELECT memory_type, importance, tags FROM memories WHERE content LIKE 'instead of a box%'").get() as Record<string, unknown>;
    db.close();
    expect(q).toMatchObject({ memory_type: 'observation', importance: 2 });
    expect(String(q.tags)).toContain('quarantined-2.6');
  });

  it('역검증: 카드 선언이 없으면 카드도 없고 State 는 원래 이름', () => {
    const { ws, proj, dbPath } = monorepo('game');
    seed(dbPath, 'game');
    const out = sessionStart(proj, ws);
    expect(out).not.toContain('Resume card');
    expect(out).toContain('**State**');
  });
});

describe.skipIf(!built)('SessionEnd — 일한 증거 없는 턴은 State 를 덮지 않는다 · 정규식 후보는 unverified', () => {
  function stop(cwd: string, ws: string, requests: string[], assistant: unknown[]): void {
    const lines: unknown[] = [];
    for (const r of requests) lines.push({ type: 'user', message: { content: r } });
    for (const a of assistant) lines.push({ type: 'assistant', message: { content: a } });
    const tpath = path.join(ws, `t-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(tpath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const last = assistant.filter(a => typeof a === 'string').pop();
    spawnSync('node', [SESSION_END], {
      input: JSON.stringify({ cwd, transcript_path: tpath, session_id: 's-' + Math.random(), last_assistant_message: last }),
      encoding: 'utf-8',
      env: { ...process.env, WORKSPACE_ROOT: ws },
    });
  }
  const state = (dbPath: string, project: string) => {
    const db = new Database(dbPath, { readonly: true });
    const r = db.prepare('SELECT current_state FROM active_context WHERE project = ?').get(project) as { current_state: string } | undefined;
    db.close();
    return r?.current_state;
  };

  it('질문만 한 턴 뒤에도 앞선 State 가 남는다', () => {
    const { ws, proj, dbPath } = monorepo('game');
    const db = new Database(dbPath);
    db.prepare("INSERT INTO active_context (project, current_state) VALUES ('game', 'N132-104 9 마을 적용 확인 완료 — 다음 N132-199')").run();
    db.close();
    stop(proj, ws, ['현재 작업 폴더 경로만 한 줄로 답해'], ['C:/Users/me/ws 입니다. 다른 작업은 하지 않았습니다.']);
    expect(state(dbPath, 'game')).toBe('N132-104 9 마을 적용 확인 완료 — 다음 N132-199');
  });

  it('역검증: State 가 아직 없으면 질문 턴이라도 첫 State 는 쓴다', () => {
    const { ws, proj, dbPath } = monorepo('game');
    stop(proj, ws, ['현재 작업 폴더 경로만 한 줄로 답해'], ['C:/Users/me/ws 입니다. 다른 작업은 하지 않았습니다.']);
    expect(state(dbPath, 'game')).toBeTruthy();
  });

  it('정규식으로 잡힌 「결정」 은 observation/2 · unverified 로 저장된다', () => {
    const { ws, proj, dbPath } = monorepo('game');
    stop(proj, ws, ['훅 DB 동시성 어떻게 했어?'], [
      'I switched to SQLite WAL mode instead of the default rollback journal for hook processes, and documented why.',
    ]);
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT memory_type, importance, tags FROM memories WHERE tags LIKE '%auto-extracted%' AND tags NOT LIKE '%commit%'").all() as Array<Record<string, unknown>>;
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.memory_type).toBe('observation');
      expect(r.importance).toBe(2);
      expect(String(r.tags)).toContain('unverified');
    }
  });
});

describe.skipIf(!built)('MCP 읽기 전용 모드 (PASSBATON_READONLY=1)', () => {
  function rpc(ws: string, env: Record<string, string>, calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
    const msgs = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      ...calls.map((c, i) => ({ jsonrpc: '2.0', id: 2 + i, method: 'tools/call', params: c })),
    ];
    const r = spawnSync('node', [SERVER], {
      input: msgs.map(m => JSON.stringify(m)).join('\n') + '\n',
      encoding: 'utf-8',
      env: { ...process.env, WORKSPACE_ROOT: ws, ...env },
      timeout: 60000,
    });
    return r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('쓰기 도구는 목록에 없고 불러도 거부 · 조회수도 안 오른다 · 카드는 읽힌다', () => {
    const { ws, proj, dbPath } = monorepo('game');
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), '# 최신\n- 다음: N132-199\n');
    writeCardConfig(proj, [{ path: 'docs/HANDOFF.md', lines: 5 }]);
    // 서버가 한 번 떠서 스키마를 만든 DB 에 기억 하나
    rpc(ws, {}, []);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO memories (content, memory_type, project, importance) VALUES ('지형 청크 512 m 동결', 'decision', 'game', 8)").run();
    db.close();

    const res = rpc(ws, { PASSBATON_READONLY: '1' }, [
      { name: 'memory_store', arguments: { content: '쓰면 안 됨', type: 'decision', project: 'game' } },
      { name: 'memory_search', arguments: { query: '청크', project: 'game' } },
      { name: 'resume_card', arguments: { project: 'game' } },
    ]);
    const list = res.find(m => m.id === 1).result.tools.map((t: { name: string }) => t.name);
    expect(list).toContain('memory_search');
    expect(list).toContain('resume_card');
    expect(list).not.toContain('memory_store');
    expect(list).not.toContain('session_end');

    const store = res.find(m => m.id === 2).result;
    expect(store.isError).toBe(true);
    expect(store.content[0].text).toContain('PASSBATON_READONLY');
    expect(res.find(m => m.id === 3).result.content[0].text).toContain('지형 청크');
    expect(res.find(m => m.id === 4).result.content[0].text).toContain('다음: N132-199');

    const after = new Database(dbPath, { readonly: true });
    const row = after.prepare("SELECT access_count FROM memories WHERE content = '지형 청크 512 m 동결'").get() as { access_count: number };
    const stored = after.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = '쓰면 안 됨'").get() as { n: number };
    after.close();
    expect(row.access_count).toBe(0);
    expect(stored.n).toBe(0);
  });

  it('역검증: 읽기 전용이 아니면 같은 검색이 조회수를 올린다', () => {
    const { ws, dbPath } = monorepo('game');
    rpc(ws, {}, []);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO memories (content, memory_type, project, importance) VALUES ('지형 청크 512 m 동결', 'decision', 'game', 8)").run();
    db.close();
    rpc(ws, {}, [{ name: 'memory_search', arguments: { query: '청크', project: 'game' } }]);
    const after = new Database(dbPath, { readonly: true });
    const row = after.prepare("SELECT access_count FROM memories WHERE content = '지형 청크 512 m 동결'").get() as { access_count: number };
    after.close();
    expect(row.access_count).toBeGreaterThan(0);
  });
});

describe.skipIf(!built)('UserPromptSubmit — 기계 턴에서는 지시문을 저장하지 않는다', () => {
  function prompt(cwd: string, ws: string, text: string): void {
    spawnSync('node', [USER_PROMPT], {
      input: JSON.stringify({ cwd, prompt: text, session_id: 's1' }),
      encoding: 'utf-8',
      env: { ...process.env, WORKSPACE_ROOT: ws },
    });
  }
  const directives = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true });
    const r = db.prepare('SELECT directive FROM user_directives').all() as Array<{ directive: string }>;
    db.close();
    return r.map(x => x.directive);
  };

  it('task-notification · 긴 패킷에서는 0 건, 사람의 짧은 지시는 저장', () => {
    const { ws, proj, dbPath } = monorepo('game');
    prompt(proj, ws, '<task-notification> <task-id>a1</task-id> 결과: 반드시 커밋 전에 루프를 초록으로 만든다 </task-notification>');
    prompt(proj, ws, '당신은 Ashfall 의 설계 검토자다. 절대 Godot 쪽 코드는 고치지 않는다. ' + '참고 자료 '.repeat(60));
    prompt(proj, ws, '중요 인물 승격 진행해줘');                       // 콜론 없음 → 지시 아님
    expect(directives(dbPath)).toEqual([]);

    prompt(proj, ws, '반드시 커밋 전에 루프를 초록으로 만든다');
    expect(directives(dbPath)).toEqual(['커밋 전에 루프를 초록으로 만든다']);
  });
});
