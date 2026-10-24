// C7 실제 컴팩션 전달 시험 (2.8 · Astra reply-170 PB170-110) — ① 격리 작업 폴더
//
// 프로젝트 settings(.claude/settings.json)에만 passbaton 훅을 단다 — 지정한 패키지 폴더의 dist 를 node 절대 경로로(exec 형식).
// 사용자 settings 의 전역 훅·MCP 는 drive.mjs 의 실행 플래그(--setting-sources project · --strict-mcp-config)로 뺀다.
// ⛔ 사용자의 ~/.claude 는 건드리지 않는다. 이 폴더만 지우고 다시 만든다.
//
// 사용: node scripts/compact-e2e/mkws.mjs <새 작업 폴더> [패키지 폴더 = 이 레포]
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ws = path.resolve(process.argv[2] ?? '');
const pkg = path.resolve(process.argv[3] ?? repo);
if (!process.argv[2]) throw new Error('usage: mkws.mjs <workspace dir> [package dir]');
if (!fs.existsSync(path.join(pkg, 'dist', 'hooks', 'session-start.js'))) throw new Error(`no dist in ${pkg} — run npm run build`);
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: ws });                       // 워크스페이스 표식(임시 폴더 아래면 이것이 있어야 DB 를 만든다)
fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'c7game', private: true }));
// 인계 원천 — 현재 작업·정지·대기 원문(그대로 전달돼야 한다). drive.mjs 가 대화 뒤에 「인계 전용」 줄을 더한다.
fs.writeFileSync(path.join(ws, 'docs', 'HANDOFF.md'), [
  '# 최신 절',
  '- 현재 작업: C7-TASK-4417 미니맵 셰이더 분기 B 검토',
  '- 정지: C7-STOP-9902 DEMO_STOP 유지 — 게임 재개 금지',
  '- 대기: C7-WAIT-3318 사람 화면 판정 대기',
  '',
].join('\n'));
const node = process.execPath;
const hook = (f) => ({ hooks: [{ type: 'command', command: node, args: [path.join(pkg, 'dist', 'hooks', f)] }] });
fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify({
  hooks: {
    SessionStart: [hook('session-start.js')],
    UserPromptSubmit: [hook('user-prompt-submit.js')],
    PostToolUse: [{ matcher: 'Edit', ...hook('post-tool-use.js') }, { matcher: 'Write', ...hook('post-tool-use.js') }],
    PreCompact: [hook('pre-compact.js')],
    Stop: [hook('session-end.js')],
  },
}, null, 2));
fs.writeFileSync(path.join(ws, '.claude', 'passbaton.config.json'), JSON.stringify({
  features: { hookTrace: { enabled: true } },
  continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 6, label: 'HANDOFF' }] },
}, null, 2));
console.log(ws);
