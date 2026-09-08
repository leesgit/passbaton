// 임시 작업 디렉터리에 기록하지 않는다 — 실사용에서 잡힌 결함
//
// 2026-09-08 실측: `codex exec` 를 스크래치패드에서 돌리면 detectWorkspaceRoot 의
// 규칙(.git · apps/ · 기존 sessions.db)이 하나도 안 걸려 **스크래치패드 자신이
// 워크스페이스 루트**가 된다. 훅은 거기에 `.claude/` 와 빈 DB 를 만들고, 그 DB 에는
// 새 테이블만 있고 `sessions` 가 없어 INSERT 가 던진다.
//
// 결과: **Codex(Astra) 훅이 12회 발화하는 동안 프로젝트 DB 의 행은 0개.**
// 디스크에는 흔적이 남아서 「기록되고 있다」고 오독하기 쉬웠다.
//
// ⛔ 「%TEMP% 하위면 전부 임시」로 판정하면 안 된다 — 멀티에이전트 워크트리가 거기
// 생기고 그건 진짜 작업이다. 표식이 하나도 없을 때만 임시로 본다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isEphemeralRoot } from '../src/utils/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const POST_TOOL = path.resolve(here, '../dist/hooks/post-tool-use.js');
const built = fs.existsSync(SESSION_END) && fs.existsSync(POST_TOOL);

const dirs: string[] = [];
const tmpDir = (name: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length) {
    try { fs.rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe('isEphemeralRoot', () => {
  it('표식 없는 임시 디렉터리는 임시다', () => {
    expect(isEphemeralRoot(tmpDir('pb-eph-'))).toBe(true);
  });

  it('.git 이 있으면 진짜 워크스페이스다 (워크트리)', () => {
    const d = tmpDir('pb-wt-');
    fs.writeFileSync(path.join(d, '.git'), 'gitdir: elsewhere\n');
    expect(isEphemeralRoot(d)).toBe(false);
  });

  it('apps/ 가 있으면 모노레포다', () => {
    const d = tmpDir('pb-mono-');
    fs.mkdirSync(path.join(d, 'apps'));
    expect(isEphemeralRoot(d)).toBe(false);
  });

  it('이미 sessions.db 가 있으면 계속 쓴다', () => {
    const d = tmpDir('pb-has-');
    fs.mkdirSync(path.join(d, '.claude'));
    fs.writeFileSync(path.join(d, '.claude', 'sessions.db'), '');
    expect(isEphemeralRoot(d)).toBe(false);
  });

  it('%TEMP% 밖은 언제나 임시가 아니다', () => {
    expect(isEphemeralRoot(process.cwd())).toBe(false);
  });
});

describe.skipIf(!built)('훅이 임시 디렉터리에 흔적을 남기지 않는다', () => {
  it('Stop 훅이 .claude 를 만들지 않는다', () => {
    const d = tmpDir('pb-eph-stop-');
    const tpath = path.join(os.tmpdir(), `t-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(tpath, JSON.stringify({ type: 'assistant', message: { content: '구현 완료 — 무언가를 했다' } }) + '\n');
    dirs.push(tpath);

    spawnSync('node', [SESSION_END], {
      input: JSON.stringify({ cwd: d, session_id: 's1', prompt_id: 'p1', transcript_path: tpath }),
      encoding: 'utf-8',
    });

    expect(fs.existsSync(path.join(d, '.claude'))).toBe(false);
  });

  it('PostToolUse 훅도 만들지 않는다', () => {
    const d = tmpDir('pb-eph-ptu-');
    spawnSync('node', [POST_TOOL], {
      input: JSON.stringify({
        cwd: d, session_id: 's1', tool_name: 'Edit',
        tool_input: { file_path: path.join(d, 'a.ts'), old_string: 'a', new_string: 'b' },
      }),
      encoding: 'utf-8',
    });

    expect(fs.existsSync(path.join(d, '.claude'))).toBe(false);
  });
});
