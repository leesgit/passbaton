// 2.7.2 — 재개 카드의 남는 예산을 잘린 원천에 한 번 균등 분배 (Astra reply-150 PB150-01·02)
//
// 근거(2026-10-23 실측): Ashfall 카드 3200 자 중 2390 만 썼다 — 없는 DEMO_STOP·짧은 원천의 몫을 버렸다.
// 계약: 기준 C0(기존 1~4 단계 끝) · R = budget − C0 · 본문 몫에 막힌 원천에만 R/대상 수 · 원문은 C0 를 앞에 그대로 ·
// 실제 렌더가 상한을 넘거나 읽기 사이 파일이 바뀌면 C0 전체로 · 대상당 추가 읽기 한 번.
// 역검증: 재분배 제거 → 「다음 데이터 행」 이 안 나와 빨강 · 상한 검사 제거 → 펜스가 커진 경계 입력에서 상한 초과로 빨강 ·
// 표 행 자르기 복원 → 반쪽 행으로 빨강 · 변경 감지 제거 → 섞인 판으로 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildResumeCard, readSource, type ContinuitySource } from '../src/utils/resume-card.js';

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function project(files: Record<string, string>, sources: ContinuitySource[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-272-')));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources } }));
  return dir;
}

/** 결정 색인 모양 — 데이터 행 R1..Rn (각 행 ~90 자) */
const indexMd = (n: number, cell = '재개 조건은 원문을 본다') =>
  ['# 색인', '', '## 활성 처분', '', '| ID | 처분 | 재개 조건 |', '|---|---|---|',
    ...Array.from({ length: n }, (_, i) => `| R${i + 1} | 처분 ${i + 1} 번 — 원천 예산 시험용 한 줄 | ${cell} ${i + 1} |`), ''].join('\n');
const IDX: ContinuitySource = { path: 'docs/INDEX.md', block: '활성 처분', label: '색인' };
const STOP: ContinuitySource = { path: '.ralph/DEMO_STOP', lines: 3, label: '정지 사유' };
const dataRows = (t: string) => t.split(/\r?\n/).filter(l => /^\| R\d+ \|/.test(l));

describe('PB150-01 정보가 실제로 는다 — 미리 정한 다음 데이터 행이 온전히', () => {
  it.each([
    ['없는 원천 + 잘린 색인', {} as Record<string, string>],
    ['짧은 원천 + 잘린 색인', { '.ralph/DEMO_STOP': '정지 — 사람 확인 대기\n' }],
  ])('%s', (_n, extra) => {
    const md = indexMd(20);
    const dir = project({ 'docs/INDEX.md': md, ...extra }, [STOP, IDX]);
    const c0 = buildResumeCard(dir, 900, { redistribute: false })!;
    const card = buildResumeCard(dir, 900)!;
    const before = dataRows(c0.text).length;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(20);                                  // C0 에서 색인이 잘린다
    const nextRow = md.split('\n').find(l => l.startsWith(`| R${before + 1} |`))!;
    expect(card.text.split('\n')).toContain(nextRow);                 // 다음 데이터 행 **전체**
    expect(card.redistribution).toMatchObject({ applied: true, targets: 1, extraReads: 1 });
    expect(card.text.length).toBeLessThanOrEqual(900);
    // NOT READ / 짧은 원천 표시는 그대로
    if (!extra['.ralph/DEMO_STOP']) expect(card.text).toContain('NOT READ (file not found)');
    else expect(card.text).toContain('정지 — 사람 확인 대기');
  });
});

describe('PB150-01 원문 보존 — C0 발췌가 앞에 그대로', () => {
  it('세 원천이 잘린 경우 모든 확장 발췌가 C0 발췌(프로그램 「…」 제외)로 시작 · 대상당 추가 읽기 한 번', () => {
    const long = (tag: string) => Array.from({ length: 60 }, (_, i) => `${tag} ${i} — 이 줄은 원천 예산 시험용으로 조금 길게 쓴 문장입니다 …`).join('\n');
    const srcs: ContinuitySource[] = [STOP, { path: 'a.md', lines: 60, label: 'A' }, { path: 'b.md', lines: 60, label: 'B' }, IDX];
    const dir = project({ 'a.md': long('a'), 'b.md': long('b'), 'docs/INDEX.md': indexMd(30) }, srcs);
    const c0 = buildResumeCard(dir, 2400, { redistribute: false })!;
    const card = buildResumeCard(dir, 2400)!;
    expect(card.redistribution?.applied).toBe(true);
    expect(card.redistribution?.extraReads).toBe(card.redistribution?.targets);
    for (const [i, it] of card.items.entries()) {
      const was = c0.items[i];
      if (was.outcome !== 'ok') { expect(it.outcome).toBe(was.outcome); continue; }
      const kept = was.sliced ? was.excerpt!.slice(0, -1) : was.excerpt!;
      expect(it.excerpt!.startsWith(kept), it.label).toBe(true);
      expect((it.excerpt ?? '').length).toBeGreaterThanOrEqual((was.excerpt ?? '').length);
      if (it.truncated) expect(card.text).toContain(`truncated — shown to line ${it.shownTo}`);
    }
    // 원문 끝의 「…」 는 원문이다 — 잘리지 않고 보인 줄에는 그대로 남는다
    expect(card.text).toContain('조금 길게 쓴 문장입니다 …');
  });
});

describe('PB150-02 경계 — 상한 · 표 행 · 표시', () => {
  it.each([400, 800, 1600, 3200])('긴 첫 원천 · CRLF · 긴 표 행 · 네 원천 모두 긴 경우도 상한 %i 이하', (budget) => {
    const crlf = Array.from({ length: 80 }, (_, i) => `c ${i} ${'가'.repeat(i % 7 === 0 ? 300 : 40)}`).join('\r\n');
    const wideIdx = indexMd(30, '긴 칸 '.repeat(40));
    const srcs: ContinuitySource[] = [{ path: 'first.md', lines: 80, label: '긴 첫' }, { path: 'crlf.md', lines: 80, label: 'CRLF' }, IDX, { path: 'more.md', lines: 80, label: '또' }];
    const dir = project({ 'first.md': '가'.repeat(5000) + '\n' + crlf, 'crlf.md': crlf, 'docs/INDEX.md': wideIdx, 'more.md': crlf }, srcs);
    const card = buildResumeCard(dir, budget)!;
    expect(card.text.length).toBeLessThanOrEqual(budget);
    expect(card.text).not.toContain('\r');
    for (const l of card.text.split('\n').filter(x => x.startsWith('| R'))) expect(l.trimEnd(), '반쪽 표 행').toMatch(/\|$/);
  });

  it('다음 표 행이 몫보다 크면 행이 늘지 않고 「truncated」 가 남는다(반쪽 행 없음)', () => {
    const md = indexMd(12, '아주 긴 칸 '.repeat(220));              // 행마다 ~1,400 자 — 남는 몫보다 크다
    const dir = project({ 'docs/INDEX.md': md }, [STOP, IDX]);
    const c0 = buildResumeCard(dir, 1000, { redistribute: false })!;
    const card = buildResumeCard(dir, 1000)!;
    expect(dataRows(card.text).length).toBe(dataRows(c0.text).length);
    for (const l of dataRows(card.text)) expect(l.trimEnd()).toMatch(/\|$/);
    expect(card.text).toMatch(/truncated — shown to line \d+/);
    expect(card.text.length).toBeLessThanOrEqual(1000);
  });

  it('실제 렌더가 상한을 넘는 경계(늘린 발췌 때문에 펜스가 길어짐) → C0 전체로 복귀', () => {
    // C0 에서 보이는 짧은 줄 뒤에 백틱 12 개 줄 — 늘리면 펜스가 ``` → 13 개로 커져 양쪽 +20 자
    const body = [...Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(4, '0')}`), '````````````', ...Array.from({ length: 200 }, (_, i) => `tail-${String(i).padStart(4, '0')}`)].join('\n');
    const src: ContinuitySource = { path: 'f.md', lines: 200, label: 'F' };
    // 예산을 찾는다: C0 가 백틱 줄 직전에서 멈추고, 남는 몫이 백틱 줄 이후를 꽉 채울 만큼인 지점
    let found = false;
    for (let budget = 700; budget <= 1400 && !found; budget += 7) {   // 700 미만은 원천이 하나만 들어간다(fit = budget/340)
      const dir = project({ 'f.md': body, '.ralph/DEMO_STOP': 'x\n' }, [STOP, src]);
      const c0 = buildResumeCard(dir, budget, { redistribute: false })!;
      const f0 = c0.items[1];
      if (!f0?.excerpt || f0.excerpt.includes('````') || !f0.budgetLimited) continue;
      const card = buildResumeCard(dir, budget)!;
      if (card.redistribution?.why !== 'rendered card would exceed the budget') continue;
      found = true;
      expect(card.redistribution.applied).toBe(false);
      expect(card.text).toBe(c0.text);                                  // C0 그대로 — 다른 원천을 줄여 맞추지 않는다
      expect(card.text.length).toBeLessThanOrEqual(budget);
    }
    expect(found, '복귀 분기를 실제로 지나는 경계 입력을 찾지 못했다').toBe(true);
  });
});

describe('PB150-02 읽기 일관성 — 두 읽기 사이 파일이 바뀌면 C0', () => {
  it.each(['바뀜', '지워짐'] as const)('파일이 %s → 확장 버림 · C0 그대로', (kind) => {
    const dir = project({ 'docs/INDEX.md': indexMd(20) }, [STOP, IDX]);
    const c0 = buildResumeCard(dir, 900, { redistribute: false })!;
    const card = buildResumeCard(dir, 900, {
      readExtra: (p, s, n) => {
        const f = path.join(p, s.path);
        if (kind === '바뀜') fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace('| R1 |', '| R1x |'));
        else fs.rmSync(f);
        return readSource(p, s, n);
      },
    })!;
    expect(card.redistribution).toMatchObject({ applied: false, extraReads: 1 });
    expect(card.text).toBe(c0.text);
  });
});
