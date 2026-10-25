// PB195-400 — 정체성 잔재: 공개 이름·서버 식별·도구 수가 실제 등록과 같은가 + 구 bin 별칭 호환
//
// 잔재(원장 A1·B1·B3): serverInfo `project-manager-v5`/5.0.0 · 기동 줄 「24 tools」(실제 26) · glama.json 「25 MCP tools」·2.1.2.
// 판정은 문자열이 아니라 **실제 서버 응답**(initialize·tools/list·prompts/list)과 맞춘다.
// 구 bin 7 개는 2.x 동안 같은 파일을 가리키는 별칭으로 남긴다(README 「Alias policy」) — 지우면 이 시험이 빨개진다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SERVER = path.join(ROOT, 'dist', 'index.js');
const built = fs.existsSync(SERVER);
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string; bin: Record<string, string> };

// 공개 도구 이름 = 사용자 권한 설정(mcp__<서버 키>__<도구>)이 기대는 계약. 바꾸려면 이 표와 README 를 함께 고친다.
const PUBLIC_TOOLS = [
  'resume_card', 'session_start', 'session_end', 'session_history', 'search_sessions',
  'project_status', 'project_init', 'project_analyze', 'list_projects',
  'task_add', 'task_update', 'task_list', 'task_suggest',
  'solution_record', 'solution_find', 'solution_suggest',
  'verify_build', 'verify_test', 'verify_all',
  'memory_store', 'memory_search', 'memory_get', 'memory_related', 'memory_stats',
  'graph_connect', 'graph_explore',
].sort();

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

type Msg = { id?: number; result?: Record<string, unknown> };
function talk(extraEnv: Record<string, string> = {}): { msgs: Msg[]; stderr: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-195id-'));
  roots.push(ws);
  fs.mkdirSync(path.join(ws, '.git'));
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pb195-id', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} },
  ].map(l => JSON.stringify(l)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [SERVER], {
    input: lines, encoding: 'utf-8', cwd: ws, timeout: 30_000,
    env: { ...process.env, WORKSPACE_ROOT: ws, ...extraEnv },
  });
  const msgs = (r.stdout || '').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) as Msg; } catch { return {}; } });
  return { msgs, stderr: r.stderr || '' };
}
const byId = (msgs: Msg[], id: number) => msgs.find(m => m.id === id)?.result;

describe.skipIf(!built)('PB195-400 정체성 — 실제 응답과 맞춘다', () => {
  it('serverInfo = passbaton · package.json 버전(옛 project-manager-v5/5.0.0 아님)', () => {
    const { msgs } = talk();
    const info = byId(msgs, 1)?.serverInfo as { name: string; version: string } | undefined;
    expect(info).toEqual({ name: PKG.name, version: PKG.version });
  });

  it('tools/list = 공개 도구 표 그대로 · 기동 줄의 수 = 실제 등록 수(하드코딩 아님) · prompts 도', () => {
    const { msgs, stderr } = talk();
    const tools = (byId(msgs, 2)?.tools as Array<{ name: string }>).map(t => t.name).sort();
    const prompts = byId(msgs, 3)?.prompts as unknown[];
    expect(tools).toEqual(PUBLIC_TOOLS);
    expect(prompts.length).toBeGreaterThan(0);
    expect(stderr).toContain(`passbaton MCP ${PKG.version} started (${tools.length} tools + ${prompts.length} prompts)`);
  });

  it('읽기 전용(PASSBATON_READONLY=1): 기동 줄의 수가 걸러진 등록 수와 같다(양성 대조 — 수가 실제로 바뀌는 경우)', () => {
    const { msgs, stderr } = talk({ PASSBATON_READONLY: '1' });
    const tools = byId(msgs, 2)?.tools as unknown[];
    const prompts = byId(msgs, 3)?.prompts as unknown[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(PUBLIC_TOOLS.length);
    expect(stderr).toContain(`started (${tools.length} tools + ${prompts.length} prompts · read-only)`);
  });

  // glama.json 은 레포 메타데이터(패키지 files 밖) — 설치본에서 돌릴 때는 없다(PB195-800)
  it.skipIf(!fs.existsSync(path.join(ROOT, 'glama.json')))('glama.json: 버전 = package.json · 도구 수를 적으면 실제 등록 수와 같아야 한다', () => {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'glama.json'), 'utf8')) as { name: string; version: string; description: string };
    expect(g.name).toBe(PKG.name);
    expect(g.version).toBe(PKG.version);
    for (const m of g.description.matchAll(/(\d+)\s+MCP tools/g)) expect(Number(m[1])).toBe(PUBLIC_TOOLS.length);
  });
});

describe('PB195-400 구 bin 별칭 호환(2.x 동안 유지 · README Alias policy)', () => {
  const ALIASES: Record<string, string> = {
    'claude-session-continuity-mcp': 'passbaton',
    'claude-session-hooks': 'passbaton-hooks',
    'claude-hook-session-start': 'passbaton-hook-session-start',
    'claude-hook-user-prompt': 'passbaton-hook-user-prompt',
    'claude-hook-post-tool': 'passbaton-hook-post-tool',
    'claude-hook-pre-compact': 'passbaton-hook-pre-compact',
    'claude-hook-session-end': 'passbaton-hook-session-end',
  };
  for (const [legacy, current] of Object.entries(ALIASES)) {
    it(`${legacy} → ${current} 와 같은 파일`, () => {
      expect(PKG.bin[current], `${current} 가 bin 에 있다`).toBeTruthy();
      expect(PKG.bin[legacy], `${legacy} 별칭이 bin 에 남아 있다`).toBe(PKG.bin[current]);
      if (built) expect(fs.existsSync(path.join(ROOT, PKG.bin[legacy]))).toBe(true);
    });
  }
  it('README 가 별칭 정책을 적고 있다(제거는 메이저에서만)', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('**Alias policy (2.8):**');
    for (const legacy of ['claude-session-continuity-mcp', 'claude-session-hooks']) expect(readme).toContain(legacy);
  });
});
