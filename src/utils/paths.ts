/**
 * 추적할 가치가 없는 파일 경로를 가려낸다.
 *
 * ★ 왜 별도 파일인가 — 원래 post-tool-use.ts 안의 배열 하나였는데, 그 배열이
 * **Windows 에서 절반이 죽어 있었다.**
 *
 *     IGNORED_PATTERNS = ['node_modules', '.git/', 'dist/', 'build/', ...]
 *     filePath.includes('dist/')      // C:\...\dist\index.js  → false
 *
 * 구분자가 백슬래시라 슬래시가 붙은 5개(`.git/` `dist/` `build/` `.next/`
 * `coverage/`)는 **한 번도 걸린 적이 없다.** 걸린 것은 슬래시가 없는
 * `node_modules` 와 `.DS_Store` 둘뿐이다. 2026-09-08 실측으로 확인했다.
 *
 * ★ 그리고 `includes` 는 애초에 틀린 도구다. 부분문자열이라 `tools/build.ps1`
 * 이나 `mydist/` 같은 정상 파일도 함께 삼킨다. 그래서 여기서는 **경로 세그먼트
 * 완전 일치**로 본다 — 좁아지는 방향이라 오탐이 늘지 않는다.
 */

import * as path from 'path';

/**
 * 통째로 건너뛸 디렉터리 이름. 세그먼트 완전 일치로 비교한다.
 *
 * ★ `scratchpad` 가 여기 있는 이유는 실측이다. sessions.modified_files 30일치
 * 2,896항목 중 **520개(18.0%)** 가 다른 세션의 스크래치패드였고, 그 **520개가
 * 전부** `.../scratchpad/...` 형태였다(temp 안의 다른 형태는 0건).
 *
 * ⛔ 그래서 「%TEMP% 하위를 통째로 제외」로 넓히지 않는다. 그렇게 하면
 * **워크트리를 삼킨다** — 멀티에이전트 실행이 만드는 워크스페이스는 %TEMP%
 * 아래에 생기고, 그 안의 편집은 진짜 작업이다. 측정된 것은 scratchpad 뿐이므로
 * 규칙도 거기까지만 간다.
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.venv',
  '__pycache__',
  'scratchpad',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** 경로를 슬래시 형태로 통일한다. 비교는 전부 이 형태에서 한다. */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * 이 경로를 추적에서 제외해야 하는가.
 *
 * 빈 문자열은 「모른다」이므로 제외하지 않는다 — 호출부가 경로 없는 발화를
 * 이미 앞에서 걸러낸다.
 */
export function isIgnoredPath(filePath: string): boolean {
  if (!filePath) return false;

  const segments = normalizePath(filePath).split('/').filter(Boolean);

  if (segments.some((s) => IGNORED_DIRS.has(s))) return true;

  const base = segments[segments.length - 1];
  return base !== undefined && IGNORED_FILES.has(base);
}

/** 목록에서 제외 대상을 걷어낸다. 순서는 보존한다. */
export function filterTrackedPaths(paths: string[]): string[] {
  return paths.filter((p) => !isIgnoredPath(p));
}

/**
 * 걷어낸 것과 남은 것을 같이 돌려준다.
 *
 * ★ 왜 세는가 — 이 규칙의 근거는 「오염 520건이 전부 scratchpad 였다」는 **커버리지**
 * 실측이지 정밀도가 아니다. `scratchpad` 라는 디렉터리에 진짜 소스나 픽스처가 있는
 * 레포에서는 이 규칙이 틀린다. 그때 조용히 사라지면 아무도 모르므로, 몇 개를 왜
 * 버렸는지 볼 수 있게 남긴다. (2026-09-08 Astra 리뷰의 지적)
 */
export function partitionTrackedPaths(paths: string[]): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];

  for (const p of paths) {
    if (isIgnoredPath(p)) excluded.push(p);
    else kept.push(p);
  }

  return { kept, excluded };
}

/** 표시용 파일명. `path.basename` 이 Windows 경로를 못 자르는 POSIX 실행을 대비한다. */
export function displayName(filePath: string): string {
  const normalized = normalizePath(filePath);
  return path.posix.basename(normalized) || filePath;
}
