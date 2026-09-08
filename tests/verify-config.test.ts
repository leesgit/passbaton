// 프로젝트가 선언한 검증 명령
//
// 왜 이 파일이 있는가: 「감지된 플랫폼 → 표준 명령」은 컴파일이 되는지까지만 안다.
// 실측(2026-09-08) — Ashfall 을 `godot` 으로 감지하는 데 성공했지만 그 결과 나온
// `dotnet build` 는 이 머신에서 `No .NET SDKs were found` 로 죽는다. SDK 가
// $HOME\.dotnet 에 사용자 로컬로 있고, 그 레포의 정본은 PATH 를 세운 뒤 도는
// tools/verify.ps1 이다. 감지로는 맞힐 수 없다.
//
// ⛔ 그래서 파일명을 추측해 실행하지 않는다. **선언만 계약이다.**
// 그리고 모양이 틀린 선언은 「선언 없음」으로 처리하지 않는다 — 그러면 감지된
// 기본값이 대신 돌아서 사용자는 자기 스크립트가 돈 줄 알고 다른 빌드의 결과를 본다.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDeclaredVerification } from '../src/tools-v2/verify-config.js';

let root: string;

function project(name: string, config?: unknown): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(dir, '.claude', 'passbaton.config.json'),
      typeof config === 'string' ? config : JSON.stringify(config)
    );
  }
  return dir;
}

beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-vc-')); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('readDeclaredVerification — 선언이 없을 때', () => {
  it('설정 파일이 없으면 빈 선언', () => {
    const d = readDeclaredVerification(project('none'));
    expect(d.commands).toEqual({});
    expect(d.invalid).toEqual([]);
  });

  it('JSON 이 깨져도 던지지 않는다', () => {
    const d = readDeclaredVerification(project('broken', '{ this is not json'));
    expect(d.commands).toEqual({});
  });

  it('verification 블록이 없으면 빈 선언', () => {
    const d = readDeclaredVerification(project('noblock', { hookTrace: true }));
    expect(d.commands).toEqual({});
  });
});

describe('readDeclaredVerification — 정상 선언', () => {
  it('Ashfall 이 실제로 쓸 형태', () => {
    const dir = project('ashfall', {
      verification: {
        build: { command: 'pwsh', args: ['-File', 'tools/verify.ps1'] },
        test: { command: 'dotnet', args: ['test', 'core/Sim.Tests'], cwd: '.' },
      },
    });

    const d = readDeclaredVerification(dir);
    expect(d.commands.build).toEqual({ command: 'pwsh', args: ['-File', 'tools/verify.ps1'], cwd: undefined });
    expect(d.commands.test).toEqual({ command: 'dotnet', args: ['test', 'core/Sim.Tests'], cwd: '.' });
    expect(d.commands.lint).toBeUndefined();   // 선언 안 한 게이트는 감지 폴백
    expect(d.invalid).toEqual([]);
  });

  it('args 를 생략하면 빈 배열', () => {
    const d = readDeclaredVerification(project('noargs', {
      verification: { build: { command: 'make' } },
    }));
    expect(d.commands.build).toEqual({ command: 'make', args: [], cwd: undefined });
  });
});

describe('readDeclaredVerification — 틀린 선언은 버리고 알린다', () => {
  const bad: Array<[string, unknown]> = [
    ['command 없음', { build: { args: ['x'] } }],
    ['command 가 빈 문자열', { build: { command: '   ' } }],
    ['args 가 문자열 한 줄', { build: { command: 'pwsh', args: '-File tools/verify.ps1' } }],
    ['args 에 문자열 아닌 것', { build: { command: 'pwsh', args: ['-File', 3] } }],
    ['항목이 문자열', { build: 'pwsh -File tools/verify.ps1' }],
    ['모르는 게이트 이름', { deploy: { command: 'sh', args: ['deploy.sh'] } }],
  ];

  for (const [label, verification] of bad) {
    it(`${label} → invalid 로 보고하고 실행하지 않는다`, () => {
      const d = readDeclaredVerification(project(`bad-${label.replace(/\s/g, '-')}`, { verification }));
      expect(Object.keys(d.commands)).toEqual([]);
      expect(d.invalid.length).toBe(1);
    });
  }

  it('args 가 문자열 한 줄이면 특히 위험하다 — 셸에 넘기면 인자 경계가 무너진다', () => {
    const d = readDeclaredVerification(project('shellish', {
      verification: { build: { command: 'sh', args: '-c "rm -rf /"' } },
    }));
    expect(d.commands.build).toBeUndefined();
    expect(d.invalid).toEqual(['build']);
  });

  it('정상 항목과 틀린 항목이 섞이면 정상만 통과한다', () => {
    const d = readDeclaredVerification(project('mixed', {
      verification: {
        build: { command: 'pwsh', args: ['-File', 'tools/verify.ps1'] },
        test: { args: ['test'] },
      },
    }));
    expect(d.commands.build?.command).toBe('pwsh');
    expect(d.commands.test).toBeUndefined();
    expect(d.invalid).toEqual(['test']);
  });
});
