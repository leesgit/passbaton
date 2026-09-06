import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 워크스페이스 루트 탐지 — 5개 훅 공용.
 *
 * 우선순위:
 *   1. WORKSPACE_ROOT 환경변수 (서버 쪽 src/db/database.ts 와 동일한 규칙)
 *   2. `apps/` 를 가진 가장 가까운 상위 = 모노레포 루트 — **레포 경계를 넘어서 찾는다**
 *   3. `.claude/sessions.db` 를 가진 가장 가까운 상위 — **레포 경계 안에서만**
 *   4. 레포 루트(.git 을 가진 가장 가까운 상위), 없으면 cwd
 *
 * 어느 순회도 홈 디렉터리를 넘지 않는다.
 *
 * ── 왜 이렇게 비대칭인가 (2026-09-07 감사 실측) ─────────────────────────
 *
 * ★ 2 가 3 보다 먼저, 그리고 별도 순회인 이유
 *   예전 구현은 한 순회에서 두 조건을 레벨마다 번갈아 봤다. 그래서
 *   `apps/<app>/.claude/sessions.db` 가 하나라도 있으면 모노레포 루트에 닿기 전에
 *   거기서 멈췄다. hero-maker 는 그 빈 파일(테이블 0개) 때문에 훅이 265번
 *   발화하고 세션 행이 0건이었다. 훅은 테이블을 만들지 않으므로 INSERT 가
 *   실패하고 fail-soft 로 조용히 넘어간다.
 *
 * ★ 2 는 레포 경계를 넘고 3 은 안 넘는 이유
 *   `apps/kenshi-fantasy` 는 모노레포 안에 있으면서 **자체 git 레포**다. 2 까지
 *   .git 에서 멈추게 하면 그 프로젝트가 모노레포 루트 DB 에서 떨어져 나간다
 *   (실측 450세션). 반대로 3 은 경계를 넘으면 안 된다 — `GitHub/.claude/sessions.db`
 *   같은 상위의 고아 DB 가 형제 프로젝트를 빨아들여, 실제로 프로젝트명이
 *   `GitHub`·`scea4`(윈도우 사용자명)로 기록된 행들이 남았다.
 *
 * ★ 홈 가드에 path.resolve 를 쓰는 이유
 *   `os.homedir()` 는 `C:\Users\x`(역슬래시)를 주는데 cwd 는 슬래시로 들어올 수
 *   있다. 문자열 비교로는 가드가 조용히 통과한다 — 실사용 확인에서 잡혔다.
 */
/**
 * cwd 부터 위로 올라가며 후보 디렉터리를 모은다.
 * **홈 디렉터리와 파일시스템 루트는 후보로 올리지 않는다** — cwd 자체일 때만 예외.
 * `~/.claude/sessions.db` 는 프로젝트 루트가 아니라 탐지 실패가 쌓인 결과물이다.
 */
function candidateDirs(start: string): string[] {
  const fsRoot = path.parse(start).root;
  const home = path.resolve(os.homedir());
  const dirs = [start];

  for (let current = start; ; ) {
    const parent = path.dirname(current);
    if (parent === current || parent === home || parent === fsRoot) break;
    dirs.push(parent);
    current = parent;
  }

  return dirs;
}

export function detectWorkspaceRoot(cwd: string): string {
  if (process.env.WORKSPACE_ROOT) {
    return process.env.WORKSPACE_ROOT;
  }

  const start = path.resolve(cwd);
  const dirs = candidateDirs(start);

  // 레포 경계 — .git 을 가진 가장 가까운 디렉터리
  const repoRoot = dirs.find((d) => fs.existsSync(path.join(d, '.git'))) ?? null;

  // 2. 모노레포 루트 — 경계를 넘어서 찾는다 (자체 레포인 앱을 떼어내지 않기 위해)
  const monorepo = dirs.find((d) => fs.existsSync(path.join(d, 'apps')));
  if (monorepo) return monorepo;

  // 3. sessions.db — 레포 경계 안에서만 (상위 고아 DB 로 새지 않기 위해)
  for (const d of dirs) {
    if (fs.existsSync(path.join(d, '.claude', 'sessions.db'))) return d;
    if (d === repoRoot) break;
  }

  return repoRoot ?? start;
}
