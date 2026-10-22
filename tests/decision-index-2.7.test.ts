// 2.7 — 결정 색인을 기존 재개 카드로 전달 (Astra reply-147 PB139-13)
//
// 색인은 원문을 **찾게** 하는 자료다. passbaton 은 결정의 유효성을 판정하지 않는다 — 대신 두 가지를 지킨다.
//   ① 카드가 색인 행을 반쪽으로 자르지 않는다(「재개 조건」 칸 앞에서 잘린 행은 온전한 결정처럼 읽힌다)
//   ② `block` 으로 활성 처분 절만 실으면 무효·대체된 답신은 카드에 「활성」 으로 들어오지 않는다
// 역검증(reply-147): 미니맵 조건 미충족 · 무효 첫 답 · 유효 정정을 함께 둔 예제로 — 표 행 자르기를 되살리거나,
// 예제에서 주체·원문·재개 조건을 지우거나, 무효 답을 활성 절에 넣으면 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildResumeCard, readSource } from '../src/utils/resume-card.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'decision-index');
const INDEX = path.join(FIXTURE, 'docs', 'INDEX.md');

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/** 예제를 임시 프로젝트로 복사 — 시험이 레포 안 파일을 건드리지 않게 */
function project(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-27i-')));
  tmps.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
function section(md: string, heading: string): string[] {
  // Windows CI 체크아웃은 CRLF 다(autocrlf) — 줄 끝 \r 이 남으면 구분선을 데이터 행으로 읽는다
  const lines = md.split(/\r?\n/);
  const i = lines.findIndex(l => l.startsWith('## ') && l.includes(heading));
  const rest = lines.slice(i + 1);
  const end = rest.findIndex(l => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter(l => /^\|/.test(l) && !/^\|[-|\s]+\|$/.test(l)).slice(1);
}

describe('PB139-13 예제 색인 자체의 계약', () => {
  const md = fs.readFileSync(INDEX, 'utf-8');
  const active = section(md, '활성 처분').map(cells);
  const excluded = section(md, '제외').map(cells);

  it('활성 처분 행은 8 칸이 모두 차 있다 — 주체·원문·재개 조건을 비우지 않는다', () => {
    expect(active.length).toBeGreaterThanOrEqual(3);
    for (const r of active) {
      expect(r, r[0]).toHaveLength(8);
      for (const c of r) expect(c, `${r[0]} 빈 칸`).not.toBe('');
    }
  });

  it('무효 첫 답은 활성 절에 없고 제외 절에 사유·대체 위치와 함께 있다 · 대체 위치는 활성 행의 원문이다', () => {
    expect(excluded.length).toBeGreaterThanOrEqual(1);
    for (const [orig, why, repl] of excluded) {
      const origLoc = orig.split(' ')[0];
      expect(active.some(r => r[3].startsWith(origLoc)), `${origLoc} 가 활성 원문`).toBe(false);
      expect(why).not.toBe('');
      expect(active.some(r => r[3].startsWith(repl)), `${repl} 를 원문으로 둔 활성 행`).toBe(true);
    }
  });

  it('미충족 조건이 있는 보류 항목(미니맵)이 재개 조건과 함께 실려 있다', () => {
    const mm = active.find(r => r[1].includes('미니맵'));
    expect(mm?.[4]).toContain('게이트');
    expect(mm?.[5]).not.toBe('—');
  });
});

describe('PB139-13 카드로 전달', () => {
  it('block 「활성 처분」 → 활성 행 전부(ID·주체·원문·재개 조건) · 제외 절과 무효 사유는 안 실린다', () => {
    const card = buildResumeCard(project(), 3200)!;
    expect(card.anyRead).toBe(true);
    for (const id of ['N146', 'MM-02', 'PB-07']) expect(card.text).toContain(`| ${id} |`);
    expect(card.text).toContain('Astra 위임');
    expect(card.text).toContain('reply-132.md:70-81 (정정 절)');
    expect(card.text).toContain('N146 정리 + 미니맵 판독 게이트 초록');
    expect(card.text).not.toContain('6000 자');
    expect(card.text).not.toContain('제외 — 무효');
    expect(card.text).not.toContain('matches — first heading');   // 활성 절 제목이 모호하지 않다
  });

  it('예산이 행 중간에서 끝나면 그 행을 통째로 뺀다 — 보이는 표 행은 모두 온전하고 잘렸다고 적는다', () => {
    const dir = project();
    const full = readSource(dir, { path: 'docs/INDEX.md', block: '활성 처분' }, 100000);
    const rows = full.excerpt!.split('\n');
    const upTo = rows.findIndex(l => l.includes('| MM-02 |'));
    // MM-02 행의 「재개 조건」 칸 한가운데에서 예산이 끝나게
    const budget = rows.slice(0, upTo).join('\n').length + 1 + rows[upTo].indexOf('미니맵 판독') + 4;
    const cut = readSource(dir, { path: 'docs/INDEX.md', block: '활성 처분' }, budget);
    expect(cut.truncated).toBe(true);
    expect(cut.excerpt).toContain('| N146 |');
    expect(cut.excerpt).not.toContain('MM-02');
    for (const l of cut.excerpt!.split('\n').filter(x => x.startsWith('|'))) expect(l.trimEnd(), l).toMatch(/\|$/);
  });

  it('CRLF 색인도 같다 — 활성 행 전부 · 제외 절 없음 · 행 중간에서 안 자름', () => {
    const dir = project();
    const p = path.join(dir, 'docs', 'INDEX.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace(/\r?\n/g, '\r\n'));
    const card = buildResumeCard(dir, 3200)!;
    for (const id of ['N146', 'MM-02', 'PB-07']) expect(card.text).toContain(`| ${id} |`);
    expect(card.text).not.toContain('\r');
    expect(card.text).not.toContain('6000 자');
    const full = readSource(dir, { path: 'docs/INDEX.md', block: '활성 처분' }, 100000);
    const rows = full.excerpt!.split('\n');
    const upTo = rows.findIndex(l => l.includes('| MM-02 |'));
    const cut = readSource(dir, { path: 'docs/INDEX.md', block: '활성 처분' }, rows.slice(0, upTo).join('\n').length + 30);
    expect(cut.truncated).toBe(true);
    expect(cut.excerpt).not.toContain('MM-02');
  });

  it('표가 아닌 긴 줄은 예전처럼 잘라서라도 보인다(빈 발췌 방지 규칙 유지)', () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'docs', 'NOTE.md'), '# 메모\n' + '가'.repeat(400) + '\n');
    const r = readSource(dir, { path: 'docs/NOTE.md', lines: 5 }, 120);
    expect(r.truncated).toBe(true);
    expect(r.excerpt).toMatch(/가…$/);
  });
});
