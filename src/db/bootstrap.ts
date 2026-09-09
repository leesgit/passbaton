/**
 * `sessions.db` 를 **처음 만드는 유일한 자리.**
 *
 * ★ 왜 별도 파일인가
 *   `migrate.ts` 의 첫 주석이 경고하듯 이 레포에는 sessions 테이블을 만드는 코드가 여러 군데
 *   있고 서로를 모른다. 거기에 「없으면 만든다」를 훅마다 하나씩 더 넣으면 같은 실수를
 *   반복하는 것이다. 생성은 여기 하나를 거치고, 스키마는 `migrateSchema` 하나를 거친다.
 *
 * ★ 왜 필요했나 (2026-09-09, relaydesk G3)
 *   훅 다섯 개가 전부 `if (!fs.existsSync(dbPath)) return` 으로 빠져나가는데 **만드는 훅이
 *   하나도 없었다.** DB 를 만드는 곳은 `database.ts` 뿐이고 그건 `.git` 을 모른다. 그래서
 *   `apps/` 없는 평범한 git 레포는 아무리 작업해도 기록이 남지 않았다 — 조용히.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { migrateSchema } from './migrate.js';
import { canBootstrapDb, type WorkspaceRoot } from '../utils/workspace.js';

export function dbPathFor(root: string): string {
  return path.join(root, '.claude', 'sessions.db');
}

export type BootstrapResult = 'exists' | 'created' | 'refused' | 'failed';

/**
 * 루트의 `sessions.db` 가 쓸 수 있는 상태가 되게 한다.
 *
 * - `exists`   이미 있었다
 * - `created`  이번에 만들었다
 * - `refused`  만들면 안 되는 루트다 (표식 없는 cwd, 임시 디렉터리)
 * - `failed`   만들려다 실패했다 (권한·디스크) — 호출부는 **DB 없이도 죽지 않아야 한다**
 *
 * ⛔ 실패를 던지지 않는다. 훅은 사용자의 세션 안에서 도는 물건이라, 기록이 안 되는 것보다
 *    세션을 깨뜨리는 쪽이 훨씬 나쁘다.
 */
export function ensureSessionsDb(resolved: WorkspaceRoot): BootstrapResult {
  const dbPath = dbPathFor(resolved.root);

  if (fs.existsSync(dbPath)) return 'exists';
  if (!canBootstrapDb(resolved)) return 'refused';

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      // 새 파일이므로 테이블부터 만들어진다. 컬럼 보강도 같은 함수가 한다.
      migrateSchema(db);
    } finally {
      db.close();
    }
    return 'created';
  } catch {
    // 반쯤 만들어진 파일이 남으면 다음 실행이 「이미 있음」으로 오판한다.
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {
      // 지우지도 못하면 그대로 둔다 — 여기서 더 할 수 있는 게 없다
    }
    return 'failed';
  }
}
