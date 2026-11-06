// 2.10 — 선언된 원천의 시각 경과(ages)와 상태 낱말 수(tally) (Astra P5 reply-5 C4·C7 · Ashfall P5-02)
//
// 계약: 둘 다 opt-in · 원문을 바꾸지 않는다 · 이름은 파일이 붙인 낱말 그대로(지어내지 않음) ·
// ages = 보인 발췌의 오프셋 있는 시각만 · 카드 시각 기준 · 미래 시각은 「ahead of card time」(0 으로 숨기지 않음) ·
// tally = 선택 범위 전체(예산으로 잘린 부분 포함) · 모양이 틀리면 원천을 살리고 그 선택만 버린다.
// 역검증: 보인 부분만 세는 tally · 미래 시각을 +0.0h 로 내는 ages · 이름 없는 시각에 이름 붙이기 → 아래 기대값이 빨개진다.

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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-210at-')));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources } }));
  return dir;
}

const PENDING = [
  '# Astra 요청 상태',
  '# 장부 · generation 256',
  '',
  '- packet-263 · JSON 없음 — 수동 판단 대기 · 요청 2026-11-06T16:34+09:00 · 변경 2026-11-06T16:37+09:00 · 세대 1',
  '',
].join('\n');
// 2026-11-07T03:37+09:00 = 변경 뒤 11.0 h · 요청 뒤 11.05 h
const NOW = Date.parse('2026-11-07T03:37:00+09:00');

const DECISIONS = [
  '# 결정 카드',
  '',
  '## 결정 항목',
  '',
  // 상태 낱말은 블록 **끝**에 둔다 — 예산이 앞부분만 보여 줘도 세어져야 한다(보인 부분만 세면 0 이 된다)
  ...Array.from({ length: 20 }, (_, i) => `${i + 1}. 긴 설명 ${'가'.repeat(80)} → **${i >= 16 && i < 19 ? '준비 필요' : i === 19 ? '결과 대기' : '기록만'}**`),
  '',
].join('\n');

describe('2.10 ages', () => {
  it('names each stamp by the word the file put before it and ages it from card time', () => {
    const dir = project({ 'docs/PENDING': PENDING }, [{ path: 'docs/PENDING', lines: 6, label: '요청', ages: true }]);
    const card = buildResumeCard(dir, 3200, { now: NOW })!;
    expect(card.text).toContain('ages at card time 2026-11-06T18:37Z: L4 요청 +11.1h · L4 변경 +11.0h');
    // 원문은 그대로
    expect(card.text).toContain(PENDING.split('\n')[3]);
  });

  it('is off unless declared — the card has no ages line', () => {
    const dir = project({ 'docs/PENDING': PENDING }, [{ path: 'docs/PENDING', lines: 6 }]);
    expect(buildResumeCard(dir, 3200, { now: NOW })!.text).not.toContain('ages at card time');
  });

  it('a stamp after card time is shown as ahead, not +0.0h', () => {
    const dir = project({ 'docs/PENDING': PENDING }, [{ path: 'docs/PENDING', lines: 6, ages: true }]);
    const card = buildResumeCard(dir, 3200, { now: Date.parse('2026-11-06T16:00:00+09:00') })!;
    expect(card.text).toContain('L4 요청 ahead of card time (clock?)');
    expect(card.text).not.toMatch(/요청 \+0\.0h/);
  });

  it('does not invent a name, and skips stamps without an offset', () => {
    const body = ['- a · 2026-11-06T16:34+09:00 · x', '- b 2026-11-06T16:34 local only', ''].join('\n');
    const dir = project({ 'P.md': body }, [{ path: 'P.md', lines: 5, ages: true }]);
    const text = buildResumeCard(dir, 3200, { now: NOW })!.text;
    expect(text).toContain('L1 (unnamed) +11.1h');
    expect(text).not.toContain('L2 ');
  });
});

describe('2.10 tally', () => {
  it('counts the whole selected range even when the card budget cuts the excerpt', () => {
    const dir = project({ 'card.md': DECISIONS }, [{ path: 'card.md', block: '결정 항목', tally: ['준비 필요', '응답 대기', '결과 대기'] }]);
    const card = buildResumeCard(dir, 800, { now: NOW })!;
    expect(card.items[0].truncated).toBe(true);
    // 전제 확인 — 상태 낱말이 든 줄은 이 카드에 안 보인다
    expect(card.items[0].excerpt).not.toContain('준비 필요');
    expect(card.items[0].excerpt).not.toContain('결과 대기');
    expect(card.text).toContain('tally (whole range) 준비 필요 3 · 응답 대기 0 · 결과 대기 1');
  });

  it('a malformed option is dropped with a note, the source stays', () => {
    const dir = project({ 'docs/PENDING': PENDING }, [{ path: 'docs/PENDING', lines: 6, ages: 'yes', tally: [] }]);
    const decl = readContinuityDeclaration(dir);
    expect(decl.sources).toHaveLength(1);
    expect(decl.sources[0].ages).toBeUndefined();
    expect(decl.sources[0].tally).toBeUndefined();
    expect(decl.invalid.join('|')).toMatch(/ages .*ignored/);
    expect(decl.invalid.join('|')).toMatch(/tally ignored/);
  });
});
