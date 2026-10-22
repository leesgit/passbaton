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
import { snapshotHandover } from '../src/utils/handover.js';
import { matchCompaction } from '../src/utils/compact-id.js';

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

function hook(file: string, ws: string, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): string {
  const r = spawnSync('node', [file], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, WORKSPACE_ROOT: ws, ...extraEnv },
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

/** 실제 호스트처럼 줄마다 uuid 를 단다 — 줄 번호 기반이라 앞줄이 같으면 uuid 도 같다(이어 쓴 트랜스크립트). */
function transcript(dir: string, lines: Line[]): string {
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, lines.map((l, i) => JSON.stringify({ uuid: `u${i}`, ...l })).join('\n') + '\n');
  return p;
}
const TP = (ws: string) => path.join(ws, 't.jsonl');

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
  const pre = new Database(dbPath, { readonly: true });
  const handover = pre.prepare("SELECT request, pending, active_file FROM compact_handover WHERE session_id = 's1' AND project = 'game'").get() as
    { request: string | null; pending: number; active_file: string | null } | undefined;
  pre.close();
  const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
  const db = new Database(dbPath, { readonly: true });
  const active = db.prepare("SELECT current_state, updated_at FROM active_context WHERE project = 'game'").get() as
    { current_state: string; updated_at: string } | undefined;
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
    const outB = hook(SESSION_START, ws, { cwd: proj, session_id: 'B', source: 'compact', transcript_path: TP(ws) });
    expect(outB).not.toContain('세션 A 의 요청');
    const outA = hook(SESSION_START, ws, { cwd: proj, session_id: 'A', source: 'compact', transcript_path: TP(ws) });
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
    const first = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    expect(first).toContain('첫 컴팩션 전 요청');   // 양의 대조

    const summaryOnly: Line = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued …' } };
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [summaryOnly, machine(NOTIFY)]) });
    const second = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    expect(second).not.toContain('첫 컴팩션 전 요청');
    expect(second).not.toContain('Recovered after compaction');
  });

  it.skipIf(!built)('transcript 를 못 읽어도(경로 없음) 옛 행을 남기지 않는다 · 새 요청은 정상 복구', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('옛 요청'), reply('네')]) });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: path.join(ws, 'missing.jsonl') });
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).not.toContain('옛 요청');
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('새 요청'), reply('네')]) });
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('Last human request (a request, not a result): 새 요청');
  });

  it.skipIf(!built)('큰 재개 카드와 함께여도 복구 줄이 나오고 전체가 예산 안에 든다', () => {
    const { ws, proj } = workspace();
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), Array.from({ length: 300 }, (_, i) => `- 줄 ${i} ` + '가'.repeat(90)).join('\n'));
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 300, label: 'HANDOFF' }] } }));
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('카드와 같이 나와야 하는 요청'), reply('네')]) });
    const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
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

  /** 카드 정본을 하나 깔아 둔다 — 서버가 「정상 처리」 했는지는 이 줄이 응답에 있는지로 본다 */
  function seedCard(proj: string): void {
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), '# 최신\n- 다음: 정본 줄 N140\n');
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }] } }));
  }

  /** id 1 응답을 파싱해 JSON-RPC 오류·도구 오류가 없고 카드 줄이 있는지 본다 */
  function expectCardOk(stdout: string): void {
    const msgs = stdout.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
    const res = msgs.find(m => m.id === 1);
    expect(res, stdout.slice(0, 300)).toBeDefined();
    expect(res.error).toBeUndefined();
    expect(res.result?.isError ?? false).toBe(false);
    expect(res.result.content[0].text).toContain('정본 줄 N140');
  }

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
    seedCard(proj);
    const out = serverReadonly(ws, proj);
    expectCardOk(out);                          // 양의 효과: 서버가 오류 없이 카드를 냈다
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
  });

  it.skipIf(!built || !fs.existsSync(SERVER))('읽기 전용 서버: 훅이 만든 DB 의 내용·스키마를 바꾸지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    seedCard(proj);
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: '#기억 항상 답변은 한국어로' });
    // WAL 을 본 파일에 접어 두고 비교한다 — 안 그러면 체크포인트만으로 바이트가 달라진다
    const c = new Database(dbPath); c.pragma('wal_checkpoint(TRUNCATE)'); c.close();
    const bytes = fs.readFileSync(dbPath);
    const schema = schemaOf(dbPath);
    const out = serverReadonly(ws, proj);
    expectCardOk(out);
    expect(schemaOf(dbPath)).toBe(schema);
    expect(Buffer.compare(fs.readFileSync(dbPath), bytes)).toBe(0);
  });
});

describe('PB141·PB142 — Stop 의 명령 인자·사람 인용 · 이번 컴팩션 판정 · 남은 분기', () => {
  const command = (args: string): Line => ({ type: 'user', message: { role: 'user', content: `<command-message>ashfall</command-message>\n<command-name>/ashfall</command-name>\n<command-args>${args}</command-args>` } });
  const stopRow = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT last_work, user_intent FROM sessions WHERE project = 'game' ORDER BY id DESC").get() as
      { last_work: string; user_intent: string | null } | undefined;
    db.close();
    return row ? `${row.last_work} ${row.user_intent ?? ''}` : '';
  };

  it.skipIf(!built)('PB141-01 Stop 은 3~4 자 명령 인자를 받는다(옛 Stop 그대로) · 일반 글 4 자는 여전히 버린다', () => {
    // 경우마다 새 작업공간 — 같은 DB 에 이어 쓰면 앞 행을 읽어 거짓 초록/빨강이 된다
    const stopFor = (lines: Line[]) => {
      const { ws, proj, dbPath } = workspace();
      hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
      hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, lines) });
      return stopRow(dbPath);
    };
    expect(stopFor([command('중단해'), reply('중단했습니다.')])).toContain('중단해');
    // 4 자 명령 인자도 받는다
    expect(stopFor([command('취소해줘'), reply('취소했습니다.')])).toContain('취소해줘');
    // 일반 글 4 자는 요약 품질 규칙(< 5)으로 버린다(옛 Stop 그대로) — 양의 대조: 6 자는 남는다
    expect(stopFor([human('그만해요'), reply('알겠습니다 멈춥니다.')])).not.toContain('그만해요');
    expect(stopFor([human('그만해주세요'), reply('알겠습니다 멈춥니다.')])).toContain('그만해주세요');
  });

  it('PB142-03 사람이 붙여 넣은 태그 블록은 인용이다 — 내용까지 남긴다 · 맨 앞 봉투는 기계 줄', () => {
    const quoted = '이 태그를 설명해줘: <bash-stdout>오류 내용</bash-stdout>';
    expect(humanText({ type: 'user', message: { content: quoted } })).toBe(quoted);
    const pasted = '이 결과 보고 판단해줘\n<local-command-stdout>붙여 넣은 출력</local-command-stdout>';
    expect(humanText({ type: 'user', message: { content: pasted } })).toBe(pasted);
    // 실제 하네스 출력 = 맨 앞 봉투(실측 194/194) → 메시지 전체가 기계 줄
    expect(humanText({ type: 'user', message: { content: '<local-command-stdout>하네스 출력</local-command-stdout>' } })).toBe('');
    expect(humanText({ type: 'user', message: { content: '<bash-stdout>out</bash-stdout><bash-stderr></bash-stderr>' } })).toBe('');
  });

  it.skipIf(!built)('PB142-03 Stop 저장: 사람 인용은 남고 하네스 봉투 줄은 요청이 되지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [
      human('이 태그를 설명해줘: <bash-stdout>오류 내용</bash-stdout>'), reply('설명했습니다.'),
      machine('<local-command-stdout>HARNESS-ONLY</local-command-stdout>'),
    ]) });
    const seen = stopRow(dbPath);
    expect(seen).toContain('오류 내용');
    expect(seen).not.toContain('HARNESS-ONLY');
  });

  /** 잠금을 쥔 채로 PreCompact 를 돌린다 — 쓰기·지우기 둘 다 busy 로 실패한다 */
  function lockedPreCompact(ws: string, proj: string, dbPath: string, lines: Line[]): void {
    const lock = new Database(dbPath);
    lock.exec('BEGIN EXCLUSIVE');
    try {
      hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, lines) });
    } finally {
      lock.exec('COMMIT');
      lock.close();
    }
  }

  it.skipIf(!built)('PB142-01 소비되지 않은 최신 행 A + 다음 PreCompact(B) 쓰기·지우기 실패 → A 를 이번 복구로 내지 않는다 · 그 뒤 C 는 정상', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    const tA: Line[] = [human('요청 A'), reply('네 A')];
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, tA) });
    // A 는 소비되지 않았다(SessionStart 누락) · 1 분도 안 됐다 — 시각으로는 「이번 것」 처럼 보인다
    const pre = new Database(dbPath, { readonly: true });
    expect((pre.prepare("SELECT request FROM compact_handover WHERE session_id = 's1'").get() as { request: string }).request).toBe('요청 A');
    pre.close();
    // 대화가 이어지고 다음 컴팩션의 PreCompact(B)가 잠금으로 실패
    const tB: Line[] = [...tA, human('요청 B'), reply('네 B')];
    lockedPreCompact(ws, proj, dbPath, tB);
    const still = new Database(dbPath, { readonly: true });
    expect((still.prepare("SELECT request FROM compact_handover WHERE session_id = 's1'").get() as { request: string }).request).toBe('요청 A');   // 정말 남았다
    still.close();
    const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    expect(out).not.toContain('요청 A');
    expect(out).not.toContain('Recovered after compaction');
    // 그 뒤의 정상 컴팩션 C 는 복구된다
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [...tB, human('요청 C'), reply('네 C')]) });
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('요청 C');
  }, 60000);

  it.skipIf(!built)('PB142-01 컴팩션 산물(경계·요약·첨부)만 뒤에 붙은 트랜스크립트는 「이번 것」 이다', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    const t1: Line[] = [human('컴팩션 전 요청'), reply('네')];
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, t1) });
    transcript(ws, [...t1,
      { type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'u1' },
      { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued …' } },
      { type: 'attachment', attachment: { type: 'compact_file_reference' } },
    ]);
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('컴팩션 전 요청');
  });

  it.skipIf(!built)('PB142-01 판정 근거가 없으면 내지 않는다 — 트랜스크립트 경로 없음 · pre_uuid 없는 옛 행', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('근거 시험 요청'), reply('네')]) });
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact' })).not.toContain('근거 시험 요청');
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('근거 시험 요청');   // 양의 대조
    const db = new Database(dbPath);
    db.prepare("UPDATE compact_handover SET pre_uuid = NULL WHERE session_id = 's1'").run();
    db.close();
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).not.toContain('근거 시험 요청');
  });

  it.skipIf(!built)('PB142-02 같은 컴팩션에서 다시 불려도 같은 복구 · 오래 걸린 컴팩션도 버리지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('다시 불릴 요청'), reply('네')]) });
    const first = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    const again = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    expect(first).toContain('다시 불릴 요청');
    expect(again).toContain('다시 불릴 요청');
    const db = new Database(dbPath);
    db.prepare("UPDATE compact_handover SET created_at = datetime('now', '-2 hours') WHERE session_id = 's1'").run();
    db.close();
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('다시 불릴 요청');
  });

  it.skipIf(!built)('PB140-03 디렉터리는 (not a file now) · 확인할 수 없는 경로는 (could not check)', () => {
    const { ws } = workspace('probe');
    const dir = path.join(ws, 'a-dir');
    fs.mkdirSync(dir);
    const a = compactCycle([human('봐줘'), reply('봤습니다.', [{ name: 'Edit', file_path: dir }])]);
    expect(a.handover?.active_file).toBe(`${dir} (not a file now)`);
    const bad = 'bad\u0000name.ts';   // NUL 은 어느 OS 에서도 stat 이 ENOENT 가 아닌 오류로 던진다
    const b = compactCycle([human('봐줘'), reply('봤습니다.', [{ name: 'Edit', file_path: bad }])]);
    expect(b.handover?.active_file).toBe(`${bad} (could not check)`);
  });

  it.skipIf(!built)('예산을 넘으면 복구 블록을 넣지 않는다(카드가 먼저) · 남으면 넣는다', () => {
    const { ws, proj } = workspace();
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), Array.from({ length: 300 }, (_, i) => `- 줄 ${i} ` + '가'.repeat(90)).join('\n'));
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 300, label: 'HANDOFF' }] } }));
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('예산 시험 요청'), reply('네')]) });
    // 카드 3200 자 ≈ 800 토큰 > 예산 300 → 복구 블록 자리 없음
    const tight = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) }, { MCP_CONTEXT_BUDGET: '300' });
    expect(tight).toContain('## Resume card');
    expect(tight).not.toContain('예산 시험 요청');
    // PreCompact 를 다시 돌리지 않는다 — 예산 때문에 빠진 복구가 같은 컴팩션의 다음 호출에서 되살아나야 한다
    const roomy = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    expect(roomy).toContain('예산 시험 요청');
  });
});

describe('PB143 — 판독 공백 · 같은 스냅샷 · 맨 앞 인용 · 이어 쓴 트랜스크립트 · 8 MiB 경계', () => {
  /** 이어 쓰기: 기존 파일 끝에 줄을 붙인다(실제 호스트처럼 · 줄 번호 기반 uuid 를 이어 단다) */
  function append(ws: string, lines: Line[]): void {
    const p = TP(ws);
    const n = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
    fs.appendFileSync(p, lines.map((l, i) => JSON.stringify({ uuid: `u${n + i}`, ...l })).join('\n') + '\n');
  }
  const boundary: Line = { type: 'system', subtype: 'compact_boundary' };
  const summary: Line = { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued …' } };

  it.skipIf(!built)('PB143-01 U 뒤에 읽지 못한 줄이 있으면 내지 않는다 · 없으면 낸다', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('판독 시험 요청'), reply('네')]) });
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('판독 시험 요청');   // 양의 대조
    fs.appendFileSync(TP(ws), '{"type":"assistant","message":{"role":"assistant","content":"반쯤 쓰인\n');
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).not.toContain('판독 시험 요청');
  });

  it('PB143-01 요청 내용과 pre_uuid 는 같은 스냅샷에서 나온다', () => {
    const s1 = [human('요청 A'), reply('네 A')].map((l, i) => ({ uuid: `u${i}`, ...l }));
    const s2 = [...s1, ...[human('요청 B'), reply('네 B')].map((l, i) => ({ uuid: `u${2 + i}`, ...l }))];
    const a = snapshotHandover(s1, [process.cwd()]);
    const b = snapshotHandover(s2, [process.cwd()]);
    expect([a.handover?.request, a.preUuid]).toEqual(['요청 A', 'u1']);
    expect([b.handover?.request, b.preUuid]).toEqual(['요청 B', 'u3']);
    // 판정도 그 스냅샷 기준: A 의 uuid 뒤에 B 대화가 붙은 트랜스크립트에서는 A 는 지난 것
    expect(matchCompaction(s2, a.preUuid)).toBe('stale');
    expect(matchCompaction(s2, b.preUuid)).toBe('current');
  });

  it('PB143-02 맨 앞 인용 + 사람 요청은 사람 글이다 · 순수 봉투·닫히지 않은 봉투는 기계 줄', () => {
    const q = '<bash-stdout>오류 내용</bash-stdout>\n이 오류를 설명해줘';
    expect(humanText({ type: 'user', message: { content: q } })).toBe(q);
    expect(humanText({ type: 'user', message: { content: '<bash-stdout>out</bash-stdout><bash-stderr></bash-stderr>' } })).toBe('');
    expect(humanText({ type: 'user', message: { content: NOTIFY } })).toBe('');
    expect(humanText({ type: 'user', message: { content: '<task-notification>\n<task-id>x</task-id>\n잘린 알림' } })).toBe('');
    // 코드 인용으로 시작하는 사람 글
    const code = '```\n<bash-stdout>x</bash-stdout>\n```\n이게 뭐야';
    expect(humanText({ type: 'user', message: { content: code } })).toBe(code);
  });

  it.skipIf(!built)('PB143-02 실제 훅: 맨 앞 인용으로 시작한 사람 요청이 복구·Stop 에 남는다', () => {
    const q = '<bash-stdout>오류 내용</bash-stdout>\n이 오류를 설명해줘';
    const { out, handover } = compactCycle([human(q)]);
    // 요청 요약은 맨 앞 인용을 건너뛴 사람 글 — 질문 자체가 나와야 한다(reply-144 PB144-02)
    expect(handover?.request).toBe('이 오류를 설명해줘');
    expect(out).toContain('no reply yet): 이 오류를 설명해줘');
    expect(out).toContain('no reply yet');
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human(q), reply('설명했습니다.')]) });
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT last_work, user_intent FROM sessions WHERE project = 'game' ORDER BY id DESC").get() as { last_work: string; user_intent: string | null };
    db.close();
    // Stop 의 요약 줄도 질문 자체(인용은 원문에 남고 요약은 질문)
    expect(`${row.last_work} ${row.user_intent ?? ''}`).toContain('이 오류를 설명해줘');
  });

  it.skipIf(!built)('PB143-03 이어 쓴 트랜스크립트: 경계·요약 뒤 새 창에 요청이 없으면 지난 창의 A 를 다시 고르지 않는다 · C 는 정상', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('지난 창 요청 A'), reply('네')]) });
    append(ws, [boundary, summary]);
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('지난 창 요청 A');   // 첫 컴팩션 복구
    append(ws, [machine(NOTIFY)]);
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: TP(ws) });
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT request FROM compact_handover WHERE session_id = 's1'").get()).toBeUndefined();
    db.close();
    append(ws, [boundary, summary]);
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).not.toContain('지난 창 요청 A');
    append(ws, [human('새 창 요청 C'), reply('네')]);
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: TP(ws) });
    append(ws, [boundary, summary]);
    const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    expect(out).toContain('새 창 요청 C');
    expect(out).not.toContain('지난 창 요청 A');
  });

  it.skipIf(!built)('PB143-01 U 가 트랜스크립트 끝 8 MiB 밖으로 밀리면 내지 않는다(복구 누락 · 오복구 아님) · 안이면 낸다', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('경계 시험 요청'), reply('네')]) });
    const att = (kb: number): Line => ({ type: 'attachment', attachment: { type: 'file', content: 'x'.repeat(kb * 1024) } });
    append(ws, [boundary, summary, ...Array.from({ length: 6 }, () => att(1000))]);    // ≈ 6 MB — 안
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('경계 시험 요청');
    append(ws, Array.from({ length: 3 }, () => att(1000)));                              // ≈ 9 MB — 밖
    expect(fs.statSync(TP(ws)).size).toBeGreaterThan(8 * 1024 * 1024);
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).not.toContain('경계 시험 요청');
  }, 60000);
});

describe('PB144 — 창 안 판독 공백 · 인용 뒤 질문 · 불확실한 최신 줄 · 답 없는 새 창', () => {
  function append(ws: string, lines: Line[]): void {
    const p = TP(ws);
    const n = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
    fs.appendFileSync(p, lines.map((l, i) => JSON.stringify({ uuid: `u${n + i}`, ...l })).join('\n') + '\n');
  }
  const boundary: Line = { type: 'system', subtype: 'compact_boundary' };
  const summary: Line = { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued …' } };
  const rowOf = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true });
    const r = db.prepare("SELECT request, pending FROM compact_handover WHERE session_id = 's1'").get() as { request: string; pending: number } | undefined;
    db.close();
    return r;
  };

  it.skipIf(!built)('PB144-01 A → 깨진 줄 → 정상 assistant(U) 이면 A 를 이번 요청으로 내지 않는다 · 깨진 줄이 없으면 낸다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    transcript(ws, [human('요청 A')]);
    fs.appendFileSync(TP(ws), '{"type":"user","message":{"role":"user","content":"요청 B 일 수도\n');
    append(ws, [reply('네')]);
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: TP(ws) });
    expect(rowOf(dbPath)).toBeUndefined();
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).not.toContain('요청 A');
    // 양의 대조: 같은 모양에서 깨진 줄만 없으면 복구된다
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: transcript(ws, [human('요청 A'), reply('네')]) });
    expect(rowOf(dbPath)?.request).toBe('요청 A');
    expect(hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) })).toContain('요청 A');
  });

  it('PB144-02 요약 줄: 맨 앞 인용은 건너뛰고, 글 중간의 인용은 요청 문장의 일부로 둔다', () => {
    const lead = '<bash-stdout>오류 내용</bash-stdout>\n이 오류를 설명해줘';
    const inline = '이 태그를 설명해줘: <bash-stdout>오류 내용</bash-stdout>';
    const s1 = snapshotHandover([{ uuid: 'u0', ...human(lead) }], [process.cwd()]);
    const s2 = snapshotHandover([{ uuid: 'u0', ...human(inline) }], [process.cwd()]);
    expect(s1.handover?.request).toBe('이 오류를 설명해줘');
    expect(s2.handover?.request).toBe('이 태그를 설명해줘: <bash-stdout>오류 내용</bash-stdout>');
  });

  it('PB144-03 마지막 요청 뒤의 닫히지 않은 봉투는 옛 A 를 「마지막 요청」 으로 올리지 않는다 · 코드 펜스 인용은 사람 글', () => {
    const open = '<task-notification>\n<task-id>x</task-id>\n잘린 채 끝남';
    const a = snapshotHandover([human('요청 A'), reply('네'), human(open)].map((l, i) => ({ uuid: `u${i}`, ...l })), [process.cwd()]);
    expect(a.handover).toBeNull();
    // 열린 봉투가 사람 요청보다 **앞**이면 그 뒤의 요청은 정상
    const b = snapshotHandover([human(open), human('요청 C')].map((l, i) => ({ uuid: `u${i}`, ...l })), [process.cwd()]);
    expect(b.handover?.request).toBe('요청 C');
    const fenced = '```\n<task-notification>\n잘린 인용\n```\n이거 뭐야';
    const c = snapshotHandover([human('요청 A'), reply('네'), human(fenced)].map((l, i) => ({ uuid: `u${i}`, ...l })), [process.cwd()]);
    expect(c.handover?.request).toBe('이거 뭐야');   // 코드 펜스로 시작 → 사람 글 · 요약은 펜스 블록을 건너뛴다(기존 규칙)
  });

  it.skipIf(!built)('PB144-03 경계·요약 뒤 사람 C 만 있고 답이 없으면 → C + no reply yet', () => {
    const { ws, proj } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 's1' });
    transcript(ws, [human('지난 창 A'), reply('네')]);
    append(ws, [boundary, summary, human('새 창 C')]);
    hook(PRE_COMPACT, ws, { cwd: proj, session_id: 's1', transcript_path: TP(ws) });
    append(ws, [boundary, summary]);
    const out = hook(SESSION_START, ws, { cwd: proj, session_id: 's1', source: 'compact', transcript_path: TP(ws) });
    expect(out).toContain('(a request, not a result · no reply yet): 새 창 C');
    expect(out).not.toContain('지난 창 A');
  });
});
