#!/usr/bin/env node
/**
 * PostToolUse Hook - 파일 변경 시 자동 기록
 *
 * Edit, Write 도구 사용 후 변경 사항을 메모리에 기록합니다.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { logHookError } from '../utils/logger.js';
import { detectWorkspaceRoot } from '../utils/workspace.js';
import { trace, tpathOf } from '../utils/hook-trace.js';
import { isIgnoredPath } from '../utils/paths.js';

interface ToolUseInput {
  cwd?: string;
  // 실제 훅 페이로드는 snake_case 다 (camelCase 는 항상 undefined).
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
  };
  tool_result?: string;
  transcript_path?: string;
}

// ===== Playwright 캐시 정리 (20MB 컨텍스트 초과 방지) =====

function cleanPlaywrightCache(cwd: string) {
  const MAX_TOTAL = 3 * 1024 * 1024; // 3MB 초과 시 정리
  const MAX_FILES = 20; // 최대 파일 수

  // .playwright-mcp/ 정리
  const playwrightDir = path.join(cwd, '.playwright-mcp');
  if (fs.existsSync(playwrightDir)) {
    try {
      const files = fs.readdirSync(playwrightDir)
        .map(f => ({ name: f, path: path.join(playwrightDir, f), stat: fs.statSync(path.join(playwrightDir, f)) }))
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

      let totalSize = files.reduce((sum, f) => sum + f.stat.size, 0);

      // 오래된 파일부터 삭제 (최근 5개만 유지)
      while (files.length > 5 || totalSize > MAX_TOTAL) {
        const oldest = files.shift();
        if (!oldest) break;
        try { fs.unlinkSync(oldest.path); totalSize -= oldest.stat.size; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // 루트의 스크린샷 파일 정리 (최근 3개만 유지)
  try {
    const screenshots = fs.readdirSync(cwd)
      .filter(f => /\.(png|jpeg|jpg)$/i.test(f))
      .map(f => ({ name: f, path: path.join(cwd, f), stat: fs.statSync(path.join(cwd, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); // 최신순

    for (let i = 3; i < screenshots.length; i++) {
      try { fs.unlinkSync(screenshots[i].path); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ===== 에러 감지 → 솔루션 자동 주입 =====

const ERROR_PATTERNS = [
  /(?:error|Error|ERROR)\s*[:\[]/,
  /(?:FAILED|FAIL|failed)\s/,
  /(?:Cannot find|Module not found|No such file)/,
  /(?:Permission denied|EACCES|EPERM)/,
  /(?:command not found|ENOENT)/,
  /exit code [1-9]/,
  /(?:TypeError|SyntaxError|ReferenceError|RangeError)\s*:/,
  /(?:FATAL|panic|segfault)/i,
];

function extractErrorSignature(output: string): string | null {
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 10) continue;
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(trimmed)) {
        // 에러 라인에서 시그니처 추출 (파일 경로/라인번호 제거, 핵심만)
        return trimmed
          .replace(/\s+at\s+.+$/, '')  // stack trace 제거
          .replace(/\(.*?\)/g, '')      // 경로 괄호 제거
          .slice(0, 80)
          .trim();
      }
    }
  }
  return null;
}

function searchSolutions(db: InstanceType<typeof Database>, project: string, errorSig: string): Array<{
  error_signature: string;
  solution: string;
  project: string;
  created_at: string;
}> {
  try {
    // 에러 키워드 추출 (3글자 이상 단어)
    const keywords = errorSig.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    if (keywords.length === 0) return [];

    const likeConditions = keywords.map(() => 'error_signature LIKE ?').join(' OR ');
    const likeParams = keywords.map(k => `%${k}%`);

    return db.prepare(`
      SELECT error_signature, solution, project, created_at
      FROM solutions
      WHERE (${likeConditions})
      ORDER BY
        CASE WHEN project = ? THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 2
    `).all(...likeParams, project) as Array<{
      error_signature: string;
      solution: string;
      project: string;
      created_at: string;
    }>;
  } catch {
    return [];
  }
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

  // apps/ 하위인지 확인
  if (cwd.startsWith(appsDir + path.sep)) {
    const relative = path.relative(appsDir, cwd);
    return relative.split(path.sep)[0];
  }

  // apps/ 외부 하위 프로젝트 (hackathons/ 등)
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

  // 워크스페이스 루트 → 폴더명 반환
  return path.basename(workspaceRoot);
}

function getFileExtension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function categorizeChange(toolName: string, filePath: string, oldString?: string, newString?: string): {
  changeType: string;
  summary: string;
} {
  const ext = getFileExtension(filePath);
  const fileName = path.basename(filePath);

  // 파일 타입별 분류
  const isConfig = ['json', 'yaml', 'yml', 'toml', 'env'].includes(ext) || fileName.includes('config');
  const isTest = filePath.includes('test') || filePath.includes('spec');
  const isStyle = ['css', 'scss', 'less', 'styled'].some(s => filePath.includes(s));
  const isComponent = ['tsx', 'jsx', 'vue', 'svelte'].includes(ext);

  let changeType = 'code';
  if (isConfig) changeType = 'config';
  else if (isTest) changeType = 'test';
  else if (isStyle) changeType = 'style';
  else if (isComponent) changeType = 'component';

  // 변경 요약 생성
  let summary = '';
  if (toolName === 'Write') {
    summary = `Created ${fileName}`;
  } else if (toolName === 'Edit') {
    if (oldString && newString) {
      const added = newString.split('\n').length;
      const removed = oldString.split('\n').length;
      if (added > removed) {
        summary = `Added ${added - removed} lines to ${fileName}`;
      } else if (removed > added) {
        summary = `Removed ${removed - added} lines from ${fileName}`;
      } else {
        summary = `Modified ${fileName}`;
      }
    } else {
      summary = `Modified ${fileName}`;
    }
  }

  return { changeType, summary };
}

async function main() {
  try {
    let inputData = '';
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    const input: ToolUseInput = inputData ? JSON.parse(inputData) : {};

    const toolName = input.tool_name;
    if (!toolName) {
      process.exit(0);
    }

    // 이 훅은 settings.json 에 matcher 'Edit' / 'Write' 로만 등록된다(install.ts).
    // Bash·Read·Glob·Grep 은 **애초에 이 프로세스에 도달하지 않는다** — 앞 판의
    // 「추적되지 않는 도구까지 센다」는 주석은 거짓이었다. 아래 TRACKED_TOOLS 필터보다
    // 앞에 두는 이유는 그 필터에 걸려 버려지는 발화(경로 없는 Write 등)를 세기 위해서다.
    const traceCwd = input.cwd || process.cwd();
    trace('post-tool-use', detectWorkspaceRoot(traceCwd), {
      tool: toolName,
      tpath: tpathOf(input.transcript_path),
      file: input.tool_input?.file_path,
      cwd: traceCwd,
      // 이 키가 실제로 오는지가 턴 단위 추적의 성립 조건이다. 선언은 증거가
      // 아니므로(R2) 값이 아니라 유무만 남겨 배포 후 실측한다.
      sid: input.session_id ? 'yes' : 'no',
    });

    // Bash 에러 감지 → 솔루션 자동 주입
    if (toolName === 'Bash' && input.tool_result) {
      const errorSig = extractErrorSignature(input.tool_result);
      if (errorSig) {
        const cwd = input.cwd || process.cwd();
        const project = detectProject(cwd);
        const dbPath = getDbPath(cwd);
        if (fs.existsSync(dbPath)) {
          try {
            const db = new Database(dbPath, { readonly: true });
            const solutions = searchSolutions(db, project, errorSig);
            db.close();
            if (solutions.length > 0) {
              const lines = ['## Past solutions for similar error\n'];
              for (const s of solutions) {
                const sol = s.solution.length > 100 ? s.solution.slice(0, 100) + '...' : s.solution;
                const date = s.created_at?.slice(0, 10) || '';
                lines.push(`- **${s.error_signature.slice(0, 60)}** → ${sol} (${s.project}, ${date})`);
              }
              console.log(`\n<past-solution>\n${lines.join('\n')}\n</past-solution>\n`);
            }
          } catch { /* ignore */ }
        }
      }
      process.exit(0);
    }

    // Playwright 도구 사용 후 캐시 정리 (20MB 컨텍스트 초과 방지)
    if (toolName.startsWith('mcp__playwright__')) {
      const cwd = input.cwd || process.cwd();
      cleanPlaywrightCache(cwd);
      process.exit(0);
    }

    const TRACKED_TOOLS = ['Edit', 'Write', 'Read', 'Glob', 'Grep'];

    if (!TRACKED_TOOLS.includes(toolName)) {
      process.exit(0);
    }

    // Read/Glob/Grep에서도 파일 경로 추출
    let filePath = input.tool_input?.file_path;
    if (!filePath && toolName === 'Glob') {
      // Glob의 경우 path 파라미터 사용
      filePath = (input.tool_input as Record<string, unknown>)?.path as string;
    }
    if (!filePath && toolName === 'Grep') {
      filePath = (input.tool_input as Record<string, unknown>)?.path as string;
    }

    if (!filePath) {
      process.exit(0);
    }

    // 무시 패턴 체크 — 세그먼트 일치 + %TEMP%/scratchpad 제외 (utils/paths.ts).
    // 여기 있던 `includes('dist/')` 식 배열은 Windows 에서 5/7 이 죽어 있었고,
    // 남의 세션 스크래치패드가 그대로 통과해 modified_files 의 18% 를 채웠다.
    if (isIgnoredPath(filePath)) {
      process.exit(0);
    }

    const cwd = input.cwd || process.cwd();
    const project = detectProject(cwd);
    const dbPath = getDbPath(cwd);

    if (!fs.existsSync(dbPath)) {
      process.exit(0);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // 다중 hook 프로세스 동시성 보장

    // hot_paths 추적 (모든 추적 도구)
    try {
      const pathType = filePath.includes('.') ? 'file' : 'directory';
      db.prepare(`
        INSERT INTO hot_paths (project, file_path, access_count, last_accessed, path_type)
        VALUES (?, ?, 1, datetime('now'), ?)
        ON CONFLICT(project, file_path) DO UPDATE SET
          access_count = access_count + 1,
          last_accessed = datetime('now')
      `).run(project, filePath, pathType);

      // 7일 이상 된 경로의 access_count decay (반으로 줄임)
      db.prepare(`
        UPDATE hot_paths
        SET access_count = MAX(1, access_count / 2)
        WHERE project = ? AND last_accessed < datetime('now', '-7 days')
      `).run(project);
    } catch {
      // hot_paths 테이블 미존재 시 무시
    }

    // Edit, Write만 상세 추적 (기존 로직)
    if (['Edit', 'Write'].includes(toolName)) {
      const { changeType, summary } = categorizeChange(
        toolName,
        filePath,
        input.tool_input?.old_string,
        input.tool_input?.new_string
      );

      try {
        // 간단한 방식으로 recent_files 업데이트
        const existing = db.prepare('SELECT recent_files FROM active_context WHERE project = ?').get(project) as { recent_files: string } | undefined;

        let recentFiles: string[] = [];
        if (existing?.recent_files) {
          try {
            recentFiles = JSON.parse(existing.recent_files);
          } catch {
            recentFiles = [];
          }
        }

        // 중복 제거하고 최신 파일 추가 (최대 10개)
        recentFiles = recentFiles.filter(f => f !== filePath);
        recentFiles.unshift(filePath);
        recentFiles = recentFiles.slice(0, 10);

        db.prepare(`
          INSERT OR REPLACE INTO active_context (project, recent_files, updated_at)
          VALUES (?, ?, datetime('now'))
        `).run(project, JSON.stringify(recentFiles));

      } catch {
        // 오류 시 무시
      }

      // 턴 단위 기록 — 위 recent_files 는 프로젝트당 하나라 동시 세션이 서로를
      // 덮는다. session_id 로 갈라 두면 session-end 가 자기 턴 것만 집어간다.
      //
      // ★ session_id 가 없으면 아무것도 하지 않는다. 그 경우 session-end 는
      //   예전대로 recent_files 스냅샷을 쓰므로 동작이 후퇴하지 않는다.
      //   (훅 페이로드에 이 키가 실제로 오는지는 배포 후 실물로 확인한다.)
      if (input.session_id) {
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS session_files (
              session_id TEXT NOT NULL,
              project TEXT NOT NULL,
              file_path TEXT NOT NULL,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (session_id, project, file_path)
            )
          `);
          db.prepare(`
            INSERT INTO session_files (session_id, project, file_path, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(session_id, project, file_path)
            DO UPDATE SET updated_at = datetime('now')
          `).run(input.session_id, project, filePath);

          // 회수되지 못한 찌꺼기 청소 — session-end 가 한 번도 안 뜬 세션이
          // 남긴 행이 영구히 쌓이는 것을 막는다.
          db.prepare(`DELETE FROM session_files WHERE updated_at < datetime('now', '-2 days')`).run();
        } catch {
          // 테이블 생성 실패(권한·구버전 DB) 시 무시 — 폴백이 있다
        }
      }

      // auto-tracked 메모리 기록 제거 (v1.10.0)
      // git이 파일 변경을 더 잘 추적함. hot_paths + recent_files만 유지.
    }

    db.close();
    process.exit(0);
  } catch (e) {
    logHookError('post-tool-use', e);
    process.exit(0);
  }
}

main();
