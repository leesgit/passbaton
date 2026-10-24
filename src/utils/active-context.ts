/**
 * active_context 칸별 쓰기 (2.8 · Astra reply-170 PB170-010 · C5).
 *
 * active_context 는 프로젝트당 한 행이고 칸마다 주인이 다르다:
 *   - current_state·state_source : Stop 훅 · MCP session_end · project_init
 *   - recent_files               : PostToolUse(Edit/Write) · Stop 훅 · MCP session_end
 *   - blockers                   : MCP session_end
 *   - last_verification          : MCP verify_build · verify_all
 * 2.7.3 까지는 쓰는 곳마다 **자기 칸만 적은 INSERT OR REPLACE** 였다. REPLACE 는 행을 지우고 새로 넣으므로
 * 적지 않은 칸이 전부 NULL 이 됐다 — Edit 한 번에 State·blockers·state_source·검증 기록이 사라지고,
 * 그 NULL 이 Stop 의 「State 가 있었나」(hadState) 판정을 거짓으로 만들어 증거 없는 턴 보호까지 무력화했다.
 *
 * ⛔ 계약:
 *   - 넘긴 칸만 바꾼다. 넘기지 않은 칸은 보존한다(ON CONFLICT DO UPDATE · 행을 지우지 않는다).
 *   - 명시적 비우기는 그대로 — 칸을 넘기고 값이 null 이면 NULL 로 적는다(COALESCE 로 막지 않는다).
 *   - state_source 는 current_state 와 한 쌍이다. State 글을 바꾸면서 출처를 넘기지 않으면 NULL(unknown) —
 *     앞 글의 출처가 새 글에 붙지 않게(summary-source.ts 「같은 행의 것만」).
 *   - updated_at 은 State 의 기록 시각으로 읽힌다(session-start 「recorded …」). 그래서 **current_state 를 쓸 때만**
 *     올린다 — recent_files·검증 기록만 바꾸는 쓰기가 오래된 State 를 최신처럼 보이게 하지 않는다. 새 행은 칸 기본값.
 *   - 테이블에 없는 칸(옛 DB 의 state_source)은 조용히 뺀다.
 */

import type Database from 'better-sqlite3';

export type ActiveContextColumn = 'current_state' | 'state_source' | 'active_tasks' | 'recent_files' | 'blockers' | 'last_verification';
export type ActiveContextFields = Partial<Record<ActiveContextColumn, string | null>>;

const COLUMNS: readonly ActiveContextColumn[] = ['current_state', 'state_source', 'active_tasks', 'recent_files', 'blockers', 'last_verification'];

export function writeActiveContext(db: Database.Database, project: string, fields: ActiveContextFields): void {
  const present = new Set((db.prepare('PRAGMA table_info(active_context)').all() as Array<{ name: string }>).map(c => c.name));
  const given: ActiveContextFields = { ...fields };
  if ('current_state' in given && !('state_source' in given)) given.state_source = null;
  const cols = COLUMNS.filter(c => c in given && present.has(c));
  if (cols.length === 0) return;
  const stamp = cols.includes('current_state');
  const names = ['project', ...cols, ...(stamp ? ['updated_at'] : [])].join(', ');
  const values = ['?', ...cols.map(() => '?'), ...(stamp ? ["datetime('now')"] : [])].join(', ');
  const sets = [...cols.map(c => `${c} = excluded.${c}`), ...(stamp ? ['updated_at = excluded.updated_at'] : [])].join(', ');
  db.prepare(`INSERT INTO active_context (${names}) VALUES (${values}) ON CONFLICT(project) DO UPDATE SET ${sets}`)
    .run(project, ...cols.map(c => given[c] ?? null));
}
