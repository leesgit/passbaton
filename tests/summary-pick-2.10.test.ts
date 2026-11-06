// 2.10 — Stop 요약 고르기 규칙 (Astra P5 reply-5 C2 · Ashfall P5-05)
//
// 계약: 제목형 문구만 있으면 상태 미확인(null) · 명시적 상태 줄 우선(+ 차단 사유) · 문장 머리의 완료 문장만 ·
//   마지막 단락 우선 규칙 없음 — 질문·미래 계획·인용문은 현재 상태가 아니다 · 원문 줄 번호를 돌려준다.
// 실측 결함(Ashfall DB 2026-11-06~07 · 직접 재현): 「Astra의 총평」(제목) · 「fixed before committing**」 ·
//   「updated row L-65 in the monorepo `docs/passbaton-ledger.」(문장 한가운데 동사 + 첫 마침표에서 자름).

import { describe, it, expect } from 'vitest';
import { pickSummary, basisLabel } from '../src/utils/summary-pick.js';

describe('2.10 pickSummary — 실측 결함', () => {
  it('a heading-only reply is not a state (was stored as 「Astra의 총평」)', () => {
    expect(pickSummary('## Astra의 총평\n\n| 항목 | 점수 |\n|---|---|\n| C1 | 7 |\n')).toBeNull();
  });

  it('a completion verb in the middle of a sentence is not picked; a later completion sentence does not outrank the first statement', () => {
    const text = [
      'P5-04 is done. The resume card can now say when a source did not deliver the content it needs.',
      '',
      '- **Ashfall a9901096:** docs and ledger. I also updated row L-65 in the monorepo `docs/passbaton-ledger.md`, written but not committed.',
    ].join('\n');
    const p = pickSummary(text)!;
    expect(p.kind).toBe('sentence');
    // 짧은 첫 문장은 같은 줄의 다음 문장과 함께
    expect(p.text).toBe('P5-04 is done. The resume card can now say when a source did not deliver the content it needs.');
    expect(p.line).toBe(1);
    expect(p.text).not.toMatch(/^updated row/);
  });

  it('a mistake list ending in 「fixed before committing」 does not become the summary', () => {
    const text = 'Three mistakes in my own setup, all fixed before committing**.\n\nP5-03 passed: the installed 2.9.0 dist runs the suites.';
    expect(pickSummary(text)!.text).not.toBe('fixed before committing**');
    expect(pickSummary(text)!.text).toBe('Three mistakes in my own setup, all fixed before committing.');
  });

  it('a period inside a file name does not end the sentence', () => {
    const p = pickSummary('Fixed the parser in `docs/passbaton-ledger.md` so rows keep their order.')!;
    expect(p).toMatchObject({ kind: 'completion', text: 'Fixed the parser in docs/passbaton-ledger.md so rows keep their order.' });
  });
});

describe('2.10 pickSummary — 명시적 상태 우선', () => {
  it('an explicit status line wins over earlier prose, label kept, blocked reason appended', () => {
    const text = [
      '정리했습니다. 아래를 보세요.',
      '',
      '- 현재 상태: **BLOCKED** — walk 표본 없음',
      '- 차단 사유: 상점 지붕이 문을 가린다',
      '- 다음 작업: 대화 세션 처분',
    ].join('\n');
    const p = pickSummary(text)!;
    expect(p).toMatchObject({ kind: 'status', line: 3 });
    expect(p.text).toBe('현재 상태: BLOCKED — walk 표본 없음 · 차단 사유: 상점 지붕이 문을 가린다');
  });

  it('a 「다음 작업」 line alone is not a current state', () => {
    const p = pickSummary('- 다음 작업: P5-06 을 시작한다\n')!;
    expect(p?.kind).not.toBe('status');
  });

  it('the RALPH_STATUS machine block is not used as the status line', () => {
    const text = 'P5-04 is done (commit 76b91a7).\n\n---RALPH_STATUS---\nSTATUS: IN_PROGRESS\nEXIT_SIGNAL: false\n---END_RALPH_STATUS---\n';
    expect(pickSummary(text)).toMatchObject({ kind: 'sentence', text: 'P5-04 is done (commit 76b91a7).', line: 1 });
  });

  it('a status line inside a code fence or a quote is not a status', () => {
    expect(pickSummary('```\n현재 상태: 통과\n```\n> 현재 상태: 통과\n')).toBeNull();
  });
});

describe('2.10 pickSummary — 마지막 단락을 현재 상태로 오인하지 않는다(역검증 사례)', () => {
  it('a reply that is only a question has no state', () => {
    expect(pickSummary('이 설정을 지금 적용할까요?\n\nShould I apply the config now?')).toBeNull();
  });

  it('a reply that is only a future plan has no state', () => {
    expect(pickSummary("I'll run the full suite next and report back.\n\n다음은 P5-06 을 진행하겠습니다.")).toBeNull();
  });

  it('a reply that is only a quote has no state', () => {
    expect(pickSummary('> 현재 상태: A 통과 — 인용한 이전 기록\n> P5-03 passed.\n')).toBeNull();
  });

  it('when the last paragraph is a question/plan, the earlier statement is the state', () => {
    const text = 'The card now flags missing table rows.\n\nNext I will look at the summary extractor.\n\nDo you want the config applied?';
    expect(pickSummary(text)).toMatchObject({ kind: 'sentence', text: 'The card now flags missing table rows.', line: 1 });
  });

  it('a bold-only paragraph label is not a statement', () => {
    expect(pickSummary('**What changed**\n\n**검증:**\n')).toBeNull();
  });
});

describe('2.10 basisLabel', () => {
  it('reads the stored basis and refuses unknown shapes', () => {
    expect(basisLabel(JSON.stringify({ role: 'assistant', msg: 'last', kind: 'status', line: 3, turn: 't1' }))).toBe('status line L3 of the last reply');
    expect(basisLabel(JSON.stringify({ role: 'assistant', msg: 'recent-2', kind: 'sentence', line: 1, turn: null }))).toBe('first statement L1 of reply 2 before the last');
    expect(basisLabel(null)).toBeNull();
    expect(basisLabel('not json')).toBeNull();
    expect(basisLabel(JSON.stringify({ kind: 'guess', line: 1 }))).toBeNull();
  });
});
