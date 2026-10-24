#!/usr/bin/env node
/**
 * SessionStart Hook - 세션 시작 시 컨텍스트 자동 주입
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { logHookError, emitContext, isCodexHost, isGeminiHost } from '../utils/logger.js';
import { isEnabled } from '../utils/config.js';
import { trace, tpathOf } from '../utils/hook-trace.js';
import { resolveWorkspaceRoot } from '../utils/workspace.js';
import { ensureSessionsDb } from '../db/bootstrap.js';
import { revalidateDirective } from '../utils/directive.js';
import { buildResumeCard, clampCardChars } from '../utils/resume-card.js';
import { readTailLines, matchCompaction } from '../utils/compact-id.js';
import { readRunOrigin } from '../utils/run-origin.js';
import { viaLabel } from '../utils/summary-source.js';
import { readRoutingDeclaration, releaseCommand, routedBlock, currentRoute, routeClearedBlock, isWorkspaceRootCwd } from '../utils/routing.js';

interface SessionInput {
  cwd?: string;
  // 실제 훅 페이로드는 snake_case 다. camelCase `sessionId` 는 항상 undefined 였다
  // (PreCompact 이 같은 실수로 핸드오버가 死코드였다 — audit-7 2026-08-10).
  session_id?: string;
  transcript_path?: string;
  // P0-1 (2026-08-10): PreCompact의 systemMessage는 사용자 표시용이라 모델에 도달하지
  //   않는다(공식 hook 문서 확인). 컴팩션 직후 재시작은 source='compact'로 오므로,
  //   이때는 PreCompact가 저장해 둔 복구 상태임을 명시해 주입한다.
  source?: string;
}

// 2.6.0: 프로젝트 이름과 **그 폴더**를 같이 돌려준다 — 재개 카드 선언은 그 폴더에서 읽는다.
//   (전에는 apps/ 밖 하위 프로젝트에 워크스페이스 루트의 카드가 붙을 수 있었다)
function getProject(cwd: string, workspaceRoot: string): { name: string; dir: string } | null {
  const appsDir = path.join(workspaceRoot, 'apps');

  // apps/ 하위인지 확인
  if (cwd.startsWith(appsDir + path.sep)) {
    const relative = path.relative(appsDir, cwd);
    const name = relative.split(path.sep)[0];
    return { name, dir: path.join(appsDir, name) };
  }

  // apps/ 외부 하위 프로젝트 (hackathons/ 등) - package.json에서 이름 추출
  if (cwd !== workspaceRoot) {
    let current = cwd;
    while (current !== workspaceRoot && current !== path.parse(current).root) {
      const pkgPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return { name: pkg.name || path.basename(current), dir: current };
        } catch {
          return { name: path.basename(current), dir: current };
        }
      }
      current = path.dirname(current);
    }
  }

  // 워크스페이스 루트 (모노레포 포함) → 폴더명 반환
  return { name: path.basename(workspaceRoot), dir: workspaceRoot };
}

function cleanupNoiseMemories(db: InstanceType<typeof Database>): void {
  try {
    // 3일+ auto-tracked 관찰 메모리 삭제
    db.prepare(`
      DELETE FROM memories
      WHERE memory_type = 'observation'
        AND tags LIKE '%auto-tracked%'
        AND created_at < datetime('now', '-3 days')
    `).run();

    // 2.6.0: 그 이전 판이 decision/7 로 넣은 정규식 조각을 격리한다(지우지 않는다).
    //   memory_search 로는 계속 보이고, 태그로 이유를 남긴다. 한 번 바뀌면 다시 안 걸린다.
    //   ★ 원래 태그·종류·중요도는 지우지 않는다 — 태그는 덧붙이고, 원래 값은 metadata.quarantine 에.
    //   사람이 승격하려면: `unverified` 태그를 떼고 metadata.quarantine 의 from_type·from_importance 로
    //   되돌린다. quarantined-2.6 태그는 남긴다 — 그래야 다시 격리되지 않고 주입 필터를 통과한다.
    db.prepare(`
      UPDATE memories
      SET metadata = json_set(
            CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
            '$.quarantine', json_object('reason', 'regex-extracted (2.6.0)', 'from_type', memory_type, 'from_importance', importance)),
          tags = CASE WHEN json_valid(tags) AND json_type(tags) = 'array'
                      THEN json_insert(json_insert(tags, '$[#]', 'unverified'), '$[#]', 'quarantined-2.6')
                      ELSE '["auto-extracted","unverified","quarantined-2.6"]' END,
          memory_type = 'observation',
          importance = MIN(importance, 2)
      WHERE memory_type = 'decision'
        AND COALESCE(tags, '') LIKE '%auto-extracted%'
        AND COALESCE(tags, '') NOT LIKE '%"commit"%'
        AND COALESCE(tags, '') NOT LIKE '%quarantined-2.6%'
    `).run();

    // 14일+ auto-compact 패턴 메모리 삭제
    db.prepare(`
      DELETE FROM memories
      WHERE tags LIKE '%auto-compact%'
        AND created_at < datetime('now', '-14 days')
    `).run();
  } catch { /* ignore */ }
}

// 토큰 예산 시스템 (컨텍스트 무한 증가 방지)
const MAX_CONTEXT_TOKENS = parseInt(process.env.MCP_CONTEXT_BUDGET || '2000', 10);
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // 대략적 추정 (한글은 1.5~2배)
}

// 재개 카드에 쓸 최대 글자 수. 토큰 예산(2000)과 같은 예산에서 나간다.
const CARD_CHARS = clampCardChars(process.env.PASSBATON_CARD_CHARS, 3200);

/**
 * State 줄에 쓸 기록을 고른다 (2.7.3 · Astra reply-156 PB156-100).
 *
 * 저장 구조: State 의 원천은 `active_context`(프로젝트당 한 행 · **출처 칸 없음**)다. Stop 훅·MCP session_end 는
 * 같은 요약을 `sessions.last_work` 에도 적으므로, 연결은 「같은 프로젝트·같은 글」 의 sessions 행으로만 한다.
 *
 * ⛔ 계약:
 *   - 현재 출처가 loop 면 기존 동작 그대로(active_context · 표시 없음).
 *   - 대화 카드: active_context 가 확인된 loop 행과 연결되면 쓰지 않는다. 그 대신 **loop 를 뺀 최신 적격 sessions 행
 *     하나**에서 글·시각·출처를 모두 가져온다(행을 섞지 않는다 · 다른 행의 Blocker 도 붙이지 않는다).
 *     적격 = Recent 와 같은 글 거름 + Stop 이 State 를 덮는 규칙(이번 턴에 일한 증거)과 같은 기준.
 *   - 적격 기록이 없으면 「none」 — loop 상태로 대체하지 않는다.
 *   - 연결할 수 없는 active_context(다른 도구가 적은 것·옛 DB)는 대화 출처로 추정하지 않는다 → origin unknown 으로 표시.
 *   - unknown 도 적격이다 — 그래서 「마지막 대화 상태」 라고 부르지 않는다.
 *   - 2.7.3 (reply-165 PB165-200): 요약의 생성 출처(via)는 **고른 기록 그 행의 칸**에서만 — active_context 면 state_source,
 *     대체 sessions 행이면 그 행의 summary_source. 칸이 없거나 NULL 이면 via unknown(글 모양으로 추정하지 않는다).
 */
type PickedState = { text: string; blockers: string | null; meta: string | null; via: string | null };
function selectState(db: Database.Database, project: string, thisOrigin: 'loop' | 'unknown'): PickedState | null {
  const activeCols = new Set((db.prepare('PRAGMA table_info(active_context)').all() as Array<{ name: string }>).map(c => c.name));
  const active = db.prepare(`SELECT current_state, blockers, updated_at${activeCols.has('state_source') ? ', state_source' : ''} FROM active_context WHERE project = ?`).get(project) as
    { current_state: string | null; blockers: string | null; updated_at: string | null; state_source?: string | null } | undefined;
  if (!active?.current_state) return null;
  const via = viaLabel(active.state_source);
  if (thisOrigin === 'loop') return { text: active.current_state, blockers: active.blockers, meta: null, via };

  const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name));
  const when = (t: string | null | undefined) => (t ? `recorded ${t.slice(0, 16)} (DB time)` : 'recorded ?');
  if (!cols.has('run_origin')) {
    // 2.7.2 까지의 DB — 출처를 확인할 수 없다(loop 로 확인된 행이 없다)
    return { text: active.current_state, blockers: active.blockers, meta: `${when(active.updated_at)} · origin unknown`, via };
  }
  const linked = db.prepare('SELECT run_origin FROM sessions WHERE project = ? AND last_work = ?')
    .all(project, active.current_state) as Array<{ run_origin: string | null }>;
  if (!linked.some(r => r.run_origin === 'loop')) {
    const how = linked.length > 0 ? 'origin unknown' : 'origin unknown · not linked to a session record';
    return { text: active.current_state, blockers: active.blockers, meta: `${when(active.updated_at)} · ${how}`, via };
  }

  // 확인된 loop 기록 → 버린다. loop 를 뺀 최신 적격 행 하나.
  const hasEvidence = ['file_coverage', 'workspace_writes', 'modified_files'].every(c => cols.has(c));
  const hasSource = cols.has('summary_source');
  const rows = db.prepare(`
    SELECT last_work, issues, timestamp${hasEvidence ? ', file_coverage, workspace_writes, modified_files' : ''}${hasSource ? ', summary_source' : ''} FROM sessions
    WHERE project = ?
      AND COALESCE(run_origin, 'unknown') != 'loop'
      AND last_work NOT IN ('Session ended', 'Session work completed', 'Session started', '')
      AND length(last_work) > 15
    ORDER BY timestamp DESC, id DESC LIMIT 200
  `).all(project) as Array<{ last_work: string; issues: string | null; timestamp: string | null;
    file_coverage?: string | null; workspace_writes?: string | null; modified_files?: string | null; summary_source?: string | null }>;
  const parse = <T>(raw: string | null | undefined, fallback: T): T => {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  };
  // Stop 훅(session-end)의 workedThisTurn 과 같은 기준. 커버리지가 없는 행(MCP session_end·옛 훅)은 State 를 늘 덮었다.
  const worked = (r: typeof rows[number]) => {
    if (!r.file_coverage) return true;
    const ws = parse<Array<{ written?: string[]; committed?: string[] }>>(r.workspace_writes, []);
    if (ws.some(w => (w.written?.length ?? 0) > 0 || (w.committed?.length ?? 0) > 0)) return true;
    const cov = parse<{ source?: string } | null>(r.file_coverage, null);
    return cov?.source === 'turn_scoped' && parse<string[]>(r.modified_files, []).length > 0;
  };
  const row = rows.find(worked);
  if (!row) {
    return { text: 'none', blockers: null, meta: 'no eligible record — the last recorded state is from a loop run, and loop records are excluded from this card', via: null };
  }
  // MCP session_end 는 blockers 를 issues 에 글 그대로 적는다(훅 행은 JSON 메타). 같은 행의 것만 붙인다.
  const blockers = row.issues && row.issues.trim() !== '' && parse<unknown>(row.issues, undefined) === undefined ? row.issues : null;
  return { text: row.last_work, blockers, meta: `${when(row.timestamp)} · origin unknown · newer loop records excluded`, via: viaLabel(row.summary_source) };
}

function loadContext(dbPath: string, project: string, source?: string, projectPath?: string, sessionId?: string, transcriptPath?: string, hookCwd?: string): string | null {
  // 재개 카드는 DB 가 없어도 낸다 — 정본은 레포에 있다.
  // 2.7.3 (PB154-C): 출처가 loop 이고 프로젝트 설정이 loopCard: "minimal" 일 때만 최소 카드(그 판단은 카드 쪽이 한다)
  const card = projectPath ? buildResumeCard(projectPath, CARD_CHARS, { origin: readRunOrigin() }) : null;
  if (!fs.existsSync(dbPath)) {
    return card ? `# ${project} - Session Resumed\n\n${card.text}` : null;
  }

  // dbPath is "<workspaceRoot>/.claude/sessions.db" → strip two levels for feature-flag lookups.
  const workspaceRoot = path.dirname(path.dirname(dbPath));

  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // 다중 hook 프로세스 동시성 보장

    // 노이즈 메모리 자동 정리
    cleanupNoiseMemories(db);

    const lines: string[] = [`# ${project} - Session Resumed\n`];
    let tokenBudget = MAX_CONTEXT_TOKENS;

    // [Priority 0] 재개 카드 — 레포 정본 발췌. 있으면 아래 DB 요약은 보조다.
    if (card) {
      lines.push(card.text, '');
      tokenBudget -= estimateTokens(card.text);
    }

    // [Priority 0b] 2.7 (PB139-12): 이 세션이 루트에서 고른 하위 프로젝트 — 컴팩션·재개 뒤에도 선택을 잇는다.
    //   새 세션(startup)은 선택이 없다(세션별). 설정에서 사라진 선택은 내지 않는다.
    //   ★ 루트 판별은 UserPromptSubmit 과 같은 규칙(실제 cwd ↔ 루트 실제 경로 · reply-147 ①).
    if (sessionId && (source === 'compact' || source === 'resume') && isWorkspaceRootCwd(hookCwd, workspaceRoot)) {
      try {
        const row = db.prepare('SELECT command, target_rel, target_name FROM session_route WHERE session_id = ? AND project = ?')
          .get(sessionId, project) as { command: string; target_rel: string; target_name: string } | undefined;
        if (row) {
          const decl = readRoutingDeclaration(workspaceRoot);
          const t = decl.commands.size > 0 ? currentRoute(decl, row.command, row.target_rel) : null;
          if (!t) {
            // 골랐던 매핑이 사라졌다 — 한 번 알리고 지운다(UPS 와 같은 처리)
            db.prepare('DELETE FROM session_route WHERE session_id = ? AND project = ?').run(sessionId, project);
            lines.push(routeClearedBlock(row.command, row.target_name, project,
              decl.disabled ?? (decl.commands.size === 0 ? 'routing is no longer declared' : `${row.command} no longer maps to ${row.target_rel}`)));
          } else {
            const block = routedBlock(row.command, t, project, releaseCommand(decl), CARD_CHARS);
            const cost = estimateTokens(block.text);
            if (tokenBudget > cost) {
              lines.push(block.text);
              tokenBudget -= cost;
              db.prepare("UPDATE session_route SET card_hash = ?, updated_at = datetime('now') WHERE session_id = ? AND project = ?").run(block.hash, sessionId, project);
            } else {
              // ⛔ 예산이 모자라 못 냈다 — 컴팩션으로 앞 카드는 사라졌으니 옛 해시로 다음 턴까지 억제하면 안 된다(reply-147 ⑤)
              db.prepare("UPDATE session_route SET card_hash = NULL, updated_at = datetime('now') WHERE session_id = ? AND project = ?").run(sessionId, project);
            }
          }
        }
      } catch { /* 표가 아직 없는 DB */ }
    }

    // [Priority 1a] 컴팩션 직후 — 같은 세션의 PreCompact 가 남긴 「마지막 사람 요청」.
    //   ⛔ 2.6.1: 요청은 결과가 아니다. 2.6.0 까지는 PreCompact 가 요청 줄로 current_state 를
    //   덮고 여기서 「Recovered」 라고 불렀다 — 하네스 알림이 그대로 「하던 일」 이 됐다.
    //   ★ 읽는 쪽 계약(reply-142 PB142-01): **이번 컴팩션의 행만** — PreCompact 가 적은 pre_uuid 뒤에
    //   대화가 이어졌으면 지난 컴팩션의 행이다(PreCompact 의 쓰기·지우기가 잠금으로 실패해 남은 것).
    //   판정할 근거(트랜스크립트·pre_uuid)가 없으면 내지 않는다. 시각·소비에 기대지 않으므로
    //   같은 컴팩션에서 다시 불려도 같은 복구가 나오고, 컴팩션이 오래 걸려도 버리지 않는다(PB142-02).
    if (source === 'compact' && sessionId) {
      try {
        const h = db.prepare('SELECT request, pending, active_file, pre_uuid FROM compact_handover WHERE session_id = ? AND project = ?')
          .get(sessionId, project) as { request: string | null; pending: number; active_file: string | null; pre_uuid: string | null } | undefined;
        const current = !!h && matchCompaction(readTailLines(transcriptPath), h.pre_uuid) === 'current';
        if (h && current && (h.request || h.active_file)) {
          const bits = ['♻️ **Recovered after compaction**'];
          if (h.request) bits.push(`- Last human request (a request, not a result${h.pending ? ' · no reply yet' : ''}): ${h.request}`);
          if (h.active_file) bits.push(`- Active file: ${h.active_file}`);
          const block = bits.join('\n');
          // 카드 다음 자리다. 카드가 예산을 다 먹었으면 넣지 않는다 — 예산을 넘기지 않는 것이 먼저
          const cost = estimateTokens(block);
          if (tokenBudget > cost) {
            lines.push(block, '');
            tokenBudget -= cost;
          }
        }
      } catch { /* 테이블이 아직 없는 DB */ }
    }

    // [Priority 1] 현재 상태
    // 2.7.3 (reply-156 PB156-100): 대화 카드(현재 출처 ≠ loop)는 확인된 loop 기록을 State 로 쓰지 않는다 — selectState 참고.
    const picked = selectState(db, project, readRunOrigin());
    if (picked) {
      // 카드가 있으면 State 는 「마지막으로 기록된 것」일 뿐이다 — 정본은 카드 쪽이다.
      // 컴팩션 직후라도 이 값은 마지막 Stop 이 적은 것이지 컴팩션이 만든 것이 아니다(2.6.1).
      const stateLabel = card?.anyRead ? '📍 **Last recorded state** (DB · may be stale — the resume card above wins)'
        : source === 'compact' ? '📍 **Last recorded state** (DB · from the last Stop, not from this compaction)'
        : '📍 **State**';
      // 2.7.3 (PB165-200): 생성 출처를 맨 앞에 — 「assistant 가 그렇게 말했다」 가 검증 결과처럼 읽히지 않게
      const tail = [picked.via, picked.meta].filter(Boolean).join(' · ');
      const stateBlock = `${stateLabel}: ${picked.text}${tail ? ` _(${tail})_` : ''}` + (picked.blockers ? `\n🚧 **Blocker**: ${picked.blockers}` : '');
      const cost = estimateTokens(stateBlock);
      if (tokenBudget > cost) {
        lines.push(stateBlock);
        lines.push('');
        tokenBudget -= cost;
      }
    }


/**
 * 한 세션 기록의 파일 증거를 렌더링한다.
 *
 * ★ 두 집합을 **합치지 않고 근거를 표시한다.** 겹침은 「같은 경로에 대한 관측이
 * 둘」이라는 뜻이지 「내가 고쳤다」가 아니다 — Edit/Write 호출 이후에 다른 쪽이
 * 덮어썼을 수도 있다. 차집합도 「도구를 안 거쳤다」를 정확히 뜻하지는 않는다:
 * 수집 실패·미지원 편집 도구·경로 불일치·턴 귀속 오류도 같은 차이를 만든다.
 *
 *   [E,M]  Edit/Write 관측 + 파일시스템 표본
 *   [M]    파일시스템 표본만  ← 이 기능이 존재하는 이유. 절대 잘라내지 않는다
 *   [E]    도구 관측만        ← 커밋·되돌림·삭제로 표본에 안 잡힌 것들
 *
 * ★ 아무것도 없을 때 「변경 없음」이라고 쓰지 않는다. 「검사한 범위에서 해당
 * 관측 없음」이다. 둘은 다른 말이다.
 */
function renderFileEvidence(row: {
  modified_files?: string | null;
  workspace_writes?: string | null;
  file_coverage?: string | null;
}, maxPaths: number): string[] {
  const parse = <T>(raw: string | null | undefined, fallback: T): T => {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  };

  const edited = parse<string[]>(row.modified_files, []);
  const groups = parse<Array<{ root: string; written: string[]; committed?: string[] }>>(row.workspace_writes, []);
  const coverage = parse<{ workspace?: { boundary?: string; scope?: string; roots?: number; checked?: number; uncovered?: string[]; declared?: number; valid?: number; declStatus?: string } } | null>(row.file_coverage, null);

  const key = (p: string) => p.split(String.fromCharCode(92)).join('/').toLowerCase();
  const sampled = new Set<string>();
  for (const g of groups) {
    for (const p of g.written) sampled.add(key(p));
    for (const p of g.committed ?? []) sampled.add(key(p));
  }
  const editedKeys = new Set(edited.map(key));

  // (경로, 마커) — 루트별로 묶어 내되, 경로는 한 번만 낸다.
  const byRoot = new Map<string, Array<{ p: string; mark: string }>>();
  const push = (root: string, p: string, mark: string) => {
    const list = byRoot.get(root) ?? [];
    if (!list.some(e => key(e.p) === key(p))) list.push({ p, mark });
    byRoot.set(root, list);
  };

  for (const g of groups) {
    for (const p of [...g.written, ...(g.committed ?? [])]) {
      push(g.root, p, editedKeys.has(key(p)) ? 'E,M' : 'M');
    }
  }
  for (const p of edited) {
    if (sampled.has(key(p))) continue;
    const root = groups.find(g => key(p).startsWith(key(g.root) + '/'))?.root ?? '';
    push(root, p, 'E');
  }

  const ws = coverage?.workspace;
  const out: string[] = [];

  // 2.7 (PB139-11): 확인 범위 뒤에 **선언 수와 못 본 이유**를 붙인다 — 「0/0 roots」 만으로는
  //   「볼 곳이 없었다」 인지 「기준선이 없어 못 봤다」 인지 모른다.
  //   reply-147: 선언(declared)·유효(valid)·관측(checked/roots)을 가른다. 못 읽은 선언은 숫자 대신 상태로.
  const declText = (w: NonNullable<typeof ws>) =>
    w.declStatus ? `root declaration ${w.declStatus}`
      : w.declared === undefined ? ''
      : w.valid !== undefined ? `declared ${w.declared} (valid ${w.valid})` : `declared ${w.declared}`;
  const why = (w: NonNullable<typeof ws>) => [
    declText(w),
    w.uncovered?.length ? `skipped: ${w.uncovered.slice(0, 2).join('; ')}` : '',
  ].filter(Boolean).join(', ');

  if (byRoot.size === 0) {
    out.push(ws
      ? `  files: no qualifying observations within checked scope (${ws.checked ?? 0}/${ws.roots ?? 0} roots, boundary=${ws.boundary ?? '?'}${why(ws) ? `, ${why(ws)}` : ''})`
      : '  files: not recorded');
    return out;
  }

  // 커버리지를 **파일 바로 앞에** 둔다. 목록의 부재와 포함을 해석하는 근거다.
  if (ws) {
    const bits = [`boundary=${ws.boundary ?? '?'}`, `${ws.checked ?? 0}/${ws.roots ?? 0} roots`];
    if (why(ws)) bits.push(why(ws));
    out.push(`  coverage: ${bits.join(', ')} (${ws.scope ?? 'registered roots only'})`);
  }
  out.push('  files [E=edit/write, M=filesystem sample] — state and authorship unverified:');

  // ★ 잘라야 하면 항목을 통째로 버린다. 경로를 반토막 내지 않는다.
  //   그리고 M 만 있는 것을 먼저 낸다 — 그게 이 기능의 기여분이다.
  const order = { M: 0, 'E,M': 1, E: 2 } as Record<string, number>;
  const flat = [...byRoot.entries()].flatMap(([root, list]) =>
    list.map(e => ({ root, ...e }))
  ).sort((a, b) => (order[a.mark] ?? 3) - (order[b.mark] ?? 3));

  const shown = flat.slice(0, maxPaths);
  let currentRoot: string | null = null;

  for (const e of shown) {
    if (e.root !== currentRoot) {
      currentRoot = e.root;
      if (e.root) out.push(`  ${e.root}:`);
    }
    const rel = e.root && key(e.p).startsWith(key(e.root) + '/') ? e.p.slice(e.root.length + 1) : e.p;
    out.push(`    ${rel} [${e.mark}]`);
  }

  if (flat.length > shown.length) {
    out.push(`    … ${flat.length - shown.length} more observed path(s) not listed`);
  }

  return out;
}

    // [Priority 2] 최근 3개 세션 (빈 세션 skip)
    // 새 컬럼이 없는 구스키마 DB 에서도 돌아야 한다.
    const sessionCols = new Set(
      (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name)
    );
    const hasEvidence = ['user_intent', 'workspace_writes', 'file_coverage', 'modified_files']
      .every(c => sessionCols.has(c));
    const extraCols = hasEvidence
      ? ', user_intent, modified_files, workspace_writes, file_coverage'
      : '';
    const hasSummarySource = sessionCols.has('summary_source');

    // 2.7.3 (reply-154 PB154-B): 대화 카드에서는 **확인된 loop 행만** 뺀다 — 출처 필터를 먼저(WHERE) 걸고 LIMIT 3.
    //   ⛔ 먼저 3 개를 뽑고 빼면 최신 loop 행이 슬롯을 먹어 대화 칸이 빈다. 행은 지우지 않는다(노출만 바꾼다).
    //   현재 세션이 loop 면 기존 동작 그대로. unknown(옛 행 포함)은 남기되 표시한다 — 과거 랄프 잡음이 사라졌다고 하지 않는다.
    const thisOrigin = readRunOrigin();
    const hasOrigin = sessionCols.has('run_origin');
    const hideLoop = thisOrigin !== 'loop' && hasOrigin;
    const markUnknown = thisOrigin !== 'loop';
    const recentSessions = db.prepare(`
      SELECT last_work, next_tasks, issues, timestamp${extraCols}${hasOrigin ? ', run_origin' : ''}${hasSummarySource ? ', summary_source' : ''} FROM sessions
      WHERE project = ?
        ${hideLoop ? "AND COALESCE(run_origin, 'unknown') != 'loop'" : ''}
        AND last_work != 'Session ended'
        AND last_work != 'Session work completed'
        AND last_work != 'Session started'
        AND last_work != ''
        AND length(last_work) > 15
      ORDER BY timestamp DESC LIMIT 3
    `).all(project) as Array<{
      last_work: string; next_tasks: string; issues: string; timestamp: string;
      user_intent?: string | null; modified_files?: string | null;
      workspace_writes?: string | null; file_coverage?: string | null;
      run_origin?: string | null; summary_source?: string | null;
    }>;

    // 2.7.3 (PB154-C): loop 최소 카드면 Recent Sessions 를 싣지 않는다(행은 그대로 · 노출만)
    if (recentSessions.length > 0 && tokenBudget > 100 && !card?.minimal) {
      const sessionLines: string[] = ['## Recent Sessions'];
      for (const [i, session] of recentSessions.entries()) {
        // P1-3 (2026-08-10): 60자는 문장 중간을 잘라 요약이 무의미했다(실측 최근30일 326/376 절단, AVG 121.9자).
        // 140자로 확대 — 예산 초과 시 이 블록은 통째로 skip되는 구조라 오버플로 위험 없음.
        const work = session.last_work.length > 140 ? session.last_work.slice(0, 140) + '...' : session.last_work;
        const tag = markUnknown && session.run_origin !== 'loop' ? ' [origin unknown]' : '';
        // 2.7.3 (PB165-200): 그 행의 생성 출처 — 칸이 없는 옛 DB·NULL 은 via unknown
        sessionLines.push(`- [${session.timestamp?.slice(0, 10) || '?'}]${tag} ${work} _(${viaLabel(session.summary_source)})_`);

        // ★ 상세(요청 → 한 일 → 커버리지 → 파일)는 **가장 최근 한 건에만** 붙인다.
        //   셋 다 붙이면 예산을 파일 목록이 다 먹고 정작 지시사항이 잘린다.
        //   순서는 「무엇을 하려 했나 → 무엇을 했나 → 어디까지 봤나 → 어떤 파일」이다.
        if (i === 0 && hasEvidence) {
          if (session.user_intent) {
            const intent = session.user_intent.length > 120
              ? session.user_intent.slice(0, 120) + '...' : session.user_intent;
            sessionLines.push(`  intent: ${intent}`);
          }
          sessionLines.push(...renderFileEvidence(session, 12));
        }

        if (session.issues) {
          try {
            const meta = JSON.parse(session.issues);
            if (meta.commits?.length > 0) {
              sessionLines.push(`  commits: ${meta.commits.slice(0, 2).join('; ').slice(0, 80)}`);
            }
          } catch { /* skip */ }
        }
      }
      const cost = estimateTokens(sessionLines.join('\n'));
      if (tokenBudget > cost) {
        lines.push(...sessionLines, '');
        tokenBudget -= cost;
      }
    }

    // [Priority 3] 사용자 지시사항 (가장 중요 - 예산 부족해도 high priority는 포함)
    try {
      const directives = (db.prepare(`
        SELECT directive, priority, context FROM user_directives
        WHERE project = ?
        ORDER BY CASE priority WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
                 created_at DESC
        LIMIT 200
      `).all(project) as Array<{ directive: string; priority: string; context: string | null }>)
        // 저장 뒤에 규칙이 강화됐을 수 있다 — 이미 DB 에 있는 행도 지금 규칙(출처 + 문장)으로 다시 본다.
        // 앞쪽 행이 전부 무효여도 뒤의 유효 지시가 밀려나지 않게 넉넉히 읽고 거른 뒤 자른다.
        .map(d => ({ ...d, directive: revalidateDirective(d.directive, d.context) ?? '' }))
        .filter((d, i, all) => d.directive && all.findIndex(x => x.directive === d.directive) === i)
        .slice(0, 5);

      if (directives.length > 0) {
        const directiveLines = ['## Directives'];
        for (const d of directives) {
          const icon = d.priority === 'high' ? '🔴' : '📎';
          directiveLines.push(`- ${icon} ${d.directive}`);
        }
        const cost = estimateTokens(directiveLines.join('\n'));
        // 지시사항은 예산 초과해도 high priority는 포함
        const highOnly = directives.filter(d => d.priority === 'high');
        if (tokenBudget > cost) {
          lines.push(...directiveLines, '');
          tokenBudget -= cost;
        } else if (highOnly.length > 0) {
          const criticalLines = ['## Directives'];
          for (const d of highOnly) criticalLines.push(`- 🔴 ${d.directive}`);
          lines.push(...criticalLines, '');
          tokenBudget -= estimateTokens(criticalLines.join('\n'));
        }
      }
    } catch { /* table may not exist yet */ }

    // [Priority 4] 미완료 태스크
    if (tokenBudget > 50) {
      try {
        const tasks = db.prepare(`
          SELECT title, priority, status FROM tasks
          WHERE project = ? AND status IN ('pending', 'in_progress')
          ORDER BY priority DESC LIMIT 5
        `).all(project) as Array<{ title: string; priority: number; status: string }>;

        if (tasks.length > 0) {
          const taskLines = ['## Pending Tasks'];
          for (const t of tasks) {
            const icon = t.status === 'in_progress' ? '🔄' : '⏳';
            taskLines.push(`- ${icon} [P${t.priority}] ${t.title}`);
          }
          const cost = estimateTokens(taskLines.join('\n'));
          if (tokenBudget > cost) {
            lines.push(...taskLines, '');
            tokenBudget -= cost;
          }
        }
      } catch { /* table may not exist */ }
    }

    // [Priority 5] 중요 메모리 (temporal decay 적용, 예산 내에서)
    // P0 (2026-05-22): reference/observation 타입 + global(project=NULL) 메모리 포함
    //   사용자 pain: "서버 주소 기억할 때도 있고 못할 때도 있다"
    //   원인: SessionStart가 reference 타입 미포함 + project filter가 NULL 거름
    if (tokenBudget > 80) try {
      const memories = db.prepare(`
        SELECT content, memory_type, importance, created_at, access_count FROM memories
        -- 2.6.0: 전역(project NULL) 기억은 reference·preference 만. 실 DB 의 전역 10 개는
        --   「TypeScript 는 …」 「Redis 는 …」 같은 일반 상식(시험 시드)이었고 모든 프로젝트의
        --   Key Memories 5 칸을 다 차지했다. 서버 주소 같은 인프라 정보(reference)는 그대로 온다.
        WHERE (project = ? OR (project IS NULL AND memory_type IN ('reference', 'preference')))
          AND memory_type IN ('decision', 'learning', 'error', 'preference', 'reference', 'observation')
          AND importance >= 3
          AND (tags NOT LIKE '%auto-tracked%' OR tags IS NULL)
          AND (tags NOT LIKE '%auto-compact%' OR tags IS NULL)
          -- 2.6.0: 정규식 후보(unverified)와 그 이전 판의 자동 추출 「결정」 은 주입하지 않는다
          AND COALESCE(tags, '') NOT LIKE '%unverified%'
          -- ⚠ tags 가 NULL 이면 NOT(TRUE AND NULL) = NULL 이라 사람이 넣은 decision 이 빠졌다 — COALESCE 필수
          -- 격리됐다가 사람이 되살린 것(quarantined-2.6 은 남고 unverified 는 뗀 것)은 주입한다
          AND NOT (memory_type = 'decision' AND COALESCE(tags, '') LIKE '%auto-extracted%'
                   AND COALESCE(tags, '') NOT LIKE '%quarantined-2.6%')
        ORDER BY importance DESC, accessed_at DESC LIMIT 30
      `).all(project) as Array<{ content: string; memory_type: string; importance: number; created_at: string; access_count: number }>;

      if (memories.length > 0) {
        // Decay 적용 후 top 5 선택 (reference는 decay 거의 0 — 인프라 정보는 영구)
        const DECAY_RATES: Record<string, number> = {
          decision: 0.001, learning: 0.003, error: 0.01, preference: 0.002,
          reference: 0.0001, observation: 0.005
        };
        const scored = memories.map(m => {
          const ageDays = (Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24);
          const decayRate = DECAY_RATES[m.memory_type] ?? 0.005;
          const score = m.importance * Math.exp(-decayRate * ageDays) * Math.log2(m.access_count + 2);
          return { ...m, score };
        }).sort((a, b) => b.score - a.score).slice(0, 5);

        const typeIcons: Record<string, string> = {
          decision: '🎯', learning: '📚', error: '⚠️', preference: '💡',
          reference: '🔧', observation: '👁'
        };
        const memoryLines = ['## Key Memories'];
        for (const m of scored) {
          const icon = typeIcons[m.memory_type] || '💭';
          const content = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
          memoryLines.push(`- ${icon} ${content}`);
        }
        const cost = estimateTokens(memoryLines.join('\n'));
        if (tokenBudget > cost) {
          lines.push(...memoryLines, '');
          tokenBudget -= cost;
        }
      }
    } catch { /* ignore */ }

    // [Priority 5.5] Verification ledger — warn if a recent session ended with a red build
    // or left issues open. Continuity of BUILD STATE, not just memory. (verificationLedger)
    try {
      if (isEnabled('verificationLedger', workspaceRoot) && tokenBudget > 15) {
        const recent = db.prepare(
          `SELECT verification_result, issues, datetime(timestamp,'localtime') AS ts
           FROM sessions WHERE project = ?
           ORDER BY timestamp DESC LIMIT 3`
        ).all(project) as Array<{ verification_result: string | null; issues: string | null; ts: string }>;
        const redRe = /fail|error|❌|red|broken/i;
        const bad = recent.find(r =>
          (r.verification_result && redRe.test(r.verification_result)) ||
          (r.issues && r.issues.trim() !== '' && r.issues.trim() !== '[]')
        );
        if (bad) {
          const why = bad.verification_result && redRe.test(bad.verification_result)
            ? 'the build was failing'
            : 'issues were left open';
          // 2.7.3 (reply-156 PB156-100): 출처로 거르지 않는다 — 세션 출처와 검증 결과의 유효성은 별개다.
          //   카드에 「프로젝트 공용 검증 기록」 임을 밝힌다(대상·시점·결과는 그대로).
          const warn = `\n⚠️ **Heads up** (project-wide verification record — sessions of every origin, loop runs included): a recent session (${bad.ts}) ended with ${why}. Check before building on top.`;
          lines.push(warn);
          tokenBudget -= estimateTokens(warn);
        }
      }
    } catch { /* sessions table shape may vary */ }

    // [Priority 5.6] Hot-path pre-warm — surface the files you most often touch in THIS
    // project, ranked by real access_count. hot_paths is written on every tool use but was
    // never read back until now. (hotPathPrewarm)
    try {
      if (isEnabled('hotPathPrewarm', workspaceRoot) && tokenBudget > 20) {
        const hot = db.prepare(
          `SELECT file_path, access_count FROM hot_paths
           WHERE project = ? ORDER BY access_count DESC LIMIT 5`
        ).all(project) as Array<{ file_path: string; access_count: number }>;
        if (hot.length > 0) {
          // Windows 경로(역슬래시)도 파일명만 — 전에는 전체 절대 경로가 그대로 나갔다.
        const files = hot.map(h => `${h.file_path.split(/[\\/]/).pop()} (${h.access_count}×)`).join(', ');
          const hotLine = `\n**Hot files** (you edit these most here): ${files}`;
          lines.push(hotLine);
          tokenBudget -= estimateTokens(hotLine);
        }
      }
    } catch { /* hot_paths table may not exist */ }

    // [Priority 6] 솔루션 통계 (1줄, 저비용)
    try {
      const solCount = (db.prepare(
        'SELECT COUNT(*) as cnt FROM solutions WHERE project = ?'
      ).get(project) as { cnt: number })?.cnt || 0;
      if (solCount > 0) {
        const solLine = `\nSolutions: ${solCount} recorded (auto-injected on error)\n`;
        if (tokenBudget > 10) {
          lines.push(solLine);
          tokenBudget -= estimateTokens(solLine);
        }
      }
    } catch { /* solutions table may not exist */ }

    db.close();

    lines.push('---');
    lines.push('_Auto-injected by session-continuity v2. Use `session_end` when done._');

    return lines.join('\n');
  } catch (e) {
    return null;
  }
}

async function main() {
  try {
    // stdin에서 입력 읽기
    let inputData = '';
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    const input: SessionInput = inputData ? JSON.parse(inputData) : {};
    const cwd = input.cwd || process.cwd();

    const resolvedRoot = resolveWorkspaceRoot(cwd);
    const workspaceRoot = resolvedRoot.root;
    const found = getProject(cwd, workspaceRoot);
    const project = found?.name ?? null;

    // 조기 반환과 loadContext **앞**에서 찍는다. 뒤에 두면 「발화 안 함」과
    // 「발화했으나 도중에 죽음」이 로그상 같아진다.
    trace('session-start', workspaceRoot, {
      project,
      tpath: tpathOf(input.transcript_path),
      source: input.source,
      cwd,
    });

    if (!project) {
      process.exit(0);
    }

    // 여기서 만든다 — 세션 **시작**에 만들어야 이번 세션의 나머지 훅도 전부 기록된다.
    // session-end 에서만 만들면 첫 세션은 마지막 한 줄만 남는다.
    ensureSessionsDb(resolvedRoot);

    const dbPath = path.join(workspaceRoot, '.claude', 'sessions.db');
    const context = loadContext(dbPath, project, input.source, found?.dir, input.session_id, input.transcript_path, input.cwd);

    // 주입 결과는 별도 줄. injected 는 **문자 수**다 (토큰 아님 — 예산은 2000 토큰이고
    // 한글은 문자당 토큰이 더 든다. 대략 len/4 보다 나쁘다).
    trace('session-start:injected', workspaceRoot, {
      project,
      tpath: tpathOf(input.transcript_path),
      injected_chars: context ? context.length : 0,
    });

    if (context) {
      emitContext(`\n<session-context project="${project}">\n${context}\n</session-context>\n`, 'SessionStart', input.transcript_path);
    } else {
      // Only Claude gets the plain "no context" placeholder; Codex and Gemini
      // expect JSON-only stdout, so a stray console.log would corrupt their parsing.
      if (!isCodexHost(input.transcript_path) && !isGeminiHost(input.transcript_path)) {
        console.log(`\n[Session] Project: ${project} (no context yet)\n`);
      }
    }

    process.exit(0);
  } catch (e) {
    logHookError('session-start', e);
    process.exit(0);
  }
}

main();
