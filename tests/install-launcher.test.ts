// 훅 실행 명령 형태 (2026-09-07)
//
// `npm exec -- <bin>` 은 로컬/전역 어디서든 도는 대신 발화마다 1,357 ms 를 낸다.
// 이름만 쓰면 125 ms (10.9배). 그래서 설치 시점에 이름이 PATH 에서 풀리는지 보고
// 고른다. 판정 불가면 예전 형태로 — 최악이어도 현상 유지.

import { describe, it, expect } from 'vitest';
import { hookCommand, binResolves, isOurHookCommand } from '../src/hooks/install.js';

describe('hookCommand', () => {
  it('이름이 풀리면 bin 이름만 쓴다 (빠른 경로)', () => {
    expect(hookCommand('post-tool', true)).toBe('passbaton-hook-post-tool');
  });

  it('안 풀리면 npm exec 로 감싼다 (기존 동작 유지)', () => {
    expect(hookCommand('post-tool', false)).toBe('npm exec -- passbaton-hook-post-tool');
  });

  it('호스트 플래그는 양쪽 모두 뒤에 붙는다', () => {
    expect(hookCommand('session-start', true, ' --codex')).toBe('passbaton-hook-session-start --codex');
    expect(hookCommand('session-start', false, ' --gemini')).toBe(
      'npm exec -- passbaton-hook-session-start --gemini',
    );
  });
});

// ★ 재설치 회귀 방지: mergeHooks 는 「우리 것」을 알아봐야 교체한다.
// 못 알아보면 지우지 못하고 **중복 등록**되어 훅이 두 번 돈다.
describe('isOurHookCommand — 형태가 바뀌어도 알아봐야 한다', () => {
  it('새 형태(이름만)를 알아본다', () => {
    expect(isOurHookCommand('passbaton-hook-post-tool')).toBe(true);
  });

  it('옛 형태(npm exec)를 알아본다 — 업그레이드 시 이걸 교체해야 한다', () => {
    expect(isOurHookCommand('npm exec -- passbaton-hook-post-tool')).toBe(true);
  });

  it('더 옛 형태(claude-hook-)도 알아본다', () => {
    expect(isOurHookCommand('npm exec -- claude-hook-session-end')).toBe(true);
    expect(isOurHookCommand('claude-hook-session-end')).toBe(true);
  });

  it('호스트 플래그가 붙어도 알아본다', () => {
    expect(isOurHookCommand('passbaton-hook-session-start --codex')).toBe(true);
  });

  it('남의 훅은 건드리지 않는다', () => {
    expect(isOurHookCommand('my-own-hook --flag')).toBe(false);
    expect(isOurHookCommand(undefined)).toBe(false);
  });
});

describe('binResolves', () => {
  it('없는 이름은 false', () => {
    expect(binResolves('passbaton-definitely-not-a-real-bin-xyz')).toBe(false);
  });

  it('던지지 않는다 (판정 불가는 안전한 쪽으로)', () => {
    expect(() => binResolves('')).not.toThrow();
  });
});
