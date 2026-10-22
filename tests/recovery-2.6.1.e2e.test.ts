// 2.6.1 — 컴팩션 복구 오염 차단(PB139-01) · 훅만 쓰는 설치의 최소 스키마(PB139-02)
//
// 근거: 2026-10-22 실측 — 컴팩션 직후 주입이
//   `♻️ **Recovered after compaction**: <task-notification> | file: passbaton@2.6.0`
//   (Astra reply-139 · 패킷 139 E1). 하네스 알림이 「하던 일」, 패키지 이름이 「작업 파일」 이 됐고,
//   PreCompact 가 증거 없이 current_state 를 덮었다.
//
// 원칙(continuity-2.6 과 같음): 「없음」 만 보는 단언은 훅이 죽어도 통과한다 — 훅 종료 코드와
// **양의 효과**를 같은 테스트 안에서 같이 본다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { humanText } from '../src/utils/human-turn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const PRE_COMPACT = path.resolve(here, '../dist/hooks/pre-compact.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const SERVER = path.resolve(here, '../dist/index.js');
const built = [SESSION_START, USER_PROMPT, PRE_COMPACT].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

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

/** 모노레포 모양 · **DB 없음** — 훅만으로 무엇이 생기는지 본다(MCP 서버를 띄우지 않는다). */
function workspace(name = 'game'): { ws: string; proj: string; dbPath: string } {
  const ws = tmp('pb-261-');
  const proj = path.join(ws, 'apps', name);
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

function hook(file: string, ws: string, payload: Record<string, unknown>): string {
  const r = spawnSync('node', [file], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, WORKSPACE_ROOT: ws },
  });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

type Line = Record<string, unknown>;
const human = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text } });
const machine = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text } });
const reply = (text: string, tools: Array<{ name: string; file_path: string }> = []): Line => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...tools.map((t, i) => ({ type: 'tool_use', id: `t${i}`, name: t.name, input: { file_path: t.file_path } })),
    ],
  },
});
const toolResult = (): Line => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }] } });

const NOTIFY = '<task-notification>\n<task-id>bz6sann1w</task-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>';

function transcript(dir: string, lines: Line[]): string {
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/** SessionStart(부트스트랩) → 기존 State 심기 → PreCompact → SessionStart(compact) */
function compactCycle(lines: Line[], opts: { seedState?: string } = {}) {
  const { ws, proj, dbPath } = workspace();
  hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
  expect(fs.existsSync(dbPath)).toBe(true);
  if (opts.seedState !== undefined) {
    const db = new Database(dbPath);
    db.prepare("INSERT INTO active_context (project, current_state, updated_at) VALUES ('game', ?, '2026-10-01 00:00:00')")
      .run(opts.seedState);
    db.close();
  }
  const tp = transcript(ws, lines);
  hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: tp });
  const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact' });
  const db = new Database(dbPath, { readonly: true });
  const active = db.prepare("SELECT current_state, updated_at FROM active_context WHERE project = 'game'").get() as
    { current_state: string; updated_at: string } | undefined;
  const handover = db.prepare("SELECT request, pending, active_file FROM compact_handover WHERE session_id = 's1' AND project = 'game'").get() as
    { request: string | null; pending: number; active_file: string | null } | undefined;
  db.close();
  return { ws, proj, out, active, handover };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('humanText — 사람 요청만', () => {
  it.each([
    [NOTIFY],
    ['<bash-input> git push</bash-input>'],
    ['<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'],
    ['<system-reminder>x</system-reminder>'],
  ])('기계 줄은 빈 문자열: %s', (t) => {
    expect(humanText({ type: 'user', message: { content: t } })).toBe('');
  });

  it('메타 턴·컴팩션 요약은 빈 문자열 · 명령 인자는 사람 요청', () => {
    expect(humanText({ type: 'user', isMeta: true, message: { content: '# /ashfall — 명령 본문' } })).toBe('');
    expect(humanText({ type: 'user', isCompactSummary: true, message: { content: '이전 대화 요약입니다 길게' } })).toBe('');
    expect(humanText({ type: 'user', message: { content: '<command-message>ashfall</command-message>\n<command-name>/ashfall</command-name>\n<command-args>랄프 이용해서 이어서 진행해줘</command-args>' } }))
      .toBe('랄프 이용해서 이어서 진행해줘');
    expect(humanText({ type: 'user', message: { content: '패스바톤도 계속 개선해줘' } })).toBe('패스바톤도 계속 개선해줘');
  });
});

describe('PB139-01 컴팩션 복구 — 실측 반례', () => {
  it.skipIf(!built)('하네스 알림·패키지 이름은 복구 줄이 되지 않고, 사람 요청이 「요청」 으로 나온다', () => {
    const { out, handover } = compactCycle([
      human('Astra 답 오면 바로 작업 진행해줘'),
      reply('네, 답이 오면 바로 시작합니다. `passbaton@2.6.0` 은 그대로 둡니다.'),
      machine(NOTIFY),
    ]);
    // 양의 효과: 복구 블록이 실제로 나오고 사람 요청을 담는다
    expect(out).toContain('♻️ **Recovered after compaction**');
    expect(out).toContain('Last human request (a request, not a result): Astra 답 오면 바로 작업 진행해줘');
    expect(handover?.request).toBe('Astra 답 오면 바로 작업 진행해줘');
    // 반례
    expect(out).not.toContain('<task-notification>');
    expect(out).not.toContain('passbaton@2.6.0');
    expect(handover?.active_file ?? null).toBeNull();
    // pending = 「요청 뒤에 assistant 글이 없다」 뿐이다(완료 증거 아님) — 알림이 마지막 줄이어도 앞 요청 뒤에 글이 있다
    expect(handover?.pending).toBe(0);
    expect(out).not.toContain('no reply yet');
  });

  it.skipIf(!built)('기존 State 는 덮지 않는다 — 값도 시각도 그대로', () => {
    const { out, active } = compactCycle([
      human('패키지 다시 구워줘'),
      reply('굽습니다.'),
      machine(NOTIFY),
    ], { seedState: 'N132-199 패키지 재시도 중 (Stop 이 적은 결과)' });
    expect(active?.current_state).toBe('N132-199 패키지 재시도 중 (Stop 이 적은 결과)');
    expect(active?.updated_at).toBe('2026-10-01 00:00:00');
    // 표시 이름도 정직하게: 컴팩션이 만든 값이 아니다
    expect(out).toContain('📍 **Last recorded state** (DB · from the last Stop, not from this compaction): N132-199 패키지 재시도 중');
    expect(out).toContain('Last human request (a request, not a result): 패키지 다시 구워줘');
  });

  it.skipIf(!built)('새 DB 에서도 요청으로 State 를 채우지 않는다', () => {
    const { out, active } = compactCycle([human('지도 기능 만들어줘'), reply('시작합니다.')]);
    expect(active).toBeUndefined();
    expect(out).not.toContain('📍');
    expect(out).toContain('Last human request (a request, not a result): 지도 기능 만들어줘');
  });

  it.skipIf(!built)('답이 아직 없는 사람 요청은 「no reply yet」 — 도구 호출·알림이 사이에 있어도', () => {
    const { out, handover } = compactCycle([
      human('먼저 한 질문'),
      reply('답했습니다.'),
      human('이번 요청은 아직 답 전'),
      reply('', [{ name: 'Read', file_path: 'nope.md' }]),
      toolResult(),
      machine(NOTIFY),
    ]);
    expect(handover?.request).toBe('이번 요청은 아직 답 전');
    expect(handover?.pending).toBe(1);
    expect(out).toContain('(a request, not a result · no reply yet): 이번 요청은 아직 답 전');
  });

  it.skipIf(!built)('작업 파일은 도구가 실제로 쓴 경로가 먼저 · 지금 없는 파일은 「삭제」 가 아니라 「not found now」', () => {
    const { ws } = workspace('probe');
    const live = path.join(ws, 'live.ts');
    fs.writeFileSync(live, 'x');
    const never = path.join(ws, 'never-existed.ts');   // 만든 적도 지운 적도 없다

    const a = compactCycle([
      human('고쳐줘'),
      reply('`README.md` 를 봤고 고칩니다.', [{ name: 'Read', file_path: never }, { name: 'Edit', file_path: live }]),
    ]);
    expect(a.handover?.active_file).toBe(live);
    expect(a.out).toContain(`- Active file: ${live}`);

    const b = compactCycle([human('써줘'), reply('씁니다.', [{ name: 'Write', file_path: never }])]);
    expect(b.handover?.active_file).toBe(`${never} (not found now)`);
    expect(b.out).not.toContain('(deleted)');
  });

  it.skipIf(!built)('상대 도구 경로는 훅 프로세스 cwd 가 아니라 입력 cwd 기준으로 확인한다', () => {
    const { ws, proj, dbPath } = workspace();
    fs.writeFileSync(path.join(proj, 'rel.ts'), 'x');
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    // 훅 프로세스 cwd = 이 테스트의 cwd(레포 루트) · 입력 cwd = proj — rel.ts 는 proj 에만 있다
    expect(fs.existsSync(path.resolve(process.cwd(), 'rel.ts'))).toBe(false);
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('고쳐'), reply('고침', [{ name: 'Edit', file_path: 'rel.ts' }])]) });
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare("SELECT active_file FROM compact_handover WHERE session_id = 's1'").get() as { active_file: string }).active_file).toBe('rel.ts');
    db.close();
  });

  it.skipIf(!built)('텍스트 후보는 실제로 있는 파일만 — 패키지 이름·URL 은 버리고 README.md 는 받는다', () => {
    const { ws, proj, dbPath } = workspace();
    fs.writeFileSync(path.join(ws, 'README.md'), '# x');
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    const tp = transcript(ws, [
      human('문서 정리해줘'),
      reply('`README.md` 를 고쳤습니다. 다음은 `passbaton@2.6.0` 과 `https://x.io/a.md` 입니다.'),
    ]);
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: tp });
    const db = new Database(dbPath, { readonly: true });
    const h = db.prepare("SELECT active_file FROM compact_handover WHERE session_id = 's1'").get() as { active_file: string | null };
    db.close();
    expect(h.active_file).toBe('README.md');

    const tp2 = transcript(ws, [human('버전 올려줘'), reply('`passbaton@2.6.0` 을 올립니다. `missing.md` 도.')]);
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's2', transcript_path: tp2 });
    const db2 = new Database(dbPath, { readonly: true });
    const h2 = db2.prepare("SELECT active_file FROM compact_handover WHERE session_id = 's2'").get() as { active_file: string | null };
    db2.close();
    expect(h2.active_file).toBeNull();
  });

  it.skipIf(!built)('복구 줄은 같은 세션에만 — 다른 세션의 컴팩션 요청을 끌어오지 않는다', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 'A', transcript_path: transcript(ws, [human('세션 A 의 요청'), reply('네')]) });
    const outB = hook(SESSION_START, ws, { cwd: proj, session_id: 'B', source: 'compact' });
    expect(outB).not.toContain('세션 A 의 요청');
    const outA = hook(SESSION_START, ws, { cwd: proj, session_id: 'A', source: 'compact' });
    expect(outA).toContain('세션 A 의 요청');
  });
});

describe('PB140-01 사람 요청은 길이로 거르지 않고 · 봉투로 판정한다', () => {
  it('문맥 봉투 뒤의 사람 글은 남고, 알림 속 command-args 인용은 명령이 아니다', () => {
    expect(humanText({ type: 'user', message: { content: '<system-reminder>오늘 날짜 …</system-reminder>\n중단해' } })).toBe('중단해');
    expect(humanText({ type: 'user', message: { content: '중단해' } })).toBe('중단해');
    expect(humanText({ type: 'user', message: { content: '<task-notification>\n<summary>ran <command-args>배포해줘</command-args></summary>\n</task-notification>' } })).toBe('');
    // 사람이 글 중간에 태그를 인용해도 사람 글이다
    expect(humanText({ type: 'user', message: { content: '로그에 <task-id> 가 찍히는 이유가 뭐야' } })).toBe('로그에 <task-id> 가 찍히는 이유가 뭐야');
  });

  it.skipIf(!built)('짧은 최신 요청(「중단해」)이 마지막 요청이 된다 — 앞 요청으로 돌아가지 않는다', () => {
    const { out, handover } = compactCycle([
      human('배포 준비해줘'),
      reply('준비합니다.'),
      human('중단해'),
      machine(NOTIFY),
    ]);
    expect(handover?.request).toBe('중단해');
    expect(handover?.pending).toBe(1);
    expect(out).toContain('(a request, not a result · no reply yet): 중단해');
    expect(out).not.toContain('배포 준비해줘');
  });

  it.skipIf(!built)('Stop 도 같은 규칙 — 알림은 요청이 아니다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    const tp = transcript(ws, [human('지도 화면 버그 고쳐줘'), reply('고쳤습니다.'), machine(NOTIFY)]);
    hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: tp });
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT last_work, user_intent FROM sessions WHERE project = 'game' ORDER BY id DESC").get() as
      { last_work: string; user_intent: string | null } | undefined;
    db.close();
    expect(row).toBeDefined();
    const seen = `${row!.last_work} ${row!.user_intent ?? ''}`;
    expect(seen).toContain('지도 화면 버그 고쳐줘');
    expect(seen).not.toContain('task-notification');
  });
});

describe('PB140-02 같은 세션의 두 번째 컴팩션', () => {
  it.skipIf(!built)('이번 창에 사람 요청이 없으면 지난 컴팩션의 요청·pending 을 다시 내지 않는다', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('첫 컴팩션 전 요청'), machine(NOTIFY)]) });
    const first = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact' });
    expect(first).toContain('첫 컴팩션 전 요청');   // 양의 대조

    const summaryOnly: Line = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued …' } };
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [summaryOnly, machine(NOTIFY)]) });
    const second = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact' });
    expect(second).not.toContain('첫 컴팩션 전 요청');
    expect(second).not.toContain('Recovered after compaction');
  });

  it.skipIf(!built)('transcript 를 못 읽어도(경로 없음) 옛 행을 남기지 않는다 · 새 요청은 정상 복구', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('옛 요청'), reply('네')]) });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: path.join(ws, 'missing.jsonl') });
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact' })).not.toContain('옛 요청');
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('새 요청'), reply('네')]) });
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact' })).toContain('Last human request (a request, not a result): 새 요청');
  });

  it.skipIf(!built)('큰 재개 카드와 함께여도 복구 줄이 나오고 전체가 예산 안에 든다', () => {
    const { ws, proj } = workspace();
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), Array.from({ length: 300 }, (_, i) => `- 줄 ${i} ` + '가'.repeat(90)).join('\n'));
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 300, label: 'HANDOFF' }] } }));
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('카드와 같이 나와야 하는 요청'), reply('네')]) });
    const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact' });
    expect(out).toContain('## Resume card');
    expect(out).toContain('카드와 같이 나와야 하는 요청');
    expect(out.length).toBeLessThan(8000);   // 토큰 예산 2000 ≈ 8000 자(len/4 추정)
  });
});

describe('PB139-02 훅만 쓰는 설치 — MCP 서버 없이', () => {
  it.skipIf(!built)('빈 작업공간: SessionStart 가 만든 DB 에 지시가 저장되고 다음 SessionStart 에 다시 나온다', () => {
    const { ws, proj, dbPath } = workspace();
    expect(fs.existsSync(dbPath)).toBe(false);
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '#기억 항상 답변은 한국어로' });
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT directive FROM user_directives').all() as Array<{ directive: string }>;
    db.close();
    expect(rows.map(r => r.directive)).toContain('항상 답변은 한국어로');
    const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's2' });
    expect(out).toContain('항상 답변은 한국어로');
  });

  it.skipIf(!built)('옛 부트스트랩이 만든 DB(user_directives 없음)도 첫 프롬프트에서 보강된다 · 기존 행 보존', () => {
    const { ws, proj, dbPath } = workspace();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, last_work TEXT, current_status TEXT,
      next_tasks TEXT, modified_files TEXT, issues TEXT)`);
    db.prepare("INSERT INTO sessions (project, last_work) VALUES ('game', '옛 기록')").run();
    db.close();
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '#기억 반드시 pnpm 으로' });
    const d2 = new Database(dbPath, { readonly: true });
    expect((d2.prepare('SELECT directive FROM user_directives').all() as Array<{ directive: string }>).map(r => r.directive))
      .toContain('반드시 pnpm 으로');
    expect((d2.prepare('SELECT last_work FROM sessions').get() as { last_work: string }).last_work).toBe('옛 기록');
    d2.close();
  });

  it.skipIf(!built)('DB 가 없을 때 UserPromptSubmit 은 파일을 만들지 않는다(만드는 것은 SessionStart 뿐)', () => {
    const { ws, proj, dbPath } = workspace();
    // 흔한 모양: .claude/ (settings 등)는 있는데 sessions.db 는 없다 — 폴더가 없으면 열기 자체가 실패해 검사가 안 된다
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '#기억 항상 답변은 한국어로' });
    expect(fs.existsSync(dbPath)).toBe(false);
    // 양의 대조: SessionStart 뒤에는 생긴다
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

describe('PB139-02 반복 초기화 · 읽기 전용 서버', () => {
  const schemaOf = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true });
    const s = (db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{ sql: string | null }>)
      .map(r => JSON.stringify(r)).join('\n');
    db.close();
    return s;
  };

  it.skipIf(!built)('SessionStart·UserPromptSubmit 를 반복해도 스키마는 같고 같은 지시는 한 행', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '#기억 항상 답변은 한국어로' });
    const before = schemaOf(dbPath);
    for (let i = 0; i < 3; i++) {
      hook(SESSION_START, ws, { cwd: proj, session_id: `r${i}` });
      hook(USER_PROMPT, ws, { cwd: proj, session_id: `r${i}`, prompt: '#기억 항상 답변은 한국어로' });
    }
    expect(schemaOf(dbPath)).toBe(before);
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM user_directives WHERE directive = '항상 답변은 한국어로'").get() as { c: number }).c).toBe(1);
    db.close();
  });

  function serverReadonly(ws: string, cwd: string): string {
    const msgs = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resume_card', arguments: { project: 'game' } } },
    ];
    const r = spawnSync('node', [SERVER], {
      input: msgs.map(m => JSON.stringify(m)).join('\n') + '\n',
      encoding: 'utf-8', cwd, timeout: 60000,
      env: { ...process.env, WORKSPACE_ROOT: ws, PASSBATON_READONLY: '1' },
    });
    return r.stdout;
  }

  it.skipIf(!built || !fs.existsSync(SERVER))('읽기 전용 서버: DB 가 없으면 파일을 만들지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    const out = serverReadonly(ws, proj);
    expect(out).toContain('"id":1');            // 양의 효과: 서버가 실제로 답했다
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
  });

  it.skipIf(!built || !fs.existsSync(SERVER))('읽기 전용 서버: 훅이 만든 DB 의 내용·스키마를 바꾸지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '#기억 항상 답변은 한국어로' });
    // WAL 을 본 파일에 접어 두고 비교한다 — 안 그러면 체크포인트만으로 바이트가 달라진다
    const c = new Database(dbPath); c.pragma('wal_checkpoint(TRUNCATE)'); c.close();
    const bytes = fs.readFileSync(dbPath);
    const schema = schemaOf(dbPath);
    const out = serverReadonly(ws, proj);
    expect(out).toContain('"id":1');
    expect(schemaOf(dbPath)).toBe(schema);
    expect(Buffer.compare(fs.readFileSync(dbPath), bytes)).toBe(0);
  });
});
