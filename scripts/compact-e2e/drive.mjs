// C7 실제 컴팩션 전달 시험 (2.8 · Astra reply-170 PB170-110) — ② 실제 호스트 구동
//
// 실제 claude CLI **한 프로세스** 안에서: 요청 → (인계 원천 변경 · 다른 세션 인계 행 하나) → 실제 `/compact` → 질문.
// 한 프로세스라야 컴팩션 뒤 질문에 SessionStart(resume) 가 끼지 않는다 — 답에 나온 것은 compact 전달분이다.
// 격리: --setting-sources project(사용자 settings 의 전역 훅 제외) · --strict-mcp-config(MCP 없음) · 도구 금지.
// ⚠ 모델 호출 비용이 든다(3 턴 + 컴팩션 1). 통제된 시험이다 — 자연 재개 표본(docs/resume-events.md)으로 세지 않는다.
//
// 사용: node scripts/compact-e2e/drive.mjs <mkws 로 만든 작업 폴더> <사건열.jsonl>
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

const [ws, out] = process.argv.slice(2).map(p => path.resolve(p));
const Database = createRequire(import.meta.url)('better-sqlite3');

const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-hook-events', '--verbose',
  '--setting-sources', 'project', '--strict-mcp-config',
  '--disallowed-tools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit'];
const child = spawn('claude', args, { cwd: ws, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, shell: process.platform === 'win32' });
const events = [];
let buf = '';
let waiting = null;
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    events.push({ t: Date.now(), ...j });
    if (j.type === 'result' && waiting) { const w = waiting; waiting = null; w(j); }
  }
});
child.stderr.on('data', d => fs.appendFileSync(out + '.err', d));
const send = (text) => new Promise(res => {
  waiting = res;
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
});
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
const step = (label, text) => { events.push({ t: Date.now(), type: 'driver', label }); return Promise.race([send(text), timeout(300_000)]); };

try {
  await step('request', '고유 표지 C7-REQ-5521: 다음 턴에 분기 B 셰이더 검토 결과를 표로 정리해 줘. 지금은 도구를 쓰지 말고 ACK 한 단어만 답해.');
  // 인계 전용 정보 — 대화에는 한 번도 나오지 않는다(카드 원천에만). 다른 세션의 인계 행도 하나 깐다(혼입 검출용).
  fs.appendFileSync(path.join(ws, 'docs', 'HANDOFF.md'), '- 인계 전용: C7-ONLY-8080 (대화에 없음)\n');
  const db = new Database(path.join(ws, '.claude', 'sessions.db'));
  db.prepare(`INSERT INTO compact_handover (session_id, project, request, pending, active_file, created_at, pre_uuid)
    VALUES ('other-session-7070', ?, 'C7-OTHER-7070 다른 세션의 요청', 0, NULL, datetime('now', '+1 hour'), 'nope')`).run(path.basename(ws));
  db.close();
  events.push({ t: Date.now(), type: 'driver', label: 'handoff-changed' });
  await step('compact', '/compact');
  await step('question', '도구를 쓰지 말고 답해: 지금 컨텍스트에 있는 C7-ONLY- 로 시작하는 표지, 그리고 현재 작업·정지·대기 표지(C7-TASK-·C7-STOP-·C7-WAIT-)를 한 줄에 그대로 적어. 없으면 없다고 적어.');
} catch (e) {
  events.push({ t: Date.now(), type: 'driver', label: 'error', error: String(e) });
} finally {
  child.stdin.end();
  await new Promise(r => { child.on('exit', r); setTimeout(r, 20_000); });
  fs.writeFileSync(out, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`events ${events.length} → ${out}`);
}
