// C7 실제 컴팩션 전달 시험 (2.8 · Astra reply-170 PB170-110) — ③ 판정
//
// **호스트가 기록한 사건열**(stream-json + --include-hook-events)만으로 본다 — passbaton 출력의 자기 표시는 믿지 않는다.
// 컴팩션 증거 = 호스트의 compact_result=success · compact_boundary · PreCompact 실행 기록 · 호스트가 이름 붙인
// `SessionStart:compact` 응답. startup 출력은 이름이 `SessionStart:startup` 이라 compact 증거가 될 수 없다(E2 실패).
//
// 사용: node scripts/compact-e2e/check.mjs <사건열.jsonl>   → 항목별 PASS/FAIL · 하나라도 FAIL 이면 종료 코드 1
import * as fs from 'fs';

const ev = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
const res = [];
const check = (id, ok, why) => res.push({ id, ok: !!ok, why });

const hookResp = (name) => ev.filter(e => e.type === 'system' && e.subtype === 'hook_response' && e.hook_name === name);
const iCompactDone = ev.findIndex(e => e.type === 'system' && e.subtype === 'status' && e.compact_result === 'success');
const iBoundary = ev.findIndex(e => e.type === 'system' && e.subtype === 'compact_boundary');
const compact = hookResp('SessionStart:compact');
const startup = hookResp('SessionStart:startup');
const preCompactRan = ev.some(e => e.type === 'user' && typeof e.message?.content === 'string' && /PreCompact \[.*pre-compact\.js\] completed successfully/.test(e.message.content));

check('E0 실제 컴팩션', iCompactDone >= 0 && iBoundary >= 0, `compact_result=success @${iCompactDone} · compact_boundary @${iBoundary}`);
check('E1 PreCompact 훅 실행(호스트 기록)', preCompactRan, 'local-command-stdout 의 PreCompact … completed successfully');
check('E2 SessionStart:compact 수신(호스트가 compact 로 부름)', compact.length === 1, `SessionStart:compact hook_response ${compact.length} 건`);
const out = compact[0]?.output ?? '';
const ORIGINAL = ['- 현재 작업: C7-TASK-4417 미니맵 셰이더 분기 B 검토', '- 정지: C7-STOP-9902 DEMO_STOP 유지 — 게임 재개 금지', '- 대기: C7-WAIT-3318 사람 화면 판정 대기'];
check('E3 현재 작업·정지·대기 원문 그대로', ORIGINAL.every(l => out.split(/\r?\n/).includes(l)), ORIGINAL.filter(l => !out.split(/\r?\n/).includes(l)).join(' | ') || 'all lines present');
check('E4 인계에만 있는 고유 정보(C7-ONLY-8080)', out.includes('C7-ONLY-8080'), 'compact 출력에 있음?');
check('E5 컴팩션 복구 블록 — 이 세션의 마지막 요청', /Recovered after compaction[\s\S]*C7-REQ-5521/.test(out), 'Recovered … C7-REQ-5521');
check('E6 다른 세션 인계 혼입 없음', !out.includes('C7-OTHER-7070'), 'C7-OTHER-7070 없음?');
const st = startup[0]?.output ?? '';
check('E7 startup 대조와 구별', startup.length === 1 && !st.includes('C7-ONLY-8080') && !st.includes('Recovered after compaction'),
  `startup ${startup.length} 건 · startup 출력에 C7-ONLY/Recovered 없음`);
// 모델이 실제로 받았는가 — 컴팩션 뒤 같은 프로세스의 질문 답(도구 호출 0 · 그 사이 다른 SessionStart 없음)
const iQ = ev.findIndex(e => e.type === 'driver' && e.label === 'question');
const after = iQ >= 0 ? ev.slice(iQ) : [];
const answer = after.find(e => e.type === 'result')?.result ?? '';
const toolUses = after.filter(e => e.type === 'assistant' && (e.message?.content ?? []).some(c => c.type === 'tool_use')).length;
const resumeAfter = after.filter(e => e.subtype === 'hook_response' && /^SessionStart:/.test(e.hook_name ?? '')).length;
check('E8 모델 수신(컴팩션 뒤 답에 C7-ONLY-8080 · 도구 0 · 다른 SessionStart 없음)',
  answer.includes('C7-ONLY-8080') && toolUses === 0 && resumeAfter === 0, `answer="${String(answer).slice(0, 160)}" tools=${toolUses} ss_after=${resumeAfter}`);

for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id} — ${r.why}`);
const fail = res.filter(r => !r.ok).length;
console.log(fail ? `FAIL ${fail}/${res.length}` : `PASS ${res.length}/${res.length}`);
process.exitCode = fail ? 1 : 0;
