// 2.7.3 — 「현재 작업」 원천 추출 실패를 카드 첫 줄에 (Astra reply-153 PR-5 · reply-154 PB154-D)
//
// 계약: 설정에서 `"role": "current-task"` 로 고른 첫 원천이 no_block·missing·읽기 실패·빈 범위면 카드 **첫 줄** ⚠.
// 명시적 「없음 — 사람 결과 대기」 블록은 정상 대기(경고 아님). 잘림(truncated)은 실패가 아니다.
// 예산 때문에 못 보인 것은 ⚠ 가 아니라 ℹ — 실패·대기·예산을 같은 뜻으로 만들지 않는다.
// role 지정이 없으면 경고 없음(기존 동작). 카드 상한·원문 보존·재분배(2.7.2) 유지.
// 역검증(reply-154 §4 D): 작업 절 삭제 · CRLF · 예산 경계 · 명시적 대기 입력 → 상태 혼동·경고 소실이면 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildResumeCard, readContinuityDeclaration, type ContinuitySource } from '../src/utils/resume-card.js';

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function project(files: Record<string, string>, sources: unknown[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-273d-')));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources } }));
  return dir;
}

const TASK = { path: '.ralph/fix_plan.md', block: '지금 할 일', label: 'fix_plan 지금 할 일', role: 'current-task' };
const STOP: ContinuitySource = { path: '.ralph/DEMO_STOP', lines: 3, label: '정지 사유' };
const IDX: ContinuitySource = { path: 'docs/INDEX.md', block: '활성 처분', label: '색인' };
const plan = (body: string[]) => ['# fix_plan', '', '## 지금 할 일', '', ...body, '', '## 이력', '', '- [x] N150 끝', ''].join('\n');
const ACTIVE = plan(['- [ ] **N153** 지도 깜빡임 — 촬영·판독 · 원문 reply-153 §2']);
const WAITING = plan(['없음 — 사람 결과 대기 (H-152 · c9f8e14 체크리스트)']);
const NO_SECTION = ['# fix_plan', '', '## 이력', '', '- [x] N150 끝', ''].join('\n');
const INDEX = ['# 색인', '', '## 활성 처분', '', '| ID | 처분 |', '|---|---|', '| A1 | 미니맵 H 대기 |', ''].join('\n');

const firstLine = (t: string) => t.split(/\r?\n/)[0];
const isWarn = (t: string) => firstLine(t).startsWith('⚠ CURRENT TASK');

describe('PB154-D 현재 작업 원천 상태 → 카드 첫 줄', () => {
  it('정상 블록 → 경고 없음 · 첫 줄은 카드 머리', () => {
    const card = buildResumeCard(project({ '.ralph/fix_plan.md': ACTIVE }, [STOP, TASK, IDX]), 3200)!;
    expect(card.taskStatus).toBe('ok');
    expect(firstLine(card.text)).toMatch(/^## Resume card/);
    expect(card.text).toContain('N153');
  });

  it('명시적 「없음 — 사람 결과 대기」 → 정상 대기(경고 아님) · 그 문구가 카드에 그대로', () => {
    const card = buildResumeCard(project({ '.ralph/fix_plan.md': WAITING }, [STOP, TASK]), 3200)!;
    expect(card.taskStatus).toBe('ok');
    expect(isWarn(card.text)).toBe(false);
    expect(card.text).not.toContain('CURRENT TASK');
    expect(card.text).toContain('없음 — 사람 결과 대기 (H-152');
  });

  it('작업 절 삭제(no_block) → 첫 줄 ⚠ · 「명시적 대기가 아니다」 를 말한다', () => {
    const card = buildResumeCard(project({ '.ralph/fix_plan.md': NO_SECTION }, [STOP, TASK, IDX]), 3200)!;
    expect(card.taskStatus).toBe('no_block');
    expect(firstLine(card.text)).toMatch(/^⚠ CURRENT TASK UNKNOWN — block "지금 할 일" not found in `\.ralph\/fix_plan\.md`/);
    expect(firstLine(card.text)).toContain('not an explicit "none — waiting"');
    expect(card.text.split('\n')[1]).toMatch(/^## Resume card/);
  });

  it('CRLF 파일 — 블록이 있으면 정상 · 없으면 ⚠ (줄 끝 \\r 로 상태가 바뀌지 않는다)', () => {
    const ok = buildResumeCard(project({ '.ralph/fix_plan.md': ACTIVE.replace(/\n/g, '\r\n') }, [TASK]), 3200)!;
    expect(ok.taskStatus).toBe('ok');
    expect(isWarn(ok.text)).toBe(false);
    const wait = buildResumeCard(project({ '.ralph/fix_plan.md': WAITING.replace(/\n/g, '\r\n') }, [TASK]), 3200)!;
    expect(wait.taskStatus).toBe('ok');
    expect(isWarn(wait.text)).toBe(false);
    const gone = buildResumeCard(project({ '.ralph/fix_plan.md': NO_SECTION.replace(/\n/g, '\r\n') }, [TASK]), 3200)!;
    expect(gone.taskStatus).toBe('no_block');
    expect(isWarn(gone.text)).toBe(true);
  });

  it('파일 없음(missing) → ⚠ not found', () => {
    const card = buildResumeCard(project({}, [STOP, TASK]), 3200)!;
    expect(card.taskStatus).toBe('missing');
    expect(firstLine(card.text)).toMatch(/^⚠ CURRENT TASK UNKNOWN — `\.ralph\/fix_plan\.md` not found/);
  });

  it('읽기 실패(일반 파일 아님 · 비밀 이름) → ⚠ could not be read', () => {
    const dir = project({}, [{ ...TASK, path: 'plan.md' }]);
    fs.mkdirSync(path.join(dir, 'plan.md'));                       // 폴더 — 일반 파일이 아니다
    const card = buildResumeCard(dir, 3200)!;
    expect(card.taskStatus).toBe('denied');
    expect(firstLine(card.text)).toMatch(/^⚠ CURRENT TASK UNKNOWN — `plan\.md` could not be read/);
    const secret = buildResumeCard(project({ '.env.md': 'x' }, [{ ...TASK, path: '.env.md' }]), 3200)!;
    expect(isWarn(secret.text)).toBe(true);
  });

  it('빈 작업 절(제목만 · CRLF 포함) → ⚠ empty — 대기 문구가 없으면 대기가 아니다', () => {
    const empty = ['# fix_plan', '', '## 지금 할 일', '', '   ', '## 이력', '- [x] 끝', ''].join('\n');
    for (const body of [empty, empty.replace(/\n/g, '\r\n')]) {
      const card = buildResumeCard(project({ '.ralph/fix_plan.md': body }, [TASK]), 3200)!;
      expect(card.taskStatus).toBe('empty');
      expect(firstLine(card.text)).toMatch(/^⚠ CURRENT TASK UNKNOWN — block "지금 할 일" in `\.ralph\/fix_plan\.md` is empty/);
    }
  });

  it('잘림(긴 작업 절 · 작은 예산) → 실패 아님 — ⚠ 없음 · 항목에 truncated', () => {
    const long = plan(Array.from({ length: 60 }, (_, i) => `- [ ] 하위 단계 ${i + 1} — 촬영·판독·기록을 순서대로 한다`));
    const card = buildResumeCard(project({ '.ralph/fix_plan.md': long }, [STOP, TASK, IDX]), 900)!;
    expect(card.taskStatus).toBe('ok');
    expect(card.items[1].truncated).toBe(true);
    expect(isWarn(card.text)).toBe(false);
    expect(card.text.length).toBeLessThanOrEqual(900);
  });

  it('예산 때문에 생략(원천 수 상한) → ℹ (⚠ 아님) · 상태 budget', () => {
    // 400 자 예산은 원천 1 개만 싣는다 — 현재 작업이 두 번째면 생략된다
    const card = buildResumeCard(project({ '.ralph/fix_plan.md': ACTIVE, '.ralph/DEMO_STOP': '정지\n' }, [STOP, TASK]), 400)!;
    expect(card.taskStatus).toBe('budget');
    expect(firstLine(card.text)).toMatch(/^ℹ CURRENT TASK not shown in this card \(card budget — not a failure\)/);
    expect(isWarn(card.text)).toBe(false);
    expect(card.text.length).toBeLessThanOrEqual(400);
  });

  it('예산 때문에 본문 숨김(머리글이 예산을 먹음) → ℹ budget · 실패(⚠)와 다르다', () => {
    const deep = `${'d/'.repeat(90)}fix_plan.md`;
    const long = plan(Array.from({ length: 30 }, (_, i) => `- [ ] 단계 ${i + 1} — 길게 적은 하위 항목`));
    const card = buildResumeCard(project({ [`${'d/'.repeat(90)}a.md`]: long, [deep]: long },
      [{ path: `${'d/'.repeat(90)}a.md`, block: '지금 할 일', label: 'L'.repeat(80) }, { ...TASK, path: deep, label: 'T'.repeat(80) }]), 700)!;
    expect(card.text.length).toBeLessThanOrEqual(700);
    expect(card.taskStatus).toBe('budget');
    expect(firstLine(card.text).startsWith('ℹ CURRENT TASK')).toBe(true);
  });

  it('role 지정이 없으면 no_block 이어도 경고 없음(기존 동작)', () => {
    const { role: _r, ...plain } = TASK;
    const card = buildResumeCard(project({ '.ralph/fix_plan.md': NO_SECTION }, [STOP, plain]), 3200)!;
    expect(card.taskStatus).toBeUndefined();
    expect(card.text).not.toContain('CURRENT TASK');
    expect(firstLine(card.text)).toMatch(/^## Resume card/);
    expect(card.text).toContain('NOT READ (block not found)');           // 원천 줄의 표시는 그대로
  });

  it('첫 current-task 원천만 본다 · 모르는 role 은 원천을 살리고 role 만 버린다', () => {
    const dir = project({ '.ralph/fix_plan.md': NO_SECTION, 'b.md': ACTIVE }, [
      { path: 'b.md', block: '지금 할 일', role: 'curent-task' },      // 오타 — 원천은 남는다
      TASK,
      { path: 'b.md', block: '지금 할 일', role: 'current-task' },
    ]);
    const decl = readContinuityDeclaration(dir);
    expect(decl.sources).toHaveLength(3);
    expect(decl.sources[0].role).toBeUndefined();
    expect(decl.invalid.join()).toContain('role "curent-task" ignored');
    const card = buildResumeCard(dir, 3200)!;
    expect(card.taskStatus).toBe('no_block');                              // 두 번째(첫 current-task) 기준
  });

  it('모든 예산 경계에서 카드 상한 유지 · 경고/안내가 있으면 언제나 첫 줄 · ok 원천 발췌는 원문 앞부분', () => {
    const files = { '.ralph/fix_plan.md': NO_SECTION, 'docs/INDEX.md': INDEX, '.ralph/DEMO_STOP': '정지 — 사람 확인 대기\n' };
    for (let b = 400; b <= 3200; b += 97) {
      const card = buildResumeCard(project(files, [STOP, TASK, IDX]), b)!;
      expect(card.text.length, `budget ${b}`).toBeLessThanOrEqual(b);
      expect(['no_block', 'budget'], `budget ${b}`).toContain(card.taskStatus);
      expect(/^(⚠|ℹ) CURRENT TASK/.test(firstLine(card.text)), `budget ${b}`).toBe(true);
      for (const it of card.items.filter(i => i.outcome === 'ok')) {
        const src = (files as Record<string, string>)[it.path];
        const body = (it.excerpt ?? '').replace(/…$/, '');
        expect(src.replace(/\r/g, '').includes(body), `${it.path} @${b}`).toBe(true);
      }
    }
  });
});
