/**
 * 프로젝트가 선언하는 관측 범위.
 *
 * 두 가지를 선언한다. **둘 다 자동 탐색으로는 못 얻는 것들이다.**
 *
 * 1. `roots` — 셸로만 건드리는 워킹트리. 예: 모노레포 안의 별도 레포
 *    `apps/kenshi-fantasy`. 그 턴에 Edit/Write 도 없고 cwd 도 아니면 아무도
 *    등록하지 않는다.
 *
 *    ⛔ 「한 단계 아래 중첩 레포를 훑어서 발견」하는 방법은 **채택하지 않았다.**
 *    literal depth-1 은 `workspace/foo/.git` 을 찾지만 필요한 것은
 *    `workspace/apps/kenshi-fantasy/.git` 이라 깊이가 안 맞고, 깊이를 늘려도
 *    `%TEMP%` 의 워크트리에는 닿지 못하며, 세션 캐시는 세션 중 생긴 워크트리를
 *    놓치고, 디렉터리 깊이는 디렉터리 **개수**를 제한하지 못한다. git 이 아닌
 *    프로젝트도 여전히 미해결이다. 유지비만 들고 정작 중요한 경우를 못 잡는다.
 *    (2026-09-08 Astra 리뷰)
 *
 * 2. `artifacts` — git 이 무시하는데 인계에는 필요한 산출물. `git status` 는
 *    이것들을 애초에 내지 않는다.
 *
 *    ⛔ `git status --ignored` 로 통째로 열거하지 않는다. 그러면 매 Stop 마다
 *    의존성 캐시가 관측 대상이 된다.
 *
 * 경로는 전부 **워크스페이스 루트 기준 상대경로**다.
 *
 * ```json
 * {
 *   "workspace": {
 *     "roots": ["apps/kenshi-fantasy"],
 *     "artifacts": ["apps/kenshi-fantasy/artifacts/perf/*.json"]
 *   }
 * }
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';

/** 산출물 스캔이 방문할 디렉터리 항목 수 상한. **일치 개수 상한과 다르다** — */
/** 100만 개 중 3개가 일치해도 열거 비용은 100만 개어치다. */
const MAX_ENTRIES_VISITED = 5000;

/** 산출물로 돌려줄 최대 경로 수. */
const MAX_ARTIFACT_MATCHES = 100;

export interface WorkspaceDeclaration {
  roots: string[];
  artifacts: string[];
  /** 모양이 틀려 버린 항목. 조용히 무시하면 사용자는 선언이 먹은 줄 안다. */
  invalid: string[];
}

const EMPTY: WorkspaceDeclaration = { roots: [], artifacts: [], invalid: [] };

export function readWorkspaceDeclaration(workspaceRoot: string): WorkspaceDeclaration {
  const file = path.join(workspaceRoot, '.claude', 'passbaton.config.json');

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return EMPTY;
  }

  const ws = (raw as { workspace?: unknown })?.workspace;
  if (typeof ws !== 'object' || ws === null) return EMPTY;

  const out: WorkspaceDeclaration = { roots: [], artifacts: [], invalid: [] };

  for (const key of ['roots', 'artifacts'] as const) {
    const value = (ws as Record<string, unknown>)[key];
    if (value === undefined) continue;

    if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.trim() !== '')) {
      out.invalid.push(key);
      continue;
    }

    for (const entry of value as string[]) {
      // ⛔ 워크스페이스 밖으로 나가는 선언은 받지 않는다. 관측 범위가 사용자
      //    홈 전체로 새어 나가는 것을 막는다.
      const abs = path.resolve(workspaceRoot, entry);
      if (!abs.startsWith(path.resolve(workspaceRoot) + path.sep)) {
        out.invalid.push(entry);
        continue;
      }
      out[key].push(entry);
    }
  }

  return out;
}

export interface ArtifactScan {
  /** 창 안에 쓰인 산출물(절대). */
  written: string[];
  /** 패턴별 결과. 「없음」과 「못 봄」을 구분해야 한다. */
  results: Array<{ pattern: string; outcome: 'matched' | 'empty' | 'missing_dir' | 'truncated' | 'failed'; count: number }>;
  elapsedMs: number;
}

/**
 * 선언된 산출물 중 `sinceMs` 이후에 쓰인 것.
 *
 * ★ 지원하는 형태는 둘뿐이다 — **리터럴 경로**와 **한 디렉터리 안의 얕은 패턴**
 * (`dir/*.json`). 재귀 글롭은 지원하지 않는다. 경계가 있는 것만 받는 편이,
 * 경계 없는 워커를 만들고 상한으로 막으려 애쓰는 것보다 낫다.
 *
 * ★ 디렉터리 mtime 으로 대신하지 않는다. 디렉터리 mtime 은 항목 추가·삭제에만
 * 반응하고, 기존 파일이 덮어쓰이면 움직이지 않는다.
 *
 * ★ 매번 펼친다. 캐시하면 이번 턴에 새로 생긴 산출물을 놓친다.
 */
export function scanArtifacts(workspaceRoot: string, patterns: string[], sinceMs: number): ArtifactScan {
  const startedAt = Date.now();
  const written: string[] = [];
  const results: ArtifactScan['results'] = [];
  let visited = 0;

  const takeIfFresh = (abs: string): boolean => {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.mtimeMs < sinceMs) return false;
    } catch {
      return false;
    }
    if (written.length >= MAX_ARTIFACT_MATCHES) return false;
    written.push(abs);
    return true;
  };

  for (const pattern of patterns) {
    const abs = path.resolve(workspaceRoot, pattern);
    const star = pattern.indexOf('*');

    if (star < 0) {
      const hit = takeIfFresh(abs);
      results.push({ pattern, outcome: fs.existsSync(abs) ? (hit ? 'matched' : 'empty') : 'missing_dir', count: hit ? 1 : 0 });
      continue;
    }

    const dir = path.dirname(abs);
    const base = path.basename(abs);

    // `*.json` / `prefix*` / `*` 만. 디렉터리를 가로지르는 별표는 거부한다.
    if (base.indexOf('*') < 0 || path.basename(pattern).indexOf('*') < 0) {
      results.push({ pattern, outcome: 'failed', count: 0 });
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      results.push({ pattern, outcome: 'missing_dir', count: 0 });
      continue;
    }

    const [prefix, suffix] = splitOnce(base, '*');
    let count = 0;
    let truncated = false;

    for (const e of entries) {
      if (++visited > MAX_ENTRIES_VISITED) { truncated = true; break; }
      // ⛔ 심볼릭 링크/정션은 따라가지 않는다. 선언하지 않은 곳으로 새어 나간다.
      if (!e.isFile()) continue;
      if (!e.name.startsWith(prefix) || !e.name.endsWith(suffix)) continue;
      if (e.name.length < prefix.length + suffix.length) continue;
      if (takeIfFresh(path.join(dir, e.name))) count++;
      if (written.length >= MAX_ARTIFACT_MATCHES) { truncated = true; break; }
    }

    results.push({
      pattern,
      outcome: truncated ? 'truncated' : (count > 0 ? 'matched' : 'empty'),
      count,
    });
  }

  return { written, results, elapsedMs: Date.now() - startedAt };
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return [s.slice(0, i), s.slice(i + sep.length)];
}
