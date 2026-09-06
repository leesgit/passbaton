// hookTrace — 훅 발화 추적 로그 (2026-09-07)
//
// 이 로그의 목적은 「측정 수단이 없어서」가 아니다. 그 주장은 교차검증에서 반증됐다 —
// SessionStart 발화는 트랜스크립트의 hookEvent 로, 추적 도구의 PostToolUse 는
// hot_paths 로 이미 소급 측정이 가능했다. 남은 신규 가치는 그 둘이 못 보는 것이다:
// 조용한 발화, **프로세스 구분(pid)**, 메인/서브에이전트 구분(tpath), 해석된 ws_root.
//
// ⚠ 격리: isEnabled 는 프로젝트 config 가 없으면 ~/.claude/passbaton.config.json 으로
// 폴백한다. 임시 워크스페이스에 **프로젝트 config 를 명시적으로 써서** 개발자 홈 설정에
// 의존하지 않게 한다 (config-toggles.test.ts 가 쓰는 것과 같은 방법).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { trace, tpathOf } from '../src/utils/hook-trace.js';
import { invalidateConfigCache } from '../src/utils/config.js';

let ws: string;
const savedEnv = process.env.PASSBATON_HOOKTRACE;

const logPath = () => path.join(ws, '.claude', 'hook-trace.log');
const readLog = () => fs.readFileSync(logPath(), 'utf-8');

/** 프로젝트 config 를 써서 홈 설정으로부터 격리한다. */
function setFlag(enabled: boolean): void {
  fs.writeFileSync(
    path.join(ws, '.claude', 'passbaton.config.json'),
    JSON.stringify({ features: { hookTrace: { enabled } } }),
  );
  invalidateConfigCache();
}

beforeEach(() => {
  delete process.env.PASSBATON_HOOKTRACE;
  invalidateConfigCache();
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-trace-')));
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PASSBATON_HOOKTRACE;
  else process.env.PASSBATON_HOOKTRACE = savedEnv;
  invalidateConfigCache();
  try {
    fs.rmSync(ws, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('hookTrace', () => {
  it('기본은 OFF — 로그 파일이 아예 안 생긴다', () => {
    setFlag(false);

    trace('session-start', ws, { project: 'demo' });

    expect(fs.existsSync(logPath())).toBe(false);
  });

  it('config 파일로 켜진다 (Windows 에서 훅이 실제로 쓸 수 있는 유일한 경로)', () => {
    setFlag(true);

    trace('session-start', ws, { project: 'demo' });

    expect(readLog()).toContain('hook=session-start');
  });

  it('env 로도 켜진다', () => {
    setFlag(false);
    process.env.PASSBATON_HOOKTRACE = '1';

    trace('session-start', ws, { project: 'demo' });

    expect(readLog()).toContain('hook=session-start');
  });

  // ★ pid 가 없으면 「한 프로세스가 N번」과 「N 프로세스가 1번씩」이 구분되지 않는다.
  it('pid 와 ws_root 는 호출부가 안 줘도 항상 붙는다', () => {
    setFlag(true);

    trace('post-tool-use', ws, { tool: 'Edit' });

    const line = readLog().trim();
    expect(line).toContain(`pid=${process.pid}`);
    expect(line).toContain(`ws_root=${ws.replace(/\s+/g, '_')}`);
  });

  it('여러 번 부르면 줄이 쌓인다 — 발화 횟수를 세려는 것이므로', () => {
    setFlag(true);

    trace('post-tool-use', ws, { tool: 'Edit' });
    trace('post-tool-use', ws, { tool: 'Write' });

    expect(readLog().trim().split('\n')).toHaveLength(2);
  });

  // ★ 안전 규칙: 진단 코드가 워크스페이스 탐지를 망가뜨리면 안 된다
  it('.claude 디렉터리가 없으면 만들지 않는다', () => {
    setFlag(true);
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-bare-')));

    trace('post-tool-use', bare, { tool: 'Edit' });

    expect(fs.existsSync(path.join(bare, '.claude'))).toBe(false);
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('빈 값 / undefined 필드는 줄에서 빠진다', () => {
    setFlag(true);

    trace('session-start', ws, { project: 'demo', tpath: undefined, source: '', injected_chars: 0 });

    const line = readLog().trim();
    expect(line).toContain('project=demo');
    expect(line).not.toContain('tpath=');
    expect(line).not.toContain('source=');
    expect(line).toContain('injected_chars=0'); // 0 은 유의미한 값이라 남는다
  });

  it('공백이 든 값은 한 토큰으로 눌러 쓴다 (줄 파싱이 깨지지 않게)', () => {
    setFlag(true);

    trace('post-tool-use', ws, { file: 'C:/a b/c.ts' });

    expect(readLog()).toContain('file=C:/a_b/c.ts');
  });

  // ⚠ 이 검사는 한 번 발동 불능이었다. 처음엔 존재하지 않는 경로를 줬는데, 그러면
  // existsSync 에서 먼저 return 해서 catch 에 도달하지 않는다 — try/catch 를 통째로
  // 지워도 초록이었다. 실제로 쓰기가 실패해야 fail-soft 를 재는 것이다.
  it('쓰기가 실패해도 던지지 않는다 (fail-soft)', () => {
    setFlag(true);
    fs.mkdirSync(logPath(), { recursive: true }); // 로그 자리를 디렉터리로 막는다 → EISDIR

    expect(() => trace('session-start', ws, { a: 1 })).not.toThrow();
  });

  it('5MB 를 넘으면 한 세대만 굴린다', () => {
    setFlag(true);
    fs.writeFileSync(logPath(), Buffer.alloc(5 * 1024 * 1024 + 1));

    trace('post-tool-use', ws, { tool: 'Edit' });

    expect(fs.existsSync(logPath() + '.1')).toBe(true);
    expect(readLog().trim().split('\n')).toHaveLength(1); // 새 파일은 방금 줄 하나뿐
  });
});

describe('tpathOf — 메인/서브에이전트 구분자', () => {
  // 서브에이전트는 부모의 session_id 를 그대로 받는다(실측: 서브 8개 전부 동일).
  // 그래서 sid 로는 못 가른다. 트랜스크립트 파일명이 가른다.
  it('서브에이전트 트랜스크립트는 agent- 로 시작하는 basename 이다', () => {
    expect(tpathOf('C:/x/subagents/agent-a3cd41cf.jsonl')).toBe('agent-a3cd41cf.jsonl');
  });

  it('메인 세션은 세션 uuid 파일명이다', () => {
    expect(tpathOf('/home/u/.claude/projects/p/e9f792f1-98c0.jsonl')).toBe('e9f792f1-98c0.jsonl');
  });

  it('경로가 없으면 undefined (필드가 줄에서 빠진다)', () => {
    expect(tpathOf(undefined)).toBeUndefined();
  });
});
