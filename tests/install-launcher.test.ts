// 훅 실행 명령 형태 (2026-09-07 · 2026-10-15)
//
// `npm exec -- <bin>` 은 로컬/전역 어디서든 도는 대신 발화마다 1,357 ms 를 낸다.
// 이름만 쓰면 125 ms (10.9배). 둘 다 **훅을 띄우는 프로세스의 PATH** 에 기댄다 —
// Node 설치 전부터 열려 있던 앱에서 띄운 Claude Code 는 그 PATH 가 옛것이라 훅이 매번
// `npm: command not found` 로 죽었다(2026-10-15). 그래서 Claude Code 훅은 node·스크립트
// 절대 경로로 쓴다. Codex·Gemini 는 훅 셸을 확인하지 못해 예전 형태 그대로다.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hookCommand, binResolves, isOurHookCommand, claudeHookCommand, isQuotablePath, toShellPath,
  parseAbsoluteCommand, stripOurHooks, mergeEvent, readJsonFile, isOurMcpEntry, mcpServerEntry,
  checkHookCommand, findOnPath,
} from '../src/hooks/install.js';

const dirs: string[] = [];
const tmpDir = (name: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) {
    try { fs.rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe('hookCommand (Codex·Gemini)', () => {
  it('이름이 풀리면 bin 이름만 쓴다 (빠른 경로)', () => {
    expect(hookCommand('post-tool', true)).toBe('passbaton-hook-post-tool');
  });

  it('안 풀리면 npm exec 로 감싼다 (기존 동작 유지)', () => {
    expect(hookCommand('post-tool', false)).toBe('npm exec -- passbaton-hook-post-tool');
  });

  it('호스트 플래그는 양쪽 모두 뒤에 붙는다', () => {
    expect(hookCommand('session-start', true, ' --codex')).toBe('passbaton-hook-session-start --codex');
    expect(hookCommand('session-start', false, ' --gemini')).toBe(
      'npm exec -- passbaton-hook-session-start --gemini',
    );
  });
});

describe('claudeHookCommand — PATH 와 무관한 절대 경로', () => {
  const hooksDir = path.join(os.tmpdir(), 'x', 'passbaton', 'dist', 'hooks');

  it('node 와 훅 스크립트를 각각 큰따옴표로 감싼다', () => {
    const c = claudeHookCommand('user-prompt', '/usr/local/bin/node', hooksDir);
    const p = parseAbsoluteCommand(c);
    expect(p).not.toBeNull();
    expect(p!.node).toBe(toShellPath('/usr/local/bin/node'));
    expect(p!.script.endsWith('dist/hooks/user-prompt-submit.js') || p!.script.endsWith('dist\\hooks\\user-prompt-submit.js')).toBe(true);
  });

  it('모든 훅 이름이 실제 스크립트 파일로 매핑된다', () => {
    for (const [name, file] of [['session-start', 'session-start.js'], ['user-prompt', 'user-prompt-submit.js'],
      ['post-tool', 'post-tool-use.js'], ['pre-compact', 'pre-compact.js'], ['session-end', 'session-end.js']]) {
      expect(claudeHookCommand(name, '/n', hooksDir)).toContain(file);
    }
  });

  it('Windows 경로는 슬래시로 — bash 가 백슬래시를 이스케이프로 읽지 않게', () => {
    expect(toShellPath('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe('C:/Program Files/nodejs/node.exe');
    expect(toShellPath('/a\\b', 'linux')).toBe('/a\\b');
  });

  it('공백·한글 경로는 그대로 감싼다', () => {
    expect(isQuotablePath('C:/Program Files/노드/node.exe')).toBe(true);
  });

  it('따옴표로 못 감싸는 글자가 있으면 npm exec 로 물러난다 (깨진 명령보다 낫다)', () => {
    for (const bad of ['C:/a"b/node.exe', '/opt/$HOME/node', '/a`b/node', 'C:/100%/node.exe', 'C:/hi!/node.exe']) {
      expect(isQuotablePath(bad)).toBe(false);
      expect(claudeHookCommand('post-tool', bad, hooksDir)).toBe('npm exec -- passbaton-hook-post-tool');
    }
  });

  it('모르는 훅 이름은 던진다', () => {
    expect(() => claudeHookCommand('nope', '/n', hooksDir)).toThrow();
  });
});

// ★ 재설치 회귀 방지: merge 는 「우리 것」을 알아봐야 교체한다.
// 못 알아보면 지우지 못하고 **중복 등록**되어 훅이 두 번 돈다.
// 반대로 남의 줄을 우리 것으로 보면 재설치가 **사용자 훅을 지운다.**
describe('isOurHookCommand — 형태가 바뀌어도 알아보고, 남의 줄은 안 건드린다', () => {
  it('이름만 · npm exec · npx · npx --no (v1 포함) 를 알아본다', () => {
    for (const c of ['passbaton-hook-post-tool', 'npm exec -- passbaton-hook-post-tool',
      'npm exec -- claude-hook-session-end', 'claude-hook-session-end',
      'npx claude-hook-session-start', 'npx --no claude-hook-user-prompt',
      'passbaton-hook-session-start --codex', '  passbaton-hook-pre-compact  ']) {
      expect(isOurHookCommand(c), c).toBe(true);
    }
  });

  it('절대 경로 형태를 알아본다 — 패키지 디렉터리 이름 또는 지금 설치기 옆', () => {
    expect(isOurHookCommand('"C:/Program Files/nodejs/node.exe" "C:/Users/u/AppData/Roaming/npm/node_modules/passbaton/dist/hooks/post-tool-use.js"')).toBe(true);
    expect(isOurHookCommand('"/usr/bin/node" "/usr/lib/node_modules/claude-session-continuity-mcp/dist/hooks/session-end.js"')).toBe(true);
    const own = path.join(os.tmpdir(), 'checkout-with-other-name', 'dist', 'hooks');
    const c = `"/usr/bin/node" "${toShellPath(path.join(own, 'session-start.js'))}"`;
    expect(isOurHookCommand(c, own)).toBe(true);
    expect(isOurHookCommand(c)).toBe(false);
  });

  it('사용자가 감싼 줄 · passbaton 글자만 든 줄 · 같은 파일명의 남의 스크립트는 우리 것이 아니다', () => {
    for (const c of ['my-wrapper passbaton-hook-post-tool', 'bash -c "passbaton-hook-post-tool"',
      'passbaton-hook-post-tool && echo done', 'echo passbaton', 'node ~/passbaton-notes.js',
      '"/usr/bin/node" "/home/u/my-hooks/dist/hooks/session-start.js"',
      '"/usr/bin/node" "/home/u/passbaton/dist/hooks/my-own.js"', 'my-own-hook --flag']) {
      expect(isOurHookCommand(c), c).toBe(false);
    }
    expect(isOurHookCommand(undefined)).toBe(false);
  });
});

describe('stripOurHooks / mergeEvent — 사용자 줄·순서·필드 보존', () => {
  const ours = { hooks: [{ type: 'command', command: '"/n" "/p/passbaton/dist/hooks/session-start.js"' }] };

  it('같은 항목에 섞인 사용자 줄은 남긴다 (예전엔 항목째 지웠다)', () => {
    const mixed = [{ matcher: 'Edit', timeout: 5, hooks: [
      { type: 'command', command: 'npm exec -- passbaton-hook-post-tool' },
      { type: 'command', command: 'my-formatter --fix' },
    ] }];
    const { kept, removed } = stripOurHooks(mixed);
    expect(removed).toBe(1);
    expect(kept).toEqual([{ matcher: 'Edit', timeout: 5, hooks: [{ type: 'command', command: 'my-formatter --fix' }] }]);
  });

  it('우리 줄만 있던 항목은 지우고 사용자 항목은 순서 그대로', () => {
    const existing = [
      { hooks: [{ type: 'command', command: 'user-a' }] },
      { hooks: [{ type: 'command', command: 'passbaton-hook-session-start' }] },
      { hooks: [{ type: 'command', command: 'user-b' }] },
    ];
    expect(mergeEvent(existing, [ours], false)).toEqual([existing[0], existing[2], ours]);
  });

  it('명시적 재설치를 두 번 해도 우리 줄은 하나', () => {
    const once = mergeEvent([], [ours], false);
    expect(mergeEvent(once, [ours], false)).toEqual([ours]);
  });

  it('자동 설치(postinstall)는 이미 있는 우리 줄을 바꾸지 않는다', () => {
    const existing = [{ hooks: [{ type: 'command', command: 'npm exec -- passbaton-hook-session-start' }] }];
    expect(mergeEvent(existing, [ours], true)).toBe(existing);
  });

  it('자동 설치라도 우리 줄이 없으면 추가한다', () => {
    const existing = [{ hooks: [{ type: 'command', command: 'user-a' }] }];
    expect(mergeEvent(existing, [ours], true)).toEqual([existing[0], ours]);
  });
});

describe('readJsonFile — 깨진 설정을 빈 설정으로 보지 않는다', () => {
  it('missing / ok / invalid 를 가른다', () => {
    const d = tmpDir('pb-json-');
    expect(readJsonFile(path.join(d, 'none.json')).state).toBe('missing');
    fs.writeFileSync(path.join(d, 'ok.json'), '{"a":1}');
    expect(readJsonFile(path.join(d, 'ok.json'))).toEqual({ state: 'ok', data: { a: 1 } });
    fs.writeFileSync(path.join(d, 'bad.json'), '{"a":1,');
    expect(readJsonFile(path.join(d, 'bad.json')).state).toBe('invalid');
    fs.writeFileSync(path.join(d, 'arr.json'), '[1]');
    expect(readJsonFile(path.join(d, 'arr.json')).state).toBe('invalid');
  });
});

describe('isOurMcpEntry — 이름이 같아도 남의 서버는 안 건드린다', () => {
  it('npx 형태(옛 이름·버전·-y)와 절대 경로 형태를 알아본다', () => {
    expect(isOurMcpEntry({ command: 'npx', args: ['passbaton'] })).toBe(true);
    expect(isOurMcpEntry({ command: 'npx', args: ['-y', 'passbaton@latest'] })).toBe(true);
    expect(isOurMcpEntry({ command: 'npx.cmd', args: ['claude-session-continuity-mcp'] })).toBe(true);
    expect(isOurMcpEntry(mcpServerEntry('/usr/bin/node', '/usr/lib/node_modules/passbaton/dist'))).toBe(true);
  });

  it('남의 서버·이상한 값은 아니다', () => {
    expect(isOurMcpEntry({ command: 'npx', args: ['some-other-mcp'] })).toBe(false);
    expect(isOurMcpEntry({ command: 'npx', args: ['passbaton', '--evil'] })).toBe(false);
    expect(isOurMcpEntry({ command: 'python', args: ['server.py'] })).toBe(false);
    expect(isOurMcpEntry({ command: '/usr/bin/node', args: ['/home/u/mine/dist/index.js'] })).toBe(false);
    expect(isOurMcpEntry(null)).toBe(false);
    expect(isOurMcpEntry({ command: 'npx' })).toBe(false);
  });

  it('MCP 항목은 JSON 값이라 셸 따옴표를 붙이지 않는다', () => {
    const e = mcpServerEntry('C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\passbaton\\dist');
    expect(e.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(e.args[0].includes('"')).toBe(false);
  });
});

describe('checkHookCommand — 「등록됨」 · 「찾을 수 있음」 · 「실행됨」 을 가른다', () => {
  const win = process.platform === 'win32';
  const touch = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name + (win ? '.cmd' : ''));
    fs.writeFileSync(f, '');
    if (!win) fs.chmodSync(f, 0o755);
  };
  const sep = win ? ';' : ':';

  it('PATH 가 비면 npm exec · 이름만 둘 다 실패', () => {
    const empty = tmpDir('pb-empty-');
    expect(checkHookCommand('npm exec -- passbaton-hook-post-tool', empty)).toMatchObject({ form: 'npm-exec', ok: false });
    expect(checkHookCommand('passbaton-hook-post-tool', empty)).toMatchObject({ form: 'bare', ok: false });
  });

  it('shim 만 있고 node 가 없으면 실패 — 파일 발견만으로 정상 판정하지 않는다', () => {
    const bin = tmpDir('pb-bin-');
    touch(bin, 'passbaton-hook-post-tool');
    const r = checkHookCommand('passbaton-hook-post-tool', bin);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('node not on PATH');
  });

  it('node 만 있고 shim 이 없으면 실패', () => {
    const nd = tmpDir('pb-node-');
    touch(nd, 'node');
    expect(checkHookCommand('passbaton-hook-post-tool', nd).ok).toBe(false);
  });

  it('shim + node 가 있으면 통과 (PATH 의존이라고 밝힌다)', () => {
    const a = tmpDir('pb-a-');
    touch(a, 'passbaton-hook-post-tool');
    touch(a, 'node');
    const r = checkHookCommand('passbaton-hook-post-tool', a + sep);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('depends on PATH');
  });

  it('절대 경로: 지금 node 와 실제 스크립트면 PATH 가 비어도 통과', () => {
    const d = tmpDir('pb-abs-');
    const script = path.join(d, 'session-start.js');
    fs.writeFileSync(script, '');
    const c = `"${toShellPath(process.execPath)}" "${toShellPath(script)}"`;
    expect(checkHookCommand(c, tmpDir('pb-empty2-'))).toMatchObject({ form: 'absolute', ok: true });
  });

  it('절대 경로: 사라진 node · 사라진 스크립트는 각각 실패로', () => {
    const d = tmpDir('pb-gone-');
    const script = path.join(d, 'session-start.js');
    fs.writeFileSync(script, '');
    const goneNode = checkHookCommand(`"${toShellPath(path.join(d, 'no-node.exe'))}" "${toShellPath(script)}"`);
    expect(goneNode.ok).toBe(false);
    expect(goneNode.detail).toContain('node not found');
    const goneScript = checkHookCommand(`"${toShellPath(process.execPath)}" "${toShellPath(path.join(d, 'gone.js'))}"`);
    expect(goneScript.ok).toBe(false);
    expect(goneScript.detail).toContain('hook script not found');
  });

  it('findOnPath 는 없는 이름에 null', () => {
    expect(findOnPath('passbaton-definitely-not-a-real-bin-xyz')).toBeNull();
  });
});

describe('binResolves', () => {
  it('없는 이름은 false', () => {
    expect(binResolves('passbaton-definitely-not-a-real-bin-xyz')).toBe(false);
  });

  it('던지지 않는다 (판정 불가는 안전한 쪽으로)', () => {
    expect(() => binResolves('')).not.toThrow();
  });
});
