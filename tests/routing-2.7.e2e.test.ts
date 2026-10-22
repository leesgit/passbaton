// 2.7 — 루트 세션의 명시적 프로젝트 선택 → 재개 카드 (Astra reply-139 PB139-12)
//
// 근거(2026-10-22 실측): 루트에서 `/ashfall` 로 연 대화 15 개에 Ashfall 재개 카드가 한 번도 없었다.
// 역검증(reply-139): 「/ashfall 성공만 확인」 하지 않는다 — 다른 앱·인용 명령·기계 알림·모호한 경로·
// 명시 전환·컴팩션을 함께 돌리고, 부분 문자열 매칭이나 전역(세션 무관) 선택 저장으로 되돌리면 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { leadingCommand, readRoutingDeclaration } from '../src/utils/routing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const built = [SESSION_START, USER_PROMPT].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/** 모노레포: apps/game(카드 선언 있음) · apps/other(카드 선언 있음) · 루트 config 에 routing */
function workspace(routing: Record<string, string> = { '/ashfall': 'apps/game', '/other': 'apps/other', '/home': '.' }) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-27r-')));
  roots.push(ws);
  for (const [name, line] of [['game', '- 다음: N146-000 목표판'], ['other', '- 다음: 다른 앱 일']]) {
    const proj = path.join(ws, 'apps', name);
    fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'HANDOFF.md'), `# 최신\n${line}\n`);
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'),
      JSON.stringify({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' }] } }));
  }
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ routing: { commands: routing } }));
  return { ws, root: path.basename(ws) };
}

function hook(file: string, ws: string, payload: Record<string, unknown>, argv: string[] = [], env: Record<string, string> = {}): string {
  const r = spawnSync('node', [file, ...argv], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws, ...env } });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}
const ask = (ws: string, sid: string, prompt: string, cwd = ws) => hook(USER_PROMPT, ws, { cwd, session_id: sid, prompt });
const start = (ws: string, sid: string, source?: string) => hook(SESSION_START, ws, { cwd: ws, session_id: sid, ...(source ? { source } : {}) });

describe('leadingCommand — 맨 앞의 실제 명령만', () => {
  it.each([
    ['/ashfall 랄프로 이어서', '/ashfall'],
    ['  /Ashfall', '/ashfall'],
    // 실측(2026-10-23)한 훅 입력 그대로
    [JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'hook-input-claude-code-2026-10-23.json'), 'utf-8'))
      .entries.find((e: { event: string }) => e.event === 'UserPromptSubmit').prompt, '/probe'],
  ])('인정: %s', (p, want) => expect(leadingCommand(p)).toBe(want));
  it.each([
    ['이거 /ashfall 명령 고쳐줘'],
    ['`/ashfall` 은 뭐야'],
    ['<task-notification>\n/ashfall\n</task-notification>'],
    ['apps/kenshi-fantasy 봐줘'],
    ['/ashfall-fleet 돌려'.replace('-fleet', 'x')],   // /ashfallx — 다른 명령(부분 일치 아님)
    // reply-147 ⑥: 실측한 훅 입력에는 봉투가 없다 — 봉투 모양은 사람 입력으로 보지 않는다
    ['<command-message>ashfall</command-message>\n<command-name>/ashfall</command-name>\n<command-args>x</command-args>'],
  ])('거부(또는 다른 명령): %s', (p) => expect(leadingCommand(p) === '/ashfall').toBe(false));
});

describe('PB139-12 라우팅 — 실제 훅', () => {
  it.skipIf(!built)('등록 명령 → 그 프로젝트 카드 + 선택 표시(기록은 루트로 · 해제 방법) · 같은 내용이면 반복 안 함 · 바뀌면 다시', () => {
    const { ws, root } = workspace();
    start(ws, 's1');
    const out = ask(ws, 's1', '/ashfall 랄프로 이어서');
    expect(out).toContain('<routed-context project="game" via="/ashfall">');
    expect(out).toContain('다음: N146-000 목표판');
    expect(out).toContain(`still recorded under ${root}`);
    expect(out).toContain('send `/home` to return');
    expect(ask(ws, 's1', '/ashfall 계속')).not.toContain('routed-context');      // 같은 선택·같은 내용
    expect(ask(ws, 's1', '그다음은?')).not.toContain('routed-context');         // 명령 없음·내용 그대로
    fs.writeFileSync(path.join(ws, 'apps', 'game', 'docs', 'HANDOFF.md'), '# 최신\n- 다음: N146-101 분리\n');
    const changed = ask(ws, 's1', '그다음은?');
    expect(changed).toContain('다음: N146-101 분리');                            // 내용 변경 → 다시
  });

  it.skipIf(!built)('음성: 등록 안 된 명령 · 문장 속 언급 · 하네스 알림 · 경로 언급 → 카드 없음', () => {
    const { ws } = workspace();
    start(ws, 's1');
    for (const p of ['/lifeplan 이어서', '이거 /ashfall 명령 고쳐줘', '<task-notification>\n<task-id>x</task-id>\n/ashfall\n</task-notification>', 'apps/game/docs 봐줘']) {
      expect(ask(ws, 's1', p), p).not.toContain('routed-context');
    }
  });

  it.skipIf(!built)('전환과 해제: /ashfall → /other 로 갈아탐 → /home 으로 해제 → 다음 턴 카드 없음', () => {
    const { ws } = workspace();
    start(ws, 's1');
    expect(ask(ws, 's1', '/ashfall')).toContain('project="game"');
    const sw = ask(ws, 's1', '/other');
    expect(sw).toContain('project="other"');
    expect(sw).toContain('다른 앱 일');
    expect(sw).not.toContain('N146-000');
    expect(ask(ws, 's1', '/home')).toContain('Route released');
    expect(ask(ws, 's1', '그다음은?')).not.toContain('routed-context');
    expect(ask(ws, 's1', '/home')).not.toContain('routed-context');             // 풀 것이 없으면 조용히
  });

  it.skipIf(!built)('세션별: 세션 A 의 선택이 세션 B 에 새지 않는다 · 하위 cwd 에서는 라우팅하지 않는다', () => {
    const { ws } = workspace();
    start(ws, 'A');
    expect(ask(ws, 'A', '/ashfall')).toContain('routed-context');
    start(ws, 'B');
    fs.writeFileSync(path.join(ws, 'apps', 'game', 'docs', 'HANDOFF.md'), '# 최신\n- 다음: 바뀜\n');
    expect(ask(ws, 'B', '그다음은?')).not.toContain('routed-context');
    expect(ask(ws, 'B', '/ashfall', path.join(ws, 'apps', 'game'))).not.toContain('routed-context');
  });

  it.skipIf(!built)('컴팩션·재개 뒤 같은 세션은 선택을 잇는다 · 새 세션(startup)은 잇지 않는다', () => {
    const { ws } = workspace();
    start(ws, 's1');
    ask(ws, 's1', '/ashfall');
    const compact = start(ws, 's1', 'compact');
    expect(compact).toContain('<routed-context project="game" via="/ashfall">');
    expect(compact).toContain('N146-000');
    expect(start(ws, 's1', 'resume')).toContain('routed-context');
    expect(start(ws, 's2', 'startup')).not.toContain('routed-context');
    // 컴팩션에서 낸 카드와 같은 내용이면 다음 턴에 반복하지 않는다
    expect(ask(ws, 's1', '이어서')).not.toContain('routed-context');
  });

  it.skipIf(!built)('Codex: 라우팅 카드도 JSON 객체 하나 안에', () => {
    const { ws } = workspace();
    hook(SESSION_START, ws, { cwd: ws, session_id: 's1' }, ['--codex']);
    const out = hook(USER_PROMPT, ws, { cwd: ws, session_id: 's1', prompt: '/ashfall' }, ['--codex']);
    const obj = JSON.parse(out.trim());
    expect(obj.hookSpecificOutput.additionalContext).toContain('<routed-context project="game"');
  });
});

// reply-147 PB139-12 수정 지시의 반례 — 각 수정을 되돌리면 여기서 빨개져야 한다
describe('reply-147 반례', () => {
  const setRouting = (ws: string, routing: Record<string, string>) =>
    fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({ routing: { commands: routing } }));

  it.skipIf(!built)('① 루트와 같은 이름의 하위 앱 · cwd 없는 입력에서는 라우팅하지 않는다', () => {
    const { ws, root } = workspace();
    const twin = path.join(ws, 'apps', root);
    fs.mkdirSync(twin, { recursive: true });
    start(ws, 's1');
    expect(ask(ws, 's1', '/ashfall', twin)).not.toContain('routed-context');
    // 훅 프로세스는 루트에서 떠도(process.cwd() = 루트) 입력에 cwd 가 없으면 추정하지 않는다
    const noCwd = spawnSync('node', [USER_PROMPT], { cwd: ws, input: JSON.stringify({ session_id: 's1', prompt: '/ashfall' }), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
    expect(noCwd.status).toBe(0);
    expect(noCwd.stdout).not.toContain('routed-context');
    expect(ask(ws, 's1', '/ashfall')).toContain('routed-context');              // 진짜 루트에서는 된다
  });

  it('② 워크스페이스 밖으로 나가는 링크(junction)는 받지 않는다', () => {
    const { ws } = workspace();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-27out-')));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(ws, 'apps', 'link'), 'junction');
    setRouting(ws, { '/ashfall': 'apps/game', '/link': 'apps/link', '/home': '.' });
    const d = readRoutingDeclaration(ws);
    expect(d.commands.has('/link')).toBe(false);
    expect(d.invalid).toContain('/link');
  });

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')('② 대소문자만 다른 바깥 형제 경로는 안이 아니다(대소문자 구분 FS)', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-27case-')));
    roots.push(base);
    const ws = path.join(base, 'Repo');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(base, 'repo', 'app'), { recursive: true });
    setRouting(ws, { '/sib': '../repo/app', '/home': '.' });
    const d = readRoutingDeclaration(ws);
    expect(d.commands.has('/sib')).toBe(false);
    expect(d.invalid).toContain('/sib');
  });

  it.skipIf(!built)('③ 본문은 그대로 · 해제 명령 이름만 바뀜 → 다음 턴 안내가 바뀐 카드로 다시', () => {
    const { ws } = workspace();
    start(ws, 's1');
    expect(ask(ws, 's1', '/ashfall')).toContain('send `/home` to return');
    setRouting(ws, { '/ashfall': 'apps/game', '/other': 'apps/other', '/pb-root': '.' });
    const next = ask(ws, 's1', '이어서');
    expect(next).toContain('send `/pb-root` to return');
    expect(ask(ws, 's1', '이어서')).not.toContain('routed-context');           // 바뀐 카드도 한 번만
  });

  it.skipIf(!built)('④ 해제 명령이 없는 설정은 라우팅 전체를 끈다 — 남은 선택은 한 번 알리고 지운다', () => {
    const { ws } = workspace({ '/ashfall': 'apps/game' });
    expect(readRoutingDeclaration(ws).disabled).toMatch(/no release command/);
    start(ws, 's1');
    expect(ask(ws, 's1', '/ashfall')).not.toContain('routed-context');
    // 해제 명령이 있던 때 고른 선택 → 해제 명령을 지우면
    setRouting(ws, { '/ashfall': 'apps/game', '/home': '.' });
    expect(ask(ws, 's1', '/ashfall')).toContain('project="game"');
    setRouting(ws, { '/ashfall': 'apps/game' });
    const cleared = ask(ws, 's1', '이어서');
    expect(cleared).toContain('Route cleared');
    expect(cleared).toContain('no release command');
    expect(cleared).not.toContain('N146-000');
    expect(ask(ws, 's1', '이어서')).not.toContain('routed-context');           // 알림은 한 번
  });

  it.skipIf(!built)('④ 고른 매핑이 지워지면 다음 턴 한 번 알리고 지운다 · 컴팩션 복원도 선택을 암시하지 않는다', () => {
    const { ws } = workspace();
    start(ws, 's1');
    ask(ws, 's1', '/ashfall');
    setRouting(ws, { '/other': 'apps/other', '/home': '.' });
    const cleared = ask(ws, 's1', '이어서');
    expect(cleared).toContain('Route cleared — `/ashfall` → game');
    expect(ask(ws, 's1', '이어서')).not.toContain('routed-context');
    // 컴팩션 쪽: 선택 → 매핑 삭제 → 컴팩션 → 알림 한 번 · 카드 없음 · 다음 턴 조용
    ask(ws, 's1', '/other');
    setRouting(ws, { '/ashfall': 'apps/game', '/home': '.' });
    const compact = start(ws, 's1', 'compact');
    expect(compact).toContain('Route cleared — `/other` → other');
    expect(compact).not.toContain('다른 앱 일');
    expect(ask(ws, 's1', '이어서')).not.toContain('routed-context');
  });

  it.skipIf(!built)('⑤ 컴팩션 복원 카드가 예산 부족으로 빠지면 다음 턴에 낸다(옛 해시로 영구 억제 안 함)', () => {
    const { ws } = workspace();
    start(ws, 's1');
    ask(ws, 's1', '/ashfall');
    const compact = hook(SESSION_START, ws, { cwd: ws, session_id: 's1', source: 'compact' }, [], { MCP_CONTEXT_BUDGET: '20' });
    expect(compact).not.toContain('<routed-context project="game"');
    expect(ask(ws, 's1', '이어서')).toContain('<routed-context project="game"');
    expect(ask(ws, 's1', '이어서')).not.toContain('routed-context');
  });
});

describe('PB139-12 설정 검증', () => {
  it('워크스페이스 밖·없는 경로·모양이 틀린 명령은 받지 않고 invalid 로 남긴다', () => {
    const { ws } = workspace({ '/ashfall': 'apps/game', '/out': '../..', '/none': 'apps/nope', 'bad': 'apps/game', '/home': '.' });
    const d = readRoutingDeclaration(ws);
    expect([...d.commands.keys()].sort()).toEqual(['/ashfall', '/home']);
    expect(d.invalid.sort()).toEqual(['/none', '/out', 'bad']);
  });
});
