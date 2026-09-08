/**
 * 뒤늦게 추가된 컬럼을 기존 DB 에 보강한다. **스키마 변경의 유일한 정본이다.**
 *
 * ★ 왜 별도 파일인가 — 이 레포에는 sessions 테이블을 만드는 코드가 **네 군데**
 * 있고 서로를 모른다:
 *
 *     src/index.ts          MCP 서버. 자기 DB 를 직접 열고 자기 CREATE TABLE 을 갖는다
 *     src/db/database.ts    tools-v2 만 쓴다. 서버는 이 파일을 import 하지 않는다
 *     src/hooks/session-end.ts / post-tool-use.ts   훅은 둘 다 안 거치고 직접 연다
 *
 * 2026-09-08 에 `db/database.ts` 의 스키마 문자열에만 컬럼을 더했다가 서버에는
 * 아무 효과가 없다는 것을 실측으로 알았다. 한 군데 고치면 나머지 셋이 조용히
 * 어긋난다. 그래서 컬럼 추가는 전부 여기를 거친다.
 *
 * ★ 그리고 `CREATE TABLE IF NOT EXISTS` 로는 컬럼을 못 늘린다. 테이블이 이미 있으면
 * 통째로 건너뛰므로 **새 DB 에서만 생기고 기존 DB 에서는 조용히 없다.** 같은 날
 * 그 상태에서 뒤따르는 `CREATE INDEX` 가 `no such column: session_id` 로 던져
 * 서버가 기동조차 못 했다. 새 DB 로만 시험했다면 전부 초록이었을 것이다.
 */

interface MinimalDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): unknown;
}

/** 테이블별로 있어야 할 컬럼. SQLite 에는 `ADD COLUMN IF NOT EXISTS` 가 없다. */
const COLUMNS: Record<string, Record<string, string>> = {
  // 행은 「세션」이 아니라 「유저 턴」이다. 호스트가 주는 식별자를 담아 사후에
  // 세션·턴으로 묶을 수 있게 한다. 없으면 NULL(구버전 호스트).
  // user_intent: 요청은 결과가 아니므로 last_work 에 섞지 않고 여기 따로 둔다.
  // file_coverage: modified_files 가 **무엇을 봤고 무엇을 못 봤는지**. 목록만으로는
  // 「비어 있음」이 「안 고쳤다」인지 「안 봤다」인지 구분되지 않는다.
  sessions: { session_id: 'TEXT', prompt_id: 'TEXT', user_intent: 'TEXT', file_coverage: 'TEXT' },
  session_files: { prompt_id: 'TEXT' },
};

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sessions_turn ON sessions(project, session_id, prompt_id)',
];

/**
 * 없는 컬럼만 더하고, 그 뒤에 인덱스를 만든다.
 *
 * 던지는 것을 잡는 대신 현재 컬럼을 읽어서 비교한다 — `try/catch` 로 ALTER 를
 * 감싸면 진짜 오류(디스크 권한, 손상)까지 「이미 있음」으로 삼킨다.
 *
 * 아직 없는 테이블은 건드리지 않는다. 그것을 만드는 것은 각 호출부의 CREATE 이고,
 * 여기서 만들면 정의가 다섯 벌이 된다.
 */
export function migrateSchema(db: MinimalDb): void {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    let existing: string[];

    try {
      existing = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name);
    } catch {
      continue;
    }

    if (existing.length === 0) continue;   // 테이블 없음

    for (const [name, type] of Object.entries(columns)) {
      if (!existing.includes(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  }

  // 인덱스는 컬럼이 확보된 뒤에. 순서를 바꾸면 기존 DB 에서 던진다.
  for (const sql of INDEXES) {
    try {
      db.exec(sql);
    } catch {
      // 대상 테이블 자체가 없는 DB 도 있다(훅이 먼저 만든 부분 스키마).
    }
  }
}
