// 2.8 — 설치 경로 계약 시험 (Astra reply-170 PB170-030 · N1) + 자동 해법 주입 제거·수동 해법 도구 보존 (C6)
//
// 왜: 오류 해법 자동 주입은 「훅을 직접 부르면 초록」 이었지만 설치기가 PostToolUse 를 matcher Edit·Write 로만 등록해서
// 실제 설치에서는 Bash 발화가 한 번도 훅에 오지 않았다. 직접 호출 성공 ≠ 설치 경로 도달.
//
// 방법: **실제 설치기**(dist/hooks/install.js)를 임시 HOME 에서 돌려 만든 등록 정보만으로 이벤트를 전달한다 —
//   이벤트 이름으로 항목을 고르고, 도구 이벤트는 호스트처럼 matcher 를 도구 이름에 맞춰 보고, 등록된 명령을 그대로 띄운다.
//   Codex·Gemini 의 등록 명령은 전역 bin 이름이라 package.json `bin` 대응표로 같은 파일을 띄운다(전역 설치 없음).
//   ⛔ 사용자의 ~/.claude · ~/.codex · ~/.gemini 는 건드리지 않는다(HOME·USERPROFILE 을 임시 폴더로).
// 도달 판정은 훅의 **관측 가능한 효과**(DB 행·출력·로그)로 한다 — 프로세스가 뜬 것만으로는 도달이 아니다.

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const INSTALLER = path.join(ROOT, 'dist', 'hooks', 'install.js');
const POST_TOOL_SRC = path.join(ROOT, 'src', 'hooks', 'post-tool-use.ts');
const SERVER = path.join(ROOT, 'dist', 'index.js');
const built = fs.existsSync(INSTALLER) && fs.existsSync(SERVER);
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

/**
 * 호스트별 지원 표 — 등록된 이벤트 집합이 **정확히** 이것이어야 한다(빠짐·이름 바뀜·추가 모두 빨강).
 * PostToolUse 는 Claude 만 · 도구는 Edit·Write 만(Bash·Read·Glob·Grep 은 미등록).
 */
const SUPPORT = {
  claude: ['PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit'],
  codex: ['PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit'],          // PostToolUse 미지원(등록 없음)
  gemini: ['BeforeAgent', 'PreCompress', 'SessionEnd', 'SessionStart'],       // 도구 후 이벤트 미지원(등록 없음)
} as const;
const POST_TOOL_REQUIRED = ['Edit', 'Write'];
/** post-tool-use.ts 에 분기는 있지만 설치기가 등록하지 않아 도달하지 않는 도구 — 이유를 밝혀 둔다 */
const POST_TOOL_UNREACHED: Record<string, string> = {
  Read: 'hot_paths 만 · 미등록', Glob: 'hot_paths 만 · 미등록', Grep: 'hot_paths 만 · 미등록',
};

const dirs: string[] = [];
const tmp = (name: string) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), name))); dirs.push(d); return d; };
afterEach(() => {
  while (dirs.length > 1) {   // 설치 HOME(첫 번째)은 파일 끝까지 쓴다
    try { fs.rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
afterAll(() => {
  while (dirs.length) {
    try { fs.rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

type Handler = { type?: string; command: string; args?: string[] };
type Entry = { matcher?: string; hooks?: Handler[]; type?: string; command?: string };
type HookMap = Record<string, Entry[]>;
let home = '';
let reg: { claude: HookMap; codex: HookMap; gemini: HookMap };

beforeAll(() => {
  if (!built) return;
  home = tmp('pb-28inst-');
  fs.mkdirSync(path.join(home, '.codex'));
  fs.mkdirSync(path.join(home, '.gemini'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.PASSBATON_POSTINSTALL;
  const r = spawnSync(process.execPath, [INSTALLER, 'install'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  const read = (p: string) => (JSON.parse(fs.readFileSync(path.join(home, p), 'utf8')) as { hooks: HookMap }).hooks;
  reg = { claude: read('.claude/settings.json'), codex: read('.codex/hooks.json'), gemini: read('.gemini/settings.json') };
});

/** Claude Code 의 matcher 규칙: 없음·빈 문자열·'*' = 전부 · 그 밖은 도구 이름 전체에 맞는 정규식(대소문자 구별) */
const matches = (matcher: string | undefined, tool: string) =>
  matcher === undefined || matcher === '' || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool);

/** 등록 정보만으로 이 이벤트(+도구)에 호스트가 띄울 명령들 */
function dispatch(map: HookMap, event: string, tool?: string): Handler[] {
  return (map[event] ?? [])
    .filter(e => tool === undefined || matches(e.matcher, tool))
    .flatMap(e => e.hooks ?? (e.command ? [{ command: e.command }] : []));
}

const BIN = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin;
/** 등록 명령을 띄운다 — exec 형식은 셸 없이 그대로 · 전역 bin 이름은 package.json bin 대응 파일로 */
function launch(h: Handler, payload: Record<string, unknown>, ws: string) {
  const env = { ...process.env, WORKSPACE_ROOT: ws, HOME: home, USERPROFILE: home };
  if (h.args) return spawnSync(h.command, h.args, { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 60_000, shell: false });
  const [name, ...flags] = h.command.split(' ');
  expect(BIN[name], `registered command ${name} is a package bin`).toBeTruthy();
  return spawnSync(process.execPath, [path.join(ROOT, BIN[name]), ...flags], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 60_000 });
}
function deliver(map: HookMap, event: string, payload: Record<string, unknown>, ws: string, tool?: string): string[] {
  const hs = dispatch(map, event, tool);
  return hs.map(h => {
    const r = launch(h, tool ? { ...payload, tool_name: tool } : payload, ws);
    expect(r.status, `${event}${tool ? `(${tool})` : ''} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
    return r.stdout;
  });
}

function workspace() {
  const ws = tmp('pb-28iw-');
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}
const q = <T>(dbPath: string, sql: string, ...p: unknown[]) => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare(sql).all(...p) as T[]; } finally { db.close(); }
};
function transcript(ws: string, text: string): string {
  const t = path.join(ws, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(t, [
    { type: 'user', uuid: 'u1', message: { content: text } },
    { type: 'assistant', uuid: 'a1', message: { content: `구현 완료 — ${text} 를 처리했고 검증까지 마쳤습니다.` } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  return t;
}

describe.skipIf(!built)('PB170-030 N1 — 호스트별 등록 이벤트 = 지원 표', () => {
  it.each(Object.keys(SUPPORT) as Array<keyof typeof SUPPORT>)('%s: 등록된 이벤트 집합이 지원 표와 같다', (host) => {
    expect(Object.keys(reg[host]).sort()).toEqual([...SUPPORT[host]]);
    for (const ev of SUPPORT[host]) expect(dispatch(reg[host], ev).length, `${host} ${ev}`).toBeGreaterThan(0);
  });

  it('Claude PostToolUse: 필요한 도구(Edit·Write)는 각각 정확히 한 명령 · Bash·Read·Glob·Grep 은 아무것도 안 뜬다(미지원 명시)', () => {
    for (const t of POST_TOOL_REQUIRED) expect(dispatch(reg.claude, 'PostToolUse', t), t).toHaveLength(1);
    for (const t of ['Bash', ...Object.keys(POST_TOOL_UNREACHED)]) expect(dispatch(reg.claude, 'PostToolUse', t), t).toHaveLength(0);
  });

  it('정적 대조: post-tool-use.ts 가 분기하는 도구 이름 ⊆ 등록으로 도달하는 도구 ∪ 미도달 명시 목록', () => {
    const src = fs.readFileSync(POST_TOOL_SRC, 'utf8').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
    const named = new Set<string>();
    for (const m of src.matchAll(/toolName\s*===\s*'(\w+)'/g)) named.add(m[1]);
    for (const m of src.matchAll(/\[([^\]]*)\]\.includes\(toolName\)/g)) for (const n of m[1].matchAll(/'(\w+)'/g)) named.add(n[1]);
    for (const m of src.matchAll(/TRACKED_TOOLS\s*=\s*\[([^\]]*)\]/g)) for (const n of m[1].matchAll(/'(\w+)'/g)) named.add(n[1]);
    expect([...named].sort()).toEqual(expect.arrayContaining(POST_TOOL_REQUIRED));
    const orphan = [...named].filter(t => dispatch(reg.claude, 'PostToolUse', t).length === 0 && !(t in POST_TOOL_UNREACHED));
    expect(orphan, 'hook branches on a tool the installer never delivers').toEqual([]);
  });
});

describe.skipIf(!built)('PB170-030 N1 — 등록 정보로 전달 → 훅 도달(관측 효과)', () => {
  it('Claude: SessionStart → UserPromptSubmit → PostToolUse(Edit·Write) → PreCompact → Stop 이 각각 제 효과를 낸다', () => {
    const { ws, proj, dbPath } = workspace();
    const base = { cwd: proj, session_id: 'sess-n1-claude' };
    const startOut = deliver(reg.claude, 'SessionStart', { ...base, source: 'startup' }, ws).join('');
    expect(fs.existsSync(dbPath), 'SessionStart created the db').toBe(true);
    expect(startOut).toContain('game - Session Resumed');

    deliver(reg.claude, 'UserPromptSubmit', { ...base, prompt: '청크 경계 고쳐줘', prompt_id: 'p1' }, ws);
    expect(q(dbPath, 'SELECT 1 FROM session_turns WHERE session_id = ?', base.session_id)).toHaveLength(1);

    deliver(reg.claude, 'PostToolUse', { ...base, tool_input: { file_path: path.join(proj, 'src/a.ts'), old_string: 'a', new_string: 'b' } }, ws, 'Edit');
    deliver(reg.claude, 'PostToolUse', { ...base, tool_input: { file_path: path.join(proj, 'src/b.ts'), content: 'x' } }, ws, 'Write');
    const files = q<{ file_path: string }>(dbPath, 'SELECT file_path FROM session_files WHERE session_id = ? ORDER BY file_path', base.session_id).map(r => r.file_path);
    expect(files).toEqual([path.join(proj, 'src/a.ts'), path.join(proj, 'src/b.ts')]);

    const t = transcript(ws, '청크 경계 고쳐줘');
    deliver(reg.claude, 'PreCompact', { ...base, transcript_path: t, trigger: 'manual' }, ws);
    // 효과 = 이 세션의 인계 행(SessionStart(compact) 가 읽는 것). 훅 전용 DB 의 project_context 부재로 사람용
    //   systemMessage 가 빠지던 결함(2.7.3~)은 PB174-010 (b) 에서 고쳤다 — tests/compact-recovery-2.8.e2e.test.ts
    const rows = q<{ request: string | null }>(dbPath, 'SELECT request FROM compact_handover WHERE session_id = ?', base.session_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].request).toContain('청크 경계 고쳐줘');

    const before = q(dbPath, 'SELECT id FROM sessions').length;
    deliver(reg.claude, 'Stop', { ...base, transcript_path: t }, ws);
    expect(q(dbPath, 'SELECT id FROM sessions').length).toBe(before + 1);
  });

  it('Claude PostToolUse(Bash): 전달할 명령이 없다 — 이벤트가 와도 DB·출력 변화 없음', () => {
    const { ws, proj, dbPath } = workspace();
    deliver(reg.claude, 'SessionStart', { cwd: proj, session_id: 's-b', source: 'startup' }, ws);
    const out = deliver(reg.claude, 'PostToolUse', { cwd: proj, session_id: 's-b', tool_input: { command: 'npm test' },
      tool_result: 'Error: Cannot find module shader-cache-1' }, ws, 'Bash');
    expect(out).toEqual([]);
    expect(q(dbPath, 'SELECT 1 FROM session_files')).toHaveLength(0);
  });

  it.each([['codex', 'UserPromptSubmit', 'Stop'], ['gemini', 'BeforeAgent', 'SessionEnd']] as const)(
    '%s: 등록된 SessionStart·프롬프트·종료 이벤트가 같은 훅에 닿는다(호스트 표지 포함)', (host, promptEv, endEv) => {
      const { ws, proj, dbPath } = workspace();
      const base = { cwd: proj, session_id: `sess-n1-${host}` };
      const out = deliver(reg[host], 'SessionStart', { ...base, source: 'startup' }, ws).join('');
      expect(JSON.parse(out.trim()).hookSpecificOutput.hookEventName).toBe('SessionStart');   // JSON 호스트 출력
      deliver(reg[host], promptEv, { ...base, prompt: '청크 경계 고쳐줘' }, ws);
      expect(q(dbPath, 'SELECT 1 FROM session_turns WHERE session_id = ?', base.session_id)).toHaveLength(1);
      const before = q(dbPath, 'SELECT id FROM sessions').length;
      // Codex·Gemini 의 Stop 은 트랜스크립트 형식이 달라 마지막 assistant 글(last_assistant_message)로 요약한다
      deliver(reg[host], endEv, { ...base, last_assistant_message: '구현 완료 — 청크 경계 계산을 고쳤고 검증까지 마쳤습니다.' }, ws);
      expect(q(dbPath, 'SELECT id FROM sessions').length).toBe(before + 1);
    });
});

describe.skipIf(!built)('PB170-030 C6 — 자동 해법 주입 없음 · 수동 해법 도구 보존', () => {
  function rpc(ws: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
    const msgs = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      ...calls.map((c, i) => ({ jsonrpc: '2.0', id: 1 + i, method: 'tools/call', params: c })),
    ];
    const r = spawnSync('node', [SERVER], { input: msgs.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf-8',
      env: { ...process.env, WORKSPACE_ROOT: ws }, timeout: 60000 });
    return r.stdout.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as { id: number; result?: { content?: Array<{ text: string }> } });
  }

  it('Bash 오류 출력을 훅에 직접 줘도 <past-solution> 이 없다 — 같은 해법은 solution_find 로 찾힌다', () => {
    const { ws, proj } = workspace();
    const rec = rpc(ws, [{ name: 'solution_record', arguments: { project: 'game', errorSignature: 'Cannot find module shader-cache',
      solution: '셰이더 캐시 모듈 경로를 tsconfig paths 에 추가했다' } }]);
    expect(rec.find(m => m.id === 1)?.result).toBeTruthy();
    const post = Object.entries(BIN).find(([k]) => k === 'passbaton-hook-post-tool')![1];
    const r = spawnSync(process.execPath, [path.join(ROOT, post)], { encoding: 'utf8', env: { ...process.env, WORKSPACE_ROOT: ws },
      input: JSON.stringify({ tool_name: 'Bash', cwd: proj, tool_result: 'Error: Cannot find module shader-cache-1\n    at load (x.js:1:1)' }) });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('<past-solution>');
    const found = rpc(ws, [{ name: 'solution_find', arguments: { query: 'Cannot find module shader-cache', project: 'game' } }]);
    expect(found.find(m => m.id === 1)?.result?.content?.[0]?.text ?? '').toContain('셰이더 캐시 모듈 경로를 tsconfig paths 에 추가했다');
  });
});
