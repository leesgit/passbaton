#!/usr/bin/env node
/**
 * PreCompact Hook v2 - 컨텍스트 압축 전 구조화된 HANDOVER 생성
 *
 * 컴팩션 전에 대화 내용을 분석해 구조화된 컨텍스트를 systemMessage로 반환합니다.
 * v1과 달리 memories 테이블에 저장하지 않습니다 (노이즈 방지).
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { isEnabled } from '../utils/config.js';
import { detectWorkspaceRoot } from '../utils/workspace.js';
import { revalidateDirective } from '../utils/directive.js';
import { migrateSchema } from '../db/migrate.js';
import { readTailLines } from '../utils/compact-id.js';
import { snapshotHandover } from '../utils/handover.js';

interface CompactInput {
  cwd?: string;
  // P0-2 (2026-08-10): 실제 hook 페이로드는 snake_case이고 인라인 transcript 배열을
  //   주지 않는다(JSONL 파일 경로를 준다). camelCase `sessionId` + `transcript` 배열을
  //   기대하던 기존 정의 탓에 handover가 항상 null이었고, 그 결과 아래
  //   active_context 저장까지 한 번도 실행되지 않았다.
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
}


function getDbPath(cwd: string): string {
  const workspaceRoot = detectWorkspaceRoot(cwd);
  const claudeDir = path.join(workspaceRoot, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  return path.join(claudeDir, 'sessions.db');
}

function detectProject(cwd: string): string {
  const workspaceRoot = detectWorkspaceRoot(cwd);
  const appsDir = path.join(workspaceRoot, 'apps');

  if (cwd.startsWith(appsDir + path.sep)) {
    const relative = path.relative(appsDir, cwd);
    return relative.split(path.sep)[0];
  }

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

  return path.basename(workspaceRoot);
}

/**
 * Playwright 캐시 정리 - 오래된 스냅샷/로그 제거 (20MB 컨텍스트 초과 방지)
 */
function cleanPlaywrightCache(cwd: string) {
  const playwrightDir = path.join(cwd, '.playwright-mcp');
  if (!fs.existsSync(playwrightDir)) return;

  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000; // 30분 이상 된 파일 정리
  const MAX_DIR_SIZE = 5 * 1024 * 1024; // 5MB 초과 시 정리

  try {
    const files = fs.readdirSync(playwrightDir);
    let totalSize = 0;
    const fileInfos: { name: string; mtime: number; size: number }[] = [];

    for (const file of files) {
      const filePath = path.join(playwrightDir, file);
      const stat = fs.statSync(filePath);
      totalSize += stat.size;
      fileInfos.push({ name: file, mtime: stat.mtimeMs, size: stat.size });
    }

    if (totalSize < MAX_DIR_SIZE) return; // 5MB 미만이면 정리 불필요

    // 오래된 파일부터 삭제
    fileInfos.sort((a, b) => a.mtime - b.mtime);
    for (const fi of fileInfos) {
      if (now - fi.mtime > MAX_AGE) {
        fs.unlinkSync(path.join(playwrightDir, fi.name));
        totalSize -= fi.size;
      }
      if (totalSize < MAX_DIR_SIZE) break;
    }
  } catch { /* ignore */ }

  // 루트의 오래된 스크린샷 PNG/JPEG도 정리
  try {
    const rootFiles = fs.readdirSync(cwd);
    for (const file of rootFiles) {
      if (!/\.(png|jpeg|jpg)$/i.test(file)) continue;
      const filePath = path.join(cwd, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_AGE) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* ignore */ }
}

async function main() {
  let cwdForErrorLog = process.cwd();
  try {
    let inputData = '';
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    const input: CompactInput = inputData ? JSON.parse(inputData) : {};
    const cwd = input.cwd || process.cwd();
    cwdForErrorLog = cwd;

    // Playwright 캐시 정리 (20MB 컨텍스트 초과 방지)
    cleanPlaywrightCache(cwd);
    const project = detectProject(cwd);
    const dbPath = getDbPath(cwd);

    // 디버그 로그 (DB 없어도 발화 자체는 기록)
    const debugLogPath = path.join(path.dirname(dbPath), 'pre-compact-debug.log');
    // 트랜스크립트는 **한 번만** 읽는다 — 요청 내용과 pre_uuid 가 같은 스냅샷이어야 한다(PB143-01)
    const snap = snapshotHandover(readTailLines(input.transcript_path), [cwd, path.dirname(path.dirname(dbPath))]);
    const transcriptLen = snap.messages.length;
    const sid = input.session_id?.slice(0, 8) || 'none';

    if (!fs.existsSync(dbPath)) {
      try {
        fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] project=${project} sid=${sid} transcript_msgs=${transcriptLen} status=no_db\n`);
      } catch { /* ignore */ }
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // 다중 hook 프로세스 동시성 보장

    // 핸드오버 컨텍스트 빌드 — 텍스트 파일 후보는 cwd·워크스페이스 기준으로 실제 파일만
    const handover = snap.handover;

    // ⛔ 2.6.1: active_context.current_state 를 **덮지 않는다.** 여기서 가진 것은 요청뿐이고
    //   일한 증거가 없다 — 2.6.0 의 session-end 가 「이번 턴 일한 증거」 가 있을 때만 덮도록
    //   고친 원칙이 여기엔 없어서, 하네스 알림 한 줄이 State 가 됐다(2026-10-22).
    //   요청은 세션별 compact_handover 에 따로 두고, 같은 세션의 SessionStart(compact) 가
    //   「요청이지 결과가 아님」 으로 표시한다.
    // ★ 행은 **이번 컴팩션의 것만** 남는다. 이번 창에 사람 요청·파일이 없거나(요약·알림뿐)
    //   transcript 를 못 읽었으면 지난 컴팩션의 행을 지운다 — 안 그러면 같은 세션의 두 번째
    //   컴팩션 뒤에 첫 번째의 요청·pending 이 최신처럼 다시 나온다(Astra reply-140 PB140-02).
    //   보관 정책: 컴팩션 전용 행 · 이 컴팩션 직전의 마지막 트랜스크립트 uuid(pre_uuid)를 같이 적는다.
    //   여기서 쓰기·지우기가 잠금으로 둘 다 실패해도 지난 행이 이번 복구로 나오지 않게 하는 것은
    //   **읽는 쪽 계약**이다 — SessionStart(compact) 는 pre_uuid 뒤에 대화가 이어졌으면 내지 않는다
    //   (utils/compact-id.ts · reply-142 PB142-01). 14 일 지난 행은 저장할 때 정리한다.
    //   (일반 resume 의 복구 경로가 아니다)
    if (input.session_id) {
      const forget = () => db.prepare('DELETE FROM compact_handover WHERE session_id = ? AND project = ?')
        .run(input.session_id, project);
      try {
        migrateSchema(db);
        if (handover && (handover.request || handover.activeFile)) {
          db.prepare(`
            INSERT INTO compact_handover (session_id, project, request, pending, active_file, created_at, pre_uuid)
            VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
            ON CONFLICT(session_id, project) DO UPDATE SET
              request = excluded.request, pending = excluded.pending,
              active_file = excluded.active_file, created_at = excluded.created_at,
              pre_uuid = excluded.pre_uuid
          `).run(input.session_id, project, handover.request, handover.pending ? 1 : 0, handover.activeFile,
            snap.preUuid);
        } else {
          forget();
        }
        db.prepare("DELETE FROM compact_handover WHERE created_at < datetime('now', '-14 days')").run();
      } catch {
        // 잠금 등 — 새 행을 못 썼으면 옛 행도 남기지 않는다(복구 줄이 없는 편이 낡은 줄보다 낫다)
        try { forget(); } catch { /* 테이블도 없다 */ }
      }
    }

    // === 컨텍스트 재주입: systemMessage로 반환 ===
    const recoveryLines: string[] = [`# ${project} - Compact Recovery\n`];

    // 사용자 지시사항
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
        .slice(0, 10);

      if (directives.length > 0) {
        recoveryLines.push('## DIRECTIVES (MUST FOLLOW)');
        for (const d of directives) {
          const prefix = d.priority === 'high' ? '🔴 CRITICAL' : '📎';
          recoveryLines.push(`- ${prefix}: ${d.directive}`);
        }
        recoveryLines.push('');
      }
    } catch { /* table may not exist */ }

    // 기술 스택
    const fixed = db.prepare('SELECT tech_stack FROM project_context WHERE project = ?').get(project) as { tech_stack: string } | undefined;
    if (fixed?.tech_stack) {
      try {
        const stack = JSON.parse(fixed.tech_stack);
        recoveryLines.push(`**Stack**: ${Object.entries(stack).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      } catch { /* ignore */ }
    }

    // 현재 상태
    const active = db.prepare('SELECT current_state, blockers FROM active_context WHERE project = ?').get(project) as { current_state: string; blockers: string } | undefined;
    if (active?.current_state) {
      recoveryLines.push(`**State**: ${active.current_state}`);
      if (active.blockers) recoveryLines.push(`**Blocker**: ${active.blockers}`);
    }

    // 핸드오버 컨텍스트
    if (handover) {
      recoveryLines.push(`\n## Handover`);
      if (handover.request) recoveryLines.push(`**Last human request** (a request, not a result${handover.pending ? ' · no reply yet' : ''}): ${handover.request}`);
      if (handover.activeFile) recoveryLines.push(`**Active file**: ${handover.activeFile}`);
      if (handover.keyFacts.length > 0) {
        recoveryLines.push('**Key facts**:');
        handover.keyFacts.forEach(f => recoveryLines.push(`- ${f}`));
      }
      if (handover.recentErrors.length > 0) {
        recoveryLines.push('**Recent errors**:');
        handover.recentErrors.forEach(e => recoveryLines.push(`- ${e}`));
      }
    }

    // Compaction handover+ : the post-compaction agent loses the in-session thread, so
    // carry over the two things it most needs and can't reconstruct — which files were hot
    // this session, and whether the build was green. auto-memory does NOT cover this gap.
    // dbPath is "<workspaceRoot>/.claude/sessions.db" → strip two levels.
    const workspaceRoot = path.dirname(path.dirname(dbPath));
    if (isEnabled('compactionHandover', workspaceRoot)) {
      try {
        const hot = db.prepare(
          `SELECT file_path, access_count FROM hot_paths
           WHERE project = ? ORDER BY access_count DESC LIMIT 5`
        ).all(project) as Array<{ file_path: string; access_count: number }>;
        if (hot.length > 0) {
          recoveryLines.push(`**Hot files**: ${hot.map(h => h.file_path.split('/').pop()).join(', ')}`);
        }
      } catch { /* hot_paths may not exist */ }

      try {
        const last = db.prepare(
          `SELECT verification_result FROM sessions WHERE project = ?
           ORDER BY timestamp DESC LIMIT 1`
        ).get(project) as { verification_result: string | null } | undefined;
        if (last?.verification_result) {
          const red = /fail|error|❌|red|broken/i.test(last.verification_result);
          recoveryLines.push(`**Build state (last session)**: ${red ? '🔴 was failing — verify before continuing' : '🟢 green'}`);
        }
      } catch { /* sessions shape may vary */ }
    }

    db.close();

    // P0-1 (2026-08-10): systemMessage는 사용자에게 보여주는 경고 필드일 뿐 모델
    //   컨텍스트에 들어가지 않는다(공식 hook 문서: "Warning message shown to the user").
    //   PreCompact는 additionalContext도 지원하지 않으므로 여기서 재주입은 불가능하다.
    //   → 복구 컨텍스트는 위에서 active_context에 저장하고, 실제 주입은 컴팩션 직후
    //     SessionStart(source='compact')가 담당한다. 여기서는 사람이 읽을 알림만 남긴다.
    const recoveryText = recoveryLines.join('\n');
    const systemMessage = `♻️ passbaton: 컴팩션 복구 컨텍스트 저장됨 (${recoveryText.split('\n').length}줄). 다음 세션 시작 시 자동 주입됩니다.`;

    // 디버그 로그 (성공 케이스)
    try {
      const factsCount = handover?.keyFacts.length || 0;
      const errsCount = handover?.recentErrors.length || 0;
      fs.appendFileSync(
        debugLogPath,
        `[${new Date().toISOString()}] project=${project} sid=${sid} transcript_msgs=${transcriptLen} recovery_len=${recoveryText.length} saved=${handover?.request ? 'yes' : 'no'} active_file=${handover?.activeFile || 'none'} pending=${handover?.pending ? 'yes' : 'no'} facts=${factsCount} errs=${errsCount} status=ok\n`
      );
    } catch { /* ignore */ }

    const output = {
      continue: true,
      systemMessage
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch (e) {
    // fail-soft: 컴팩션이 멈추지 않도록 continue:true 반드시 반환
    try {
      const dbPath = getDbPath(cwdForErrorLog);
      const debugLogPath = path.join(path.dirname(dbPath), 'pre-compact-debug.log');
      const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] status=error err=${errMsg.slice(0, 200)}\n`);
    } catch { /* ignore */ }
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

main();
