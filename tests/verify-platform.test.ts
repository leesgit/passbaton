// detectPlatform — .NET / Godot 감지
//
// 왜 이 파일이 있는가: passbaton 의 verify_* 는 Godot + C# 레포에서 통째로 쓸 수
// 없었다. 그 레포(Ashfall)는 자기 명령 문서에 「이 프로젝트에서 verify_* 를 쓸 수
// 없다」고 적어두고 우회하고 있었다.
//
// 원인은 두 가지였고 두 번째가 결정적이다:
//   1. detectPlatform 에 dotnet/godot 분기가 없었다
//   2. ⭐ 있었어도 안 걸렸다 — 그 레포의 표식은 루트가 아니라 한 단계 아래에 있다
//      (core/Sim.sln · game/project.godot · game/game.csproj, 루트엔 0개)
//
// 그래서 테스트도 두 축이다: 분기가 있는가, 그리고 한 단계 아래를 보는가.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectPlatform, findsNearby } from '../src/tools-v2/verify.js';

let root: string;

/** 파일 목록으로 가짜 프로젝트를 만든다. 'a/b.txt' 처럼 하위 경로를 써도 된다. */
function project(name: string, files: string[]): string {
  const dir = path.join(root, name);
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'passbaton-platform-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectPlatform — 기존 플랫폼은 그대로', () => {
  it('pubspec.yaml 이면 flutter', async () => {
    expect(await detectPlatform(project('flutter-app', ['pubspec.yaml']))).toBe('flutter');
  });

  it('build.gradle.kts 면 android', async () => {
    expect(await detectPlatform(project('android-app', ['build.gradle.kts']))).toBe('android');
  });

  it('아무 표식도 없으면 node 로 떨어진다', async () => {
    expect(await detectPlatform(project('bare', ['README.md']))).toBe('node');
  });
});

describe('detectPlatform — .NET / Godot', () => {
  it('루트의 project.godot 을 본다', async () => {
    expect(await detectPlatform(project('godot-root', ['project.godot']))).toBe('godot');
  });

  it('루트의 .csproj 를 본다', async () => {
    expect(await detectPlatform(project('csproj-root', ['App.csproj']))).toBe('dotnet');
  });

  it('루트의 .sln 을 본다', async () => {
    expect(await detectPlatform(project('sln-root', ['App.sln']))).toBe('dotnet');
  });

  // ★ 이 셋이 이 수정의 이유다. Ashfall 의 실제 배치다.
  it('한 단계 아래의 project.godot 을 본다', async () => {
    expect(await detectPlatform(project('godot-sub', ['game/project.godot']))).toBe('godot');
  });

  it('한 단계 아래의 .sln 을 본다', async () => {
    expect(await detectPlatform(project('sln-sub', ['core/Sim.sln']))).toBe('dotnet');
  });

  it('Ashfall 의 실제 배치 — 루트엔 표식이 없고 godot 이 dotnet 을 이긴다', async () => {
    const dir = project('ashfall-like', [
      'core/Sim.sln',
      'game/Ashfall.sln',
      'game/game.csproj',
      'game/project.godot',
      'tools/verify.ps1',
    ]);
    // 루트에 표식이 없다는 것 자체를 먼저 못박는다 — 이 전제가 무너지면
    // 아래 기대값은 다른 이유로 통과할 수 있다.
    expect(fs.readdirSync(dir).filter((f) => /\.(sln|csproj)$|^project\.godot$/.test(f))).toEqual([]);
    expect(await detectPlatform(dir)).toBe('godot');
  });
});

describe('findsNearby — 깊이와 제외 규칙', () => {
  it('두 단계 아래는 보지 않는다', () => {
    const dir = project('too-deep', ['a/b/App.csproj']);
    expect(findsNearby(dir, (n) => n.endsWith('.csproj'))).toBe(false);
  });

  it('node_modules / build / dist 안은 보지 않는다', () => {
    for (const skip of ['node_modules', 'build', 'dist']) {
      const dir = project(`skip-${skip}`, [`${skip}/Vendor.csproj`]);
      expect(findsNearby(dir, (n) => n.endsWith('.csproj'))).toBe(false);
    }
  });

  it('점으로 시작하는 디렉터리 안은 보지 않는다', () => {
    const dir = project('skip-dot', ['.hidden/App.sln']);
    expect(findsNearby(dir, (n) => n.endsWith('.sln'))).toBe(false);
  });

  it('없는 경로에서 던지지 않는다', () => {
    expect(findsNearby(path.join(root, 'does-not-exist'), () => true)).toBe(false);
  });
});
