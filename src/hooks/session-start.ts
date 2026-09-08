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
import { detectWorkspaceRoot } from '../utils/workspace.js';

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

function getProject(cwd: string, workspaceRoot: string): string | null {
  const appsDir = path.join(workspaceRoot, 'apps');

  // apps/ 하위인지 확인
  if (cwd.startsWith(appsDir + path.sep)) {
    const relative = path.relative(appsDir, cwd);
    return relative.split(path.sep)[0];
  }

  // apps/ 외부 하위 프로젝트 (hackathons/ 등) - package.json에서 이름 추출
  if (cwd !== workspaceRoot) {
    let current = cwd;
    while (current !== workspaceRoot && current !== path.parse(current).root) {
      const pkgPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return pkg.name || path.basename(current);
        } catch {
          return path.basename(current);
        }
      }
      current = path.dirname(current);
    }
  }

  // 워크스페이스 루트 (모노레포 포함) → 폴더명 반환
  return path.basename(workspaceRoot);
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

function loadContext(dbPath: string, project: string, source?: string): string | null {
  if (!fs.existsSync(dbPath)) return null;

  // dbPath is "<workspaceRoot>/.claude/sessions.db" → strip two levels for feature-flag lookups.
  const workspaceRoot = path.dirname(path.dirname(dbPath));

  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // 다중 hook 프로세스 동시성 보장

    // 노이즈 메모리 자동 정리
    cleanupNoiseMemories(db);

    const lines: string[] = [`# ${project} - Session Resumed\n`];
    let tokenBudget = MAX_CONTEXT_TOKENS;

    // [Priority 1] 현재 상태
    const active = db.prepare('SELECT current_state, blockers FROM active_context WHERE project = ?').get(project) as { current_state: string; blockers: string } | undefined;
    if (active?.current_state) {
      // P0-1: 컴팩션 직후 재시작이면 PreCompact가 저장한 복구 상태임을 밝힌다.
      const stateLabel = source === 'compact' ? '♻️ **Recovered after compaction**' : '📍 **State**';
      const stateBlock = `${stateLabel}: ${active.current_state}` + (active.blockers ? `\n🚧 **Blocker**: ${active.blockers}` : '');
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
  const coverage = parse<{ workspace?: { boundary?: string; scope?: string; roots?: number; checked?: number; uncovered?: string[] } } | null>(row.file_coverage, null);

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

  if (byRoot.size === 0) {
    out.push(ws
      ? `  files: no qualifying observations within checked scope (${ws.checked ?? 0}/${ws.roots ?? 0} roots, boundary=${ws.boundary ?? '?'})`
      : '  files: not recorded');
    return out;
  }

  // 커버리지를 **파일 바로 앞에** 둔다. 목록의 부재와 포함을 해석하는 근거다.
  if (ws) {
    const bits = [`boundary=${ws.boundary ?? '?'}`, `${ws.checked ?? 0}/${ws.roots ?? 0} roots`];
    if (ws.uncovered?.length) bits.push(`skipped: ${ws.uncovered.slice(0, 2).join('; ')}`);
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

    const recentSessions = db.prepare(`
      SELECT last_work, next_tasks, issues, timestamp${extraCols} FROM sessions
      WHERE project = ?
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
    }>;

    if (recentSessions.length > 0 && tokenBudget > 100) {
      const sessionLines: string[] = ['## Recent Sessions'];
      for (const [i, session] of recentSessions.entries()) {
        // P1-3 (2026-08-10): 60자는 문장 중간을 잘라 요약이 무의미했다(실측 최근30일 326/376 절단, AVG 121.9자).
        // 140자로 확대 — 예산 초과 시 이 블록은 통째로 skip되는 구조라 오버플로 위험 없음.
        const work = session.last_work.length > 140 ? session.last_work.slice(0, 140) + '...' : session.last_work;
        sessionLines.push(`- [${session.timestamp?.slice(0, 10) || '?'}] ${work}`);

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
      const directives = db.prepare(`
        SELECT directive, priority FROM user_directives
        WHERE project = ?
        ORDER BY CASE priority WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
                 created_at DESC
        LIMIT 5
      `).all(project) as Array<{ directive: string; priority: string }>;

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
        WHERE (project = ? OR project IS NULL)
          AND memory_type IN ('decision', 'learning', 'error', 'preference', 'reference', 'observation')
          AND importance >= 3
          AND (tags NOT LIKE '%auto-tracked%' OR tags IS NULL)
          AND (tags NOT LIKE '%auto-compact%' OR tags IS NULL)
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
          const warn = `\n⚠️ **Heads up**: a recent session (${bad.ts}) ended with ${why}. Check before building on top.`;
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
          const files = hot.map(h => `${h.file_path.split('/').pop()} (${h.access_count}×)`).join(', ');
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

    const workspaceRoot = detectWorkspaceRoot(cwd);
    const project = getProject(cwd, workspaceRoot);

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

    const dbPath = path.join(workspaceRoot, '.claude', 'sessions.db');
    const context = loadContext(dbPath, project, input.source);

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
