// P0-6 회귀 테스트 (2026-09-07 감사)
//
// 훅의 워크스페이스 루트 탐지가 `apps/<app>/.claude/sessions.db` 에서 멈춰
// 모노레포 루트 DB 를 가로채던 사고. 실측으로 hero-maker 는 훅이 265번 발화하고
// 세션 행이 0건이었고, 루트 DB 에서 석 달이 비었다.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectWorkspaceRoot } from '../src/utils/workspace.js';

let tmp: string;
const savedEnv = process.env.WORKSPACE_ROOT;

function mk(...segments: string[]): string {
  const p = path.join(tmp, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function touchDb(dir: string, bytes = 0): void {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'sessions.db'), Buffer.alloc(bytes));
}

beforeEach(() => {
  delete process.env.WORKSPACE_ROOT;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-root-')));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('detectWorkspaceRoot', () => {
  it('WORKSPACE_ROOT 환경변수가 모든 탐색을 이긴다', () => {
    const app = mk('repo', 'apps', 'hero-maker');
    touchDb(app);
    process.env.WORKSPACE_ROOT = '/explicit/root';

    expect(detectWorkspaceRoot(app)).toBe('/explicit/root');
  });

  // ★ 이것이 P0-6 본체다
  it('apps/<app>/.claude/sessions.db 가 있어도 모노레포 루트를 반환한다', () => {
    const repo = mk('repo');
    mk('repo', 'apps');
    const app = mk('repo', 'apps', 'hero-maker');
    touchDb(repo, 4096);
    touchDb(app, 4096); // 함정 파일 — 예전 구현은 여기서 멈췄다

    expect(detectWorkspaceRoot(app)).toBe(repo);
  });

  it('함정 파일이 0바이트여도 마찬가지다', () => {
    const repo = mk('repo');
    const app = mk('repo', 'apps', 'korea-benefits-finder');
    touchDb(repo, 4096);
    touchDb(app, 0);

    expect(detectWorkspaceRoot(app)).toBe(repo);
  });

  it('모노레포가 아니면 sessions.db 를 가진 가장 가까운 디렉터리를 쓴다', () => {
    const proj = mk('standalone');
    const deep = mk('standalone', 'src', 'components');
    touchDb(proj, 4096);

    expect(detectWorkspaceRoot(deep)).toBe(proj);
  });

  it('아무 단서도 없으면 cwd 를 그대로 쓴다 (상위로 새지 않는다)', () => {
    const bare = mk('bare', 'nested');

    expect(detectWorkspaceRoot(bare)).toBe(bare);
  });

  // 이 머신의 ~/.claude/sessions.db 에는 세션 101건이 프로젝트명 `scea4`
  // (윈도우 사용자명)로 들어가 있었다. 홈 위로 새면 그 파일로 빨려 들어간다.
  it('홈 디렉터리의 .claude/sessions.db 를 워크스페이스로 잡지 않는다', () => {
    const home = fs.realpathSync(os.homedir());
    const under = path.join(home, 'AppData', 'Local', 'Temp');
    // 홈 아래 임시 경로에서 호출해도 홈으로 올라가지 않는다
    if (!fs.existsSync(path.join(home, '.claude', 'sessions.db'))) return; // 단서 없으면 의미 없는 검사
    expect(detectWorkspaceRoot(under)).not.toBe(home);
  });

  // apps/kenshi-fantasy 는 모노레포 안에 있으면서 자체 git 레포다.
  // .git 을 무조건 경계로 삼으면 그 프로젝트(실측 450세션)가 루트 DB 에서 떨어져 나간다.
  it('앱이 자체 git 레포여도 모노레포 루트를 쓴다', () => {
    const repo = mk('repo');
    const app = mk('repo', 'apps', 'kenshi-fantasy');
    fs.mkdirSync(path.join(app, '.git'), { recursive: true });
    touchDb(repo, 4096);

    expect(detectWorkspaceRoot(app)).toBe(repo);
  });

  // 상위의 고아 DB 가 형제 프로젝트를 빨아들여 프로젝트명이 `GitHub` 으로
  // 기록된 행이 실제로 남아 있었다.
  it('상위의 고아 sessions.db 가 레포 경계를 넘어 가로채지 않는다', () => {
    const parent = mk('workspaces');
    const proj = mk('workspaces', 'my-lib');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    touchDb(parent, 4096); // 고아 DB — 예전에는 여기로 빨려 들어갔다

    expect(detectWorkspaceRoot(proj)).toBe(proj);
  });

  it('모노레포 루트에서 호출하면 자기 자신을 반환한다', () => {
    const repo = mk('repo');
    mk('repo', 'apps');
    touchDb(repo, 4096);

    expect(detectWorkspaceRoot(repo)).toBe(repo);
  });
});
