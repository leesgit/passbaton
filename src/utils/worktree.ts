/**
 * 「이 턴에 어떤 파일이 쓰였는가」를 워킹트리에서 직접 본다.
 *
 * ★ 왜 필요한가 — PostToolUse 는 `Edit`·`Write` 로만 등록돼 있어 셸이 고친 파일을
 * 하나도 못 본다. 실측(2026-09-08, 2일치 세션): 도구 호출 578건 중 Bash 397 +
 * PowerShell 87 이고 Edit·Write 는 73건뿐이며, 실제로 고친 소스 대부분이 python
 * heredoc 을 거쳤다. 셸 명령 문자열에서 경로를 뽑는 방법은 **실측 0/113** 으로
 * 죽었다(경로가 셸 변수이거나 스크립트 본문 안에 있다).
 *
 * ★ 그래서 명령이 아니라 **파일시스템**에 묻는다. 다만 스냅샷 내용 비교는 하지
 * 않는다 — 그건 비싸고(더러운 파일 64개 9.5MB 해싱 599ms), 우리가 알고 싶은 것도
 * 아니다. 알고 싶은 것은 「이 턴에 쓰였는가」이고 **mtime 이 그 직접 증거**다.
 * 워밍 후 `git status` 45ms + stat 2ms 면 끝난다.
 *
 * ⛔ 그러므로 결과의 이름은 **「이 에이전트가 고친 파일」이 아니다.**
 * 「이 워킹트리에서 이 턴 창 안에 쓰인 파일」이다. 다음 한계는 전부 참이고, 호출부는
 * 이것을 커버리지로 같이 기록해야 한다:
 *
 *   • **저작자를 모른다.** 같은 트리를 다른 에이전트·사용자·워처가 건드릴 수 있다
 *   • **git 이 무시하는 산출물은 안 보인다.** `git status` 가 애초에 안 낸다
 *   • **썼다가 되돌린 파일은 안 보인다.** 턴 끝에 깨끗하면 목록에 없다
 *   • **내용 동일한 재기록도 「쓰였다」로 나온다.** mtime 은 내용이 아니라 쓰기를 뜻한다
 *   • **git 워킹트리가 아니면 아무것도 못 본다.** 그때는 「검사 안 함」이지 「변경 없음」이 아니다
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { isIgnoredPath } from './paths.js';

/** 한 루트를 보는 데 허용하는 시간. 넘으면 그 루트는 「검사 실패」다. */
const GIT_TIMEOUT_MS = 5000;

/** 한 루트에서 보고할 최대 경로 수. 넘으면 잘렸다고 적는다. */
const MAX_PATHS_PER_ROOT = 200;

/** 한 세션에서 볼 최대 루트 수. 등록이 폭주해도 비용이 갇힌다. */
export const MAX_ROOTS = 8;

/**
 * 이 경로를 담고 있는 git 워킹트리의 루트.
 *
 * ★ `--show-toplevel` 을 쓴다. `.git` 을 손으로 거슬러 올라가면 **워크트리를
 * 놓친다** — 워크트리의 `.git` 은 디렉터리가 아니라 파일이고, 그 안의 gitdir 을
 * 따라가면 원본 저장소가 나와서 엉뚱한 루트를 얻는다. 멀티에이전트 실행이
 * `%TEMP%` 에 만드는 워크트리가 정확히 그 경우다.
 */
export function findWorktreeRoot(startPath: string): string | null {
  const dir = safeDirOf(startPath);
  if (!dir) return null;

  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });

  if (res.status !== 0 || !res.stdout) return null;

  const root = res.stdout.trim();
  return root ? path.resolve(root) : null;
}

function safeDirOf(p: string): string | null {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  } catch { /* 접근 불가 */ }

  const parent = path.dirname(p);
  try {
    return fs.existsSync(parent) ? parent : null;
  } catch {
    return null;
  }
}

export interface RootWrites {
  root: string;
  /** 이 창 안에 쓰인 경로(절대). */
  written: string[];
  /** 검사가 어디까지 갔는가. 빈 목록의 의미를 여기서 읽는다. */
  status: 'checked' | 'not_a_worktree' | 'failed' | 'truncated';
  /** 무시 규칙으로 뺀 개수. */
  excluded?: number;
  /** `git status` 가 낸 총 항목 수. */
  dirty?: number;
  elapsedMs: number;
  error?: string;
}

/**
 * 한 워킹트리에서 `sinceMs` 이후에 쓰인 파일.
 *
 * `git status` 로 후보를 좁히고(무시 규칙과 추적 상태를 git 이 대신 판단해 준다)
 * 그중 mtime 이 창 안에 드는 것만 남긴다. 전체 트리를 걷지 않는 이유이기도 하다 —
 * 걸으면 node_modules 와 빌드 산출물까지 들어온다.
 */
export function writesSince(root: string, sinceMs: number): RootWrites {
  const startedAt = Date.now();

  const res = spawnSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd: root, encoding: 'buffer', timeout: GIT_TIMEOUT_MS, windowsHide: true }
  );

  const elapsedMs = Date.now() - startedAt;

  if (res.error || res.status !== 0) {
    const message = res.error?.message
      ?? (res.stderr ? res.stderr.toString('utf-8').trim().slice(0, 200) : `exit ${res.status}`);
    // 워킹트리가 아닌 것과 진짜 실패는 다르다. 전자는 정상적인 「해당 없음」이다.
    const notRepo = /not a git repository/i.test(message);
    return { root, written: [], status: notRepo ? 'not_a_worktree' : 'failed', elapsedMs, error: message };
  }

  // porcelain=v1 -z: `XY <path>\0` 반복. 이름 변경은 --no-renames 로 껐으므로
  // 항목당 경로가 하나다(그렇지 않으면 `\0` 로 두 개가 붙어 파싱이 어긋난다).
  const entries = res.stdout.toString('utf-8').split('\0').filter(Boolean);

  const written: string[] = [];
  let excluded = 0;
  let truncated = false;

  for (const entry of entries) {
    if (entry.length < 4) continue;
    const rel = entry.slice(3);
    const abs = path.resolve(root, rel);

    if (isIgnoredPath(abs)) { excluded++; continue; }

    let mtimeMs: number;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;   // 삭제됐거나 디렉터리
      mtimeMs = st.mtimeMs;
    } catch {
      continue;                     // 삭제된 파일 — 쓰기 시각을 알 수 없다
    }

    if (mtimeMs < sinceMs) continue;

    if (written.length >= MAX_PATHS_PER_ROOT) { truncated = true; break; }
    written.push(abs);
  }

  return {
    root,
    written,
    status: truncated ? 'truncated' : 'checked',
    excluded: excluded > 0 ? excluded : undefined,
    dirty: entries.length,
    elapsedMs: Date.now() - startedAt,
  };
}
