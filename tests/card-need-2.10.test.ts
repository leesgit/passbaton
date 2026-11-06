// 2.10 — 원천별 필요(need) 판정·생략량·본문 몫 예약 (Astra P5 reply-5 C1 · Ashfall P5-04)
//
// 계약: 최소 줄 수만으로 충분성을 말하지 않는다. 선언한 표 데이터 행·필수 낱말이 **보인 발췌에** 있어야 「need met」.
//   표 머리·구분 줄만 = 데이터 행 0 = INSUFFICIENT · 빈 표 = INSUFFICIENT · 필수 낱말이 예산 밖 = INSUFFICIENT.
//   잘린 원천은 생략량(줄·글자)을 적는다 · need.chars 는 총예산 안에서 다른 원천 몫을 줄여 마련한다(총예산 불변).
//   판정을 선언하지 않은 원천에는 「충분」 도 「부족」 도 말하지 않는다.
// 역검증(일부러 깨뜨리면 빨개져야 하는 것): 긴 머리말 · 빈 표 · 필수 절 후순위 · 머리 행을 데이터로 세기 · 총예산 초과.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildResumeCard, readContinuityDeclaration } from '../src/utils/resume-card.js';

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function project(files: Record<string, string>, sources: unknown[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-210need-')));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources } }));
  return dir;
}

const row = (id: string, n: number) => `| ${id} | ${'처분 설명 '.repeat(n)} | 원문 | 재개 조건 |`;
// Ashfall INDEX 모양 — 짧은 머리 + 긴 행
const INDEX = ['# 색인', '', '## 활성 처분', '', '| ID | 처분 | 원문 | 재개 |', '|---|---|---|---|', row('AN1', 80), row('AN2', 80), row('AN3', 80), ''].join('\n');
const filler = (label: string, n: number) => Array.from({ length: n }, (_, i) => `- ${label} ${i} ${'나'.repeat(70)}`).join('\n');

describe('2.10 need — rows', () => {
  it('a table header alone is insufficient (the 2.9 Ashfall INDEX shape)', () => {
    const dir = project({ 'INDEX.md': INDEX, 'H.md': filler('h', 40), 'F.md': filler('f', 40) }, [
      { path: 'F.md', lines: 40 }, { path: 'INDEX.md', block: '활성 처분', need: { rows: 1 } }, { path: 'H.md', lines: 40 },
    ]);
    const card = buildResumeCard(dir, 1400)!;
    const it = card.items[1];
    expect(it.outcome).toBe('ok');
    // 전제 — 머리는 보였고 데이터 행은 안 보였다
    expect(it.excerpt).toContain('| ID |');
    expect(it.excerpt).not.toContain('| AN1 |');
    expect(it.need).toMatchObject({ met: false, rowsShown: 0, rowsTotal: 3, rowsNeed: 1 });
    expect(card.text).toMatch(/⚠ INSUFFICIENT — table rows shown 0\/3 \(need 1\) — read `INDEX\.md:7-\d+` directly/);
    expect(card.insufficient).toEqual(['INDEX.md']);
  });

  it('need.chars reserves body room inside the same total budget so a data row is shown', () => {
    const files = { 'INDEX.md': INDEX, 'H.md': filler('h', 40), 'F.md': filler('f', 40) };
    const plain = buildResumeCard(project(files, [{ path: 'F.md', lines: 40 }, { path: 'INDEX.md', block: '활성 처분', need: { rows: 1 } }, { path: 'H.md', lines: 40 }]), 1400)!;
    const dir = project(files, [{ path: 'F.md', lines: 40 }, { path: 'INDEX.md', block: '활성 처분', need: { rows: 1, chars: 700 } }, { path: 'H.md', lines: 40 }]);
    const card = buildResumeCard(dir, 1400)!;
    expect(card.text.length).toBeLessThanOrEqual(1400);
    expect(card.items[1].excerpt).toContain('| AN1 |');
    expect(card.items[1].need).toMatchObject({ met: true, rowsTotal: 3 });
    expect(card.items[1].need!.rowsShown).toBeGreaterThanOrEqual(1);
    expect(card.text).toMatch(/need met \(table rows [1-3]\/3\)/);
    expect(card.insufficient).toEqual([]);
    // 예약은 다른 원천 몫에서 나온다 — 총예산은 늘지 않는다
    expect((card.items[0].excerpt ?? '').length).toBeLessThan((plain.items[0].excerpt ?? '').length);
  });

  it('an empty table (header + separator only) is insufficient even when fully shown', () => {
    const empty = ['## 활성 처분', '', '| ID | 처분 |', '|---|---|', ''].join('\n');
    const dir = project({ 'INDEX.md': empty }, [{ path: 'INDEX.md', block: '활성 처분', need: { rows: 1 } }]);
    const card = buildResumeCard(dir, 3200)!;
    expect(card.items[0].truncated).toBe(false);
    expect(card.items[0].need).toMatchObject({ met: false, rowsShown: 0, rowsTotal: 0 });
    expect(card.text).toContain('⚠ INSUFFICIENT — no table data rows in the range (need 1) — read `INDEX.md:1-4` directly');
  });

  it('a long preamble before the table pushes the rows out — insufficient, not read-as-ok', () => {
    const pre = ['## 활성 처분', '', ...Array.from({ length: 12 }, (_, i) => `> 머리말 ${i} ${'다'.repeat(60)}`), '', '| ID | 처분 |', '|---|---|', '| R1 | x |', ''].join('\n');
    const dir = project({ 'INDEX.md': pre }, [{ path: 'INDEX.md', block: '활성 처분', need: { rows: 1 } }]);
    const card = buildResumeCard(dir, 600)!;
    expect(card.items[0].outcome).toBe('ok');
    expect(card.items[0].excerpt).not.toContain('| R1 |');
    expect(card.items[0].need?.met).toBe(false);
    expect(card.text).toContain('⚠ INSUFFICIENT — table rows shown 0/1 (need 1)');
  });

  it('rows inside a code fence are not table rows', () => {
    const fenced = ['## 활성 처분', '```', '| ID | 처분 |', '|---|---|', '| R1 | x |', '```', ''].join('\n');
    const dir = project({ 'INDEX.md': fenced }, [{ path: 'INDEX.md', block: '활성 처분', need: { rows: 1 } }]);
    expect(buildResumeCard(dir, 3200)!.items[0].need).toMatchObject({ met: false, rowsTotal: 0 });
  });
});

describe('2.10 need — items and omission', () => {
  it('a required item placed late (past the budget) is insufficient and names the next place to read', () => {
    const body = ['## 지금 할 일', '', filler('x', 30), '- [ ] **P-NEXT** 현재 항목', ''].join('\n');
    const dir = project({ 'plan.md': body }, [{ path: 'plan.md', block: '지금 할 일', need: { items: ['P-NEXT'] } }]);
    const card = buildResumeCard(dir, 900)!;
    const it = card.items[0];
    expect(it.truncated).toBe(true);
    expect(it.need).toMatchObject({ met: false, missing: ['P-NEXT'] });
    expect(card.text).toMatch(/⚠ INSUFFICIENT — not shown: "P-NEXT" — read `plan\.md:\d+-\d+` directly/);
    expect(it.omitted!.lines).toBeGreaterThan(0);
    expect(it.omitted!.chars).toBeGreaterThan(0);
    expect(card.text).toMatch(/omitted \d+ line\(s\) \/ \d+ chars/);
  });

  it('the same item shown early is met', () => {
    const body = ['## 지금 할 일', '- [ ] **P-NEXT** 현재 항목', filler('x', 30), ''].join('\n');
    const dir = project({ 'plan.md': body }, [{ path: 'plan.md', block: '지금 할 일', need: { items: ['P-NEXT'] } }]);
    const card = buildResumeCard(dir, 900)!;
    expect(card.items[0].need).toMatchObject({ met: true, missing: [] });
    expect(card.text).not.toContain('INSUFFICIENT');
  });

  it('omitted chars add up to the selected range; the card text shows them only for a source with a need', () => {
    const body = filler('y', 20);
    const dir = project({ 'P.md': body }, [{ path: 'P.md', lines: 20 }]);
    const card = buildResumeCard(dir, 700)!;
    const it = card.items[0];
    const shown = (it.excerpt ?? '').length - (it.sliced ? 1 : 0);
    expect(shown + it.omitted!.chars).toBe(body.length);
    // 선언 없는 원천의 카드 글은 2.9 와 같다(메타·items 에만 생략량)
    expect(card.text).not.toContain('omitted ');
  });

  it('a missing source with a declared need is insufficient (optional does not make it enough)', () => {
    const dir = project({}, [{ path: 'STOP', lines: 3, optional: true, need: { items: ['x'] } }]);
    const card = buildResumeCard(dir, 3200)!;
    expect(card.text).toContain('file absent (optional source — not an error)');
    expect(card.text).toContain('⚠ INSUFFICIENT — source not read (file not found)');
    expect(card.insufficient).toEqual(['STOP']);
  });

  it('a source hidden by the budget keeps its need unmet', () => {
    const dir = project({ 'A.md': filler('a', 40), 'B.md': filler('b', 40), 'C.md': filler('c', 40) }, [
      { path: 'A.md', lines: 40 }, { path: 'B.md', lines: 40 }, { path: 'C.md', lines: 40, need: { items: ['c 0'] } },
    ]);
    // 400 자 = 원천 1 개만 들어간다 — C.md 는 카드에서 빠진다(빠진 것도 「충분」 이 아니다)
    const card = buildResumeCard(dir, 400)!;
    expect(card.text.length).toBeLessThanOrEqual(400);
    expect(card.insufficient).toContain('C.md');
    // 원천이 카드에 들어갔지만 본문이 예산으로 숨겨진 경우
    const dir2 = project({ 'A.md': filler('a', 40), 'C.md': filler('c', 40) }, [
      { path: 'A.md', lines: 40 }, { path: 'C.md', lines: 40, need: { items: ['c 39'] } },
    ]);
    const card2 = buildResumeCard(dir2, 700)!;
    expect(card2.items).toHaveLength(2);
    expect(card2.insufficient).toEqual(['C.md']);
  });
});

describe('2.10 need — declaration', () => {
  it('without a judged need the card says neither met nor insufficient', () => {
    const dir = project({ 'INDEX.md': INDEX }, [{ path: 'INDEX.md', block: '활성 처분' }]);
    const card = buildResumeCard(dir, 3200)!;
    expect(card.text).not.toMatch(/need met|INSUFFICIENT/);
    expect(card.insufficient).toBeUndefined();
  });

  it('a malformed need is dropped whole with a note, the source stays', () => {
    for (const bad of [{ rows: 0 }, { rows: 1.5 }, { items: [] }, { items: [''] }, { chars: 10 }, { rows: 1, extra: 1 }, [], 'x', {}]) {
      const decl = readContinuityDeclaration(project({ 'I.md': INDEX }, [{ path: 'I.md', need: bad }]));
      expect(decl.sources).toHaveLength(1);
      expect(decl.sources[0].need).toBeUndefined();
      expect(decl.invalid.join('|')).toMatch(/need ignored/);
    }
  });

  it('a reservation that cannot fit the total budget is dropped with a note (no partial reservation)', () => {
    const dir = project({ 'A.md': filler('a', 40), 'B.md': filler('b', 40) }, [{ path: 'A.md', lines: 40, need: { chars: 8000 } }, { path: 'B.md', lines: 40 }]);
    const card = buildResumeCard(dir, 1200)!;
    expect(card.invalid.join('|')).toMatch(/need\.chars 8000 ignored/);
    expect(card.text.length).toBeLessThanOrEqual(1200);
  });
});
