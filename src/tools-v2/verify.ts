// 검증 도구 (verify)
// 빌드/테스트/린트 자동 실행
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { db, APPS_DIR } from '../db/database.js';
import { logger } from '../utils/logger.js';
import { VerifySchema } from '../schemas.js';
import type { Tool, CallToolResult } from '../types.js';
import { readDeclaredVerification, type DeclaredCommand } from './verify-config.js';

// ===== 도구 정의 =====

export const verifyTools: Tool[] = [
  {
    name: 'verify',
    description: `프로젝트 검증 (빌드/테스트/린트).
- gates: 실행할 게이트 배열 (기본: 전체)
  - build: 빌드 검증
  - test: 테스트 실행
  - lint: 린트 검사
각 게이트 결과와 전체 성공 여부 반환.
실패 시 에러 메시지 포함.`,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '프로젝트명' },
        gates: {
          type: 'array',
          items: { type: 'string', enum: ['build', 'test', 'lint'] },
          description: '실행할 게이트 (기본: 전체)'
        }
      },
      required: ['project']
    }
  }
];

// 플랫폼별 명령어 매핑
const PLATFORM_COMMANDS: Record<string, Record<string, string>> = {
  nextjs: {
    build: 'pnpm build',
    test: 'pnpm test:run || pnpm test --run || echo "No test script"',
    lint: 'pnpm lint'
  },
  react: {
    build: 'pnpm build',
    test: 'pnpm test --watchAll=false',
    lint: 'pnpm lint'
  },
  flutter: {
    build: 'flutter build apk --debug',
    test: 'flutter test',
    lint: 'flutter analyze'
  },
  android: {
    build: './gradlew assembleDebug',
    test: './gradlew test',
    lint: './gradlew lint'
  },
  // ⛔ .NET / GODOT — 이게 없어서 이 도구가 통째로 못 쓰이는 프로젝트가 있었다.
  //
  // Ashfall(apps/kenshi-fantasy)은 Godot 4 + 정수 전용 C# 코어이고, 표식이
  // 루트가 아니라 한 단계 아래에 있다: core/Sim.sln, game/project.godot,
  // game/game.csproj. 루트만 보던 detectPlatform 은 전부 놓치고 'node' 로
  // 떨어져 `pnpm build` 를 시도했다 — 그 레포엔 package.json 이 없다.
  //
  // 그래서 그 프로젝트는 passbaton 의 verify_* 를 쓸 수 없다고 자기 명령
  // 문서(.claude/commands/ashfall.md)에 적어두고 우회하고 있었다. 2026-09-08.
  //
  // ⚠ 이 명령들은 컴파일이 되는지까지만 본다. 그 레포의 진짜 게이트는 182개짜리
  // tools/verify.ps1 이고 이것이 대체하지 않는다. 빠른 확인용이다.
  godot: {
    build: 'dotnet build',
    test: 'dotnet test',
    lint: 'dotnet format --verify-no-changes || echo "no format config"'
  },
  dotnet: {
    build: 'dotnet build',
    test: 'dotnet test',
    lint: 'dotnet format --verify-no-changes || echo "no format config"'
  },
  node: {
    build: 'pnpm build || npm run build',
    test: 'pnpm test || npm test',
    lint: 'pnpm lint || npm run lint'
  }
};

// ===== 핸들러 =====

export async function handleVerify(args: unknown): Promise<CallToolResult> {
  return logger.withTool('verify', async () => {
    // 입력 검증
    const parsed = VerifySchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: 'text' as const, text: `Validation error: ${parsed.error.message}` }],
        isError: true
      };
    }

    const { project, gates } = parsed.data;
    const projectPath = path.join(APPS_DIR, project);

    // 플랫폼 감지 — 선언이 없는 게이트의 폴백이다.
    const platform = await detectPlatform(projectPath);
    const commands = PLATFORM_COMMANDS[platform] || PLATFORM_COMMANDS.node;

    // ★ 프로젝트가 선언한 명령이 우선한다. 감지는 그 레포가 PATH 를 먼저 세워야
    //   하는지, 진짜 게이트가 무엇인지 알 수 없다 — 알 수 있는 척하지 않는다.
    const declared = readDeclaredVerification(projectPath);

    const results: Record<string, {
      success: boolean; source: 'declared' | 'detected'; command: string;
      output?: string; error?: string; duration: number;
    }> = {};

    for (const gate of gates) {
      const decl = declared.commands[gate as 'build' | 'test' | 'lint'];
      const fallback = commands[gate];
      if (!decl && !fallback) continue;

      const startTime = Date.now();
      const result = decl
        ? await runDeclared(decl, projectPath)
        : await runCommand(fallback, projectPath);
      const duration = Date.now() - startTime;

      results[gate] = {
        success: result.success,
        source: decl ? 'declared' : 'detected',
        command: decl ? [decl.command, ...decl.args].join(' ') : fallback,
        output: result.success ? result.output?.slice(-500) : undefined,
        error: !result.success ? result.error?.slice(-1000) : undefined,
        duration
      };

      logger.info(`Gate ${gate} ${result.success ? 'passed' : 'failed'}`, {
        duration,
        success: result.success,
        source: results[gate].source
      }, 'verify');
    }

    const allPassed = Object.values(results).every(r => r.success);

    // active_context에 검증 결과 저장
    try {
      db.prepare(`
        UPDATE active_context SET last_verification = ?, updated_at = CURRENT_TIMESTAMP
        WHERE project = ?
      `).run(allPassed ? 'passed' : 'failed', project);
    } catch { /* ignore */ }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          project,
          platform,
          allPassed,
          results,
          // ★ 선언 없이 돈 결과를 「이 프로젝트를 검증했다」고 말하지 않는다.
          //   감지된 기본 빌드를 시도했을 뿐이다.
          scope: Object.values(results).every(r => r.source === 'declared')
            ? 'project-declared verification'
            : 'detected default build attempt (declare `verification` in .claude/passbaton.config.json for the real gates)',
          // 모양이 틀린 선언은 조용히 무시하지 않는다 — 그러면 사용자는 자기
          // 스크립트가 돈 줄 알고 다른 빌드의 결과를 본다.
          invalidDeclarations: declared.invalid.length > 0 ? declared.invalid : undefined,
          summary: Object.entries(results)
            .map(([gate, r]) => `${gate}: ${r.success ? '✅' : '❌'} (${r.source}, ${r.duration}ms)`)
            .join(', ')
        }, null, 2)
      }]
    };
  }, args as Record<string, unknown>);
}

/**
 * 프로젝트 루트와 그 바로 아래 한 단계에서 패턴에 맞는 파일을 찾는다.
 *
 * ★ 한 단계를 내려가는 이유는 실측이다. Godot·.NET 레포는 솔루션과 프로젝트
 * 파일을 루트에 두지 않는 것이 오히려 보통이고, Ashfall 이 정확히 그렇다
 * (core/Sim.sln · game/project.godot). 루트만 보면 그런 레포는 전부 'node' 로
 * 떨어진다.
 *
 * ⚠ 한 단계까지만이다. 깊이 제한이 없으면 node_modules 나 build 산출물 안의
 * 남의 .csproj 를 주워 엉뚱한 플랫폼으로 판정한다.
 */
export function findsNearby(projectPath: string, matches: (name: string) => boolean): boolean {
  const scan = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((e) => e.isFile() && matches(e.name));
  };

  if (scan(projectPath)) return true;

  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return false;
  }

  return children.some((e) => {
    if (!e.isDirectory()) return false;
    if (e.name.startsWith('.')) return false;
    if (e.name === 'node_modules' || e.name === 'build' || e.name === 'dist') return false;
    return scan(path.join(projectPath, e.name));
  });
}

export async function detectPlatform(projectPath: string): Promise<string> {
  const { existsSync } = fs;

  if (existsSync(path.join(projectPath, 'pubspec.yaml'))) return 'flutter';
  if (existsSync(path.join(projectPath, 'build.gradle')) || existsSync(path.join(projectPath, 'build.gradle.kts'))) return 'android';

  // Godot 을 .NET 보다 먼저 본다. Godot + C# 레포는 둘 다 갖고 있고, 그때
  // 더 구체적인 쪽이 godot 이기 때문이다.
  if (findsNearby(projectPath, (n) => n === 'project.godot')) return 'godot';
  if (findsNearby(projectPath, (n) => n.endsWith('.sln') || n.endsWith('.csproj'))) return 'dotnet';

  try {
    const { readFileSync } = await import('fs');
    const pkgPath = path.join(projectPath, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.dependencies?.next) return 'nextjs';
      if (pkg.dependencies?.react) return 'react';
    }
  } catch { /* ignore */ }

  return 'node';
}

/**
 * 선언된 명령을 **셸을 거치지 않고** 실행한다.
 *
 * ★ 인자 경계를 보존해야 한다. `sh -c "<한 줄>"` 로 넘기면 공백이 든 경로가 쪼개지고
 * 사용자 데이터가 셸 메타문자로 해석된다. 선언은 실행 파일 + 인자 배열이므로 그
 * 모양 그대로 넘긴다.
 */
function runDeclared(decl: DeclaredCommand, projectPath: string): Promise<{ success: boolean; output?: string; error?: string }> {
  const cwd = decl.cwd ? path.resolve(projectPath, decl.cwd) : projectPath;

  return new Promise((resolve) => {
    const proc = spawn(decl.command, decl.args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      shell: false,
      timeout: 300000
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      // ⛔ 실패하면 그 실패를 낸다. 감지된 기본 빌드로 조용히 갈아타지 않는다 —
      //    그러면 다른 명령의 성공이 이 프로젝트의 검증 성공으로 보고된다.
      if (code === 0) resolve({ success: true, output: stdout });
      else resolve({ success: false, error: stderr || stdout || `exit code ${code}` });
    });

    proc.on('error', (err) => resolve({ success: false, error: err.message }));
  });
}

function runCommand(command: string, cwd: string): Promise<{ success: boolean; output?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd,
      env: { ...process.env, CI: 'true' },
      timeout: 300000 // 5분
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, error: stderr || stdout });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}
