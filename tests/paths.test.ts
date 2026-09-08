// utils/paths — 추적 제외 규칙
//
// 왜 이 파일이 있는가: post-tool-use 의 무시 목록이 **Windows 에서 7개 중 5개가
// 죽어 있었다.** `filePath.includes('dist/')` 는 `C:\...\dist\index.js` 에 대해
// 언제나 false 다. 살아 있던 것은 슬래시가 없는 `node_modules` 와 `.DS_Store`
// 둘뿐이다.
//
// 그래서 테스트의 첫 축은 **백슬래시 경로**다. 슬래시 경로만 검사하면 이 결함이
// 그대로 재발하고 테스트는 전부 초록이다.
//
// 두 번째 축은 scratchpad 다. 2026-09-08 실측에서 sessions.modified_files
// 30일치 2,896항목 중 520개(18.0%)가 **다른 세션의 스크래치패드**였고, 그
// 520개가 전부 `.../scratchpad/...` 였다.

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { isIgnoredPath, filterTrackedPaths, normalizePath, displayName } from '../src/utils/paths.js';

/** 백슬래시로 이어붙인 Windows 경로. 리터럴 이스케이프를 피해 의도를 드러낸다. */
const win = (...parts: string[]) => parts.join('\\');

describe('isIgnoredPath — Windows 백슬래시 경로 (이 수정의 이유)', () => {
  const cases: Array<[string, string]> = [
    ['dist', win('C:', 'Users', 'me', 'repo', 'dist', 'index.js')],
    ['build', win('C:', 'Users', 'me', 'repo', 'build', 'out.o')],
    ['.git', win('C:', 'Users', 'me', 'repo', '.git', 'config')],
    ['.next', win('C:', 'Users', 'me', 'repo', '.next', 'server.js')],
    ['coverage', win('C:', 'Users', 'me', 'repo', 'coverage', 'lcov.info')],
    ['node_modules', win('C:', 'Users', 'me', 'repo', 'node_modules', 'x', 'a.js')],
  ];

  for (const [name, p] of cases) {
    it(`${name} 을 제외한다`, () => {
      expect(isIgnoredPath(p)).toBe(true);
    });
  }

  it('옛 includes 방식으로는 6개 중 5개가 통과했다', () => {
    const old = ['node_modules', '.git/', 'dist/', 'build/', '.next/', 'coverage/', '.DS_Store'];
    const escaped = cases.filter(([, p]) => !old.some((i) => p.includes(i)));
    expect(escaped.map(([n]) => n)).toEqual(['dist', 'build', '.git', '.next', 'coverage']);
  });
});

describe('isIgnoredPath — 슬래시 경로도 그대로 동작한다', () => {
  it('posix dist', () => expect(isIgnoredPath('/home/me/repo/dist/index.js')).toBe(true));
  it('posix node_modules', () => expect(isIgnoredPath('/home/me/repo/node_modules/a.js')).toBe(true));
});

describe('isIgnoredPath — 스크래치패드', () => {
  it('%TEMP%\\claude\\...\\scratchpad 를 제외한다', () => {
    const p = win('C:', 'Users', 'me', 'AppData', 'Local', 'Temp', 'claude', 'proj', 'sid', 'scratchpad', 'heartbeat.py');
    expect(isIgnoredPath(p)).toBe(true);
  });

  it('posix 형태의 scratchpad 도 제외한다', () => {
    expect(isIgnoredPath('/tmp/claude/x/scratchpad/a.py')).toBe(true);
  });

  // ⛔ 규칙을 「%TEMP% 하위 전부」로 넓히면 아래 둘이 죽는다. 멀티에이전트
  // 워크트리는 %TEMP% 아래에 생기고 그 안의 편집은 진짜 작업이다. 실측된
  // 오염이 scratchpad 뿐이었으므로 규칙도 거기까지만 간다.
  it('%TEMP% 안이어도 scratchpad 가 아니면 추적한다 (워크트리)', () => {
    expect(isIgnoredPath(path.join(os.tmpdir(), 'wf-worktree-abc', 'src', 'Sim.cs'))).toBe(false);
  });

  it('%TEMP% 워크트리 — Windows 형태', () => {
    const wt = win('C:', 'Users', 'me', 'AppData', 'Local', 'Temp', 'wf-abc', 'game', 'WorldRoot.cs');
    expect(isIgnoredPath(wt)).toBe(false);
  });
});

describe('isIgnoredPath — 삼키면 안 되는 것 (includes 방식의 오탐)', () => {
  const keep = [
    win('C:', 'repo', 'tools', 'build.ps1'),       // 파일명이 build
    win('C:', 'repo', 'src', 'distributed.ts'),     // dist 로 시작하는 단어
    win('C:', 'repo', 'src', 'mydist', 'a.ts'),     // dist 를 포함하는 디렉터리명
    win('C:', 'repo', 'docs', 'coverage-plan.md'),  // coverage 를 포함하는 파일명
    win('C:', 'repo', 'game', 'project.godot'),
  ];

  for (const p of keep) {
    it(`유지: ${p}`, () => expect(isIgnoredPath(p)).toBe(false));
  }

  it('빈 문자열은 「모른다」이므로 제외하지 않는다', () => {
    expect(isIgnoredPath('')).toBe(false);
  });
});

describe('filterTrackedPaths', () => {
  it('순서를 보존하고 제외 대상만 걷어낸다', () => {
    const input = [
      win('C:', 'repo', 'src', 'a.ts'),
      win('C:', 'Users', 'me', 'AppData', 'Local', 'Temp', 'claude', 'x', 'scratchpad', 'b.py'),
      win('C:', 'repo', 'src', 'c.ts'),
      win('C:', 'repo', 'dist', 'c.js'),
    ];
    expect(filterTrackedPaths(input)).toEqual([
      win('C:', 'repo', 'src', 'a.ts'),
      win('C:', 'repo', 'src', 'c.ts'),
    ]);
  });
});

describe('normalizePath / displayName', () => {
  it('백슬래시를 슬래시로 통일한다', () => {
    expect(normalizePath(win('C:', 'a', 'b.ts'))).toBe('C:/a/b.ts');
  });

  it('Windows 경로에서도 파일명을 뽑는다 — path.basename 은 posix 실행에서 실패한다', () => {
    expect(displayName(win('C:', 'repo', 'src', 'WorldRoot.cs'))).toBe('WorldRoot.cs');
  });
});
