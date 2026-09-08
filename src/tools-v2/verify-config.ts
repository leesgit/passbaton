/**
 * 프로젝트가 스스로 선언한 검증 명령.
 *
 * ★ 왜 필요한가 — 「감지된 플랫폼 → 표준 명령」은 **컴파일이 되는지**까지만 안다.
 * 그 레포가 PATH 를 먼저 세워야 하는지, 선행 생성물이 있는지, 진짜 게이트가
 * 무엇인지는 모른다.
 *
 * 실측(2026-09-08): Ashfall 을 `godot` 으로 감지하는 데 성공했지만 그 결과 나온
 * `dotnet build` 는 이 머신에서 `No .NET SDKs were found` 로 죽는다. SDK 가
 * `$HOME\.dotnet` 에 사용자 로컬로 깔려 있고, 그 레포의 정본 검증은
 * `. tools/env.ps1` 로 PATH 를 세운 뒤 도는 182개짜리 `tools/verify.ps1` 이다.
 * 감지를 아무리 잘해도 이건 맞힐 수 없다.
 *
 * ⛔ 그렇다고 `verify.ps1` / `build.sh` 같은 **파일명을 찾아 실행하지 않는다.**
 * 이름이 그렇다는 것은 그것이 검증 진입점이라는 증거가 아니고, 임의의 스크립트를
 * 사용자 기계에서 실행하는 근거로는 더더욱 부족하다. **선언만 계약이다.**
 *
 * 선언 위치는 기존 규약을 따른다 — `<project>/.claude/passbaton.config.json`:
 *
 * ```json
 * {
 *   "verification": {
 *     "build": { "command": "pwsh", "args": ["-File", "tools/verify.ps1"] },
 *     "test":  { "command": "dotnet", "args": ["test", "core/Sim.Tests"] }
 *   }
 * }
 * ```
 *
 * 선언하지 않은 게이트는 감지된 기본값으로 떨어진다. 우선순위는
 * **선언 → 감지된 플랫폼 기본값** 이고, 어느 쪽을 썼는지는 결과에 같이 낸다.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DeclaredCommand {
  command: string;
  args: string[];
  cwd?: string;
}

const GATES = ['build', 'test', 'lint'] as const;
export type Gate = (typeof GATES)[number];

function isGate(name: string): name is Gate {
  return (GATES as readonly string[]).includes(name);
}

/**
 * 한 항목을 검증한다. **모양이 틀리면 조용히 무시하지 않고 버린다** — 잘못
 * 선언한 것을 「선언 없음」으로 처리하면 감지된 기본값이 대신 돌아서, 사용자는
 * 자기 스크립트가 돈 줄 알고 다른 빌드의 결과를 본다.
 */
function parseEntry(value: unknown): DeclaredCommand | null {
  if (typeof value !== 'object' || value === null) return null;

  const v = value as Record<string, unknown>;

  if (typeof v.command !== 'string' || v.command.trim() === '') return null;

  // 인자는 배열이어야 한다. 문자열 한 줄을 받아 셸에 넘기면 인자 경계가 무너진다.
  let args: string[] = [];
  if (v.args !== undefined) {
    if (!Array.isArray(v.args)) return null;
    if (!v.args.every((a) => typeof a === 'string')) return null;
    args = v.args as string[];
  }

  const cwd = typeof v.cwd === 'string' ? v.cwd : undefined;

  return { command: v.command, args, cwd };
}

export interface DeclaredVerification {
  commands: Partial<Record<Gate, DeclaredCommand>>;
  /** 모양이 틀려 버린 항목. 호출부가 결과에 실어 보이게 한다. */
  invalid: string[];
}

/** 프로젝트가 선언한 검증 명령. 파일이 없거나 못 읽으면 빈 선언이다. */
export function readDeclaredVerification(projectPath: string): DeclaredVerification {
  const out: DeclaredVerification = { commands: {}, invalid: [] };
  const file = path.join(projectPath, '.claude', 'passbaton.config.json');

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return out;   // 없음 · 깨짐 → 선언 없음
  }

  const verification = (raw as { verification?: unknown })?.verification;
  if (typeof verification !== 'object' || verification === null) return out;

  for (const [name, value] of Object.entries(verification as Record<string, unknown>)) {
    if (!isGate(name)) {
      out.invalid.push(name);
      continue;
    }

    const parsed = parseEntry(value);
    if (parsed) {
      out.commands[name] = parsed;
    } else {
      out.invalid.push(name);
    }
  }

  return out;
}
