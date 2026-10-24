// 2.7.3 — 재개 카드 원천의 `optional` (Astra reply-165 PB165-100)
//
// 계약: 명시적 `optional: true` **이고 파일이 없을 때만** ⚠ NOT READ 대신 중립 「file absent」 줄 · 기본 동작(미지정·false)은 그대로 ·
// 경로 경계 거부·비밀 이름·일반 파일 아님·끊어진 링크·블록 없음·빈 범위·잘림은 optional 이어도 숨기지 않는다 ·
// 없는 선택 원천은 anyRead 성공으로 세지 않는다 · 불리언이 아닌 값은 invalid(원천은 살리고 optional 만 버림).
// 역검증(reply-165 §1 100): 읽기 거부를 정상 부재로 바꾸면 빨강 · 부재를 읽음으로 세면 빨강 · 문자열 "true" 를 받아들이면 빨강.

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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-165o-')));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources } }));
  return dir;
}

const STOP = { path: '.ralph/DEMO_STOP', lines: 3, label: '정지 사유', optional: true };
const HANDOFF = { path: 'docs/HANDOFF.md', lines: 5, label: 'HANDOFF' };
const HANDOFF_BODY = '# 2026-10-24 — 최신 절\n\n- 다음 작업: N164-200\n';
const ABSENT = '### 정지 사유 — `.ralph/DEMO_STOP` · file absent (optional source — not an error)';
const line = (t: string, label: string) => t.split(/\r?\n/).find(l => l.startsWith(`### ${label} —`)) ?? '';

describe('PB165-100 optional 원천 — 파일 없음만 중립', () => {
  it('optional: true + 파일 없음 → 중립 줄 · ⚠ 없음 · 다른 원천은 그대로', () => {
    const card = buildResumeCard(project({ 'docs/HANDOFF.md': HANDOFF_BODY }, [STOP, HANDOFF]), 3200)!;
    expect(line(card.text, '정지 사유')).toBe(ABSENT);
    expect(card.text).not.toContain('NOT READ');
    expect(card.items[0].outcome).toBe('missing');                 // 상태는 그대로 missing — 표시만 다르다
    expect(card.anyRead).toBe(true);                               // HANDOFF 를 읽었기 때문이다
    expect(card.text).toContain('N164-200');
  });

  it('optional: true + 파일 있음 → 보통 원천처럼 본문', () => {
    const card = buildResumeCard(project({ '.ralph/DEMO_STOP': '정지 — 사람 확인 대기\n' }, [STOP]), 3200)!;
    expect(line(card.text, '정지 사유')).toMatch(/^### 정지 사유 — `\.ralph\/DEMO_STOP:1-1` \(of 1\) · sha1 /);
    expect(card.text).toContain('정지 — 사람 확인 대기');
    expect(card.anyRead).toBe(true);
  });

  it('기본 동작 유지 — optional 미지정·false 의 없는 파일은 ⚠ NOT READ (file not found)', () => {
    for (const s of [{ path: '.ralph/DEMO_STOP', lines: 3, label: '정지 사유' }, { ...STOP, optional: false }]) {
      const card = buildResumeCard(project({}, [s]), 3200)!;
      expect(line(card.text, '정지 사유')).toBe('### 정지 사유 — `.ralph/DEMO_STOP` · ⚠ NOT READ (file not found)');
    }
  });

  it('없는 선택 원천은 읽음으로 세지 않는다 — 혼자면 「none of the declared sources could be read」', () => {
    const card = buildResumeCard(project({}, [STOP]), 3200)!;
    expect(card.anyRead).toBe(false);
    expect(card.text).toContain('## Resume card — ⚠ none of the declared sources could be read');
    expect(line(card.text, '정지 사유')).toBe(ABSENT);
  });

  it('읽기 거부는 optional 이어도 ⚠ — 프로젝트 밖 · 비밀 이름 · 텍스트 아님 · 일반 파일 아님', () => {
    const cases: Array<[Record<string, string>, string, RegExp]> = [
      [{}, '../outside.md', /⚠ NOT READ \(outside the project\)/],
      [{ '.env.md': 'SECRET=1' }, '.env.md', /⚠ NOT READ \(name looks like a secret — not read\)/],
      [{}, '.env.missing.md', /⚠ NOT READ \(name looks like a secret — not read\)/],     // 없는 비밀 이름도 「없음」 이 아니라 거부
      [{ 'data.json': '{}' }, 'data.json', /⚠ NOT READ \(not a text source/],
      [{}, 'nofile.json', /⚠ NOT READ \(not a text source/],                            // 없어도 확장자 거부가 먼저
    ];
    for (const [files, p, want] of cases) {
      const card = buildResumeCard(project(files, [{ path: p, label: 'X', optional: true }]), 3200)!;
      const l = line(card.text, 'X');
      expect(l, p).toMatch(want);
      expect(l, p).not.toContain('file absent');
      expect(card.anyRead, p).toBe(false);
    }
    const dir = project({}, [{ path: 'plan.md', label: 'X', optional: true }]);
    fs.mkdirSync(path.join(dir, 'plan.md'));                                             // 폴더 — 일반 파일이 아니다
    expect(line(buildResumeCard(dir, 3200)!.text, 'X')).toBe('### X — `plan.md` · ⚠ NOT READ (not a regular file)');
  });

  it('블록 없음·빈 범위·잘림은 optional 이어도 그대로', () => {
    const noBlock = buildResumeCard(project({ 'a.md': '# a\n\n## 이력\n- x\n' }, [{ path: 'a.md', block: '지금 할 일', label: 'X', optional: true }]), 3200)!;
    expect(line(noBlock.text, 'X')).toBe('### X — `a.md` · ⚠ NOT READ (block not found)');
    const empty = buildResumeCard(project({ 'a.md': '\n\n\n' }, [{ path: 'a.md', lines: 3, label: 'X', optional: true }]), 3200)!;
    expect(line(empty.text, 'X')).toBe('### X — `a.md` · ⚠ NOT READ (selected range is empty)');
    const long = Array.from({ length: 40 }, (_, i) => `- 줄 ${i + 1} — 잘림 표시가 사라지면 안 되는 긴 본문`).join('\n');
    const cut = buildResumeCard(project({ 'a.md': long }, [{ path: 'a.md', lines: 40, label: 'X', optional: true }]), 600)!;
    expect(line(cut.text, 'X')).toMatch(/truncated — shown to line \d+/);
  });

  it('현재 작업(current-task) 경고는 optional 로 꺼지지 않는다', () => {
    const card = buildResumeCard(project({}, [{ path: '.ralph/fix_plan.md', block: '지금 할 일', role: 'current-task', optional: true }]), 3200)!;
    expect(card.taskStatus).toBe('missing');
    expect(card.text.split(/\r?\n/)[0]).toMatch(/^⚠ CURRENT TASK UNKNOWN — `\.ralph\/fix_plan\.md` not found/);
  });

  it('불리언이 아닌 optional → invalid 에 적고 원천은 살린다 · 없음은 ⚠ 로 남는다', () => {
    const dir = project({}, [{ ...STOP, optional: 'true' }, { path: 'b.md', label: 'B', optional: 1 }]);
    const decl = readContinuityDeclaration(dir);
    expect(decl.sources).toHaveLength(2);
    expect(decl.sources.every(s => s.optional === undefined)).toBe(true);
    expect(decl.invalid).toEqual(['.ralph/DEMO_STOP: optional "true" ignored', 'b.md: optional 1 ignored']);
    const card = buildResumeCard(dir, 3200)!;
    expect(line(card.text, '정지 사유')).toBe('### 정지 사유 — `.ralph/DEMO_STOP` · ⚠ NOT READ (file not found)');
    expect(card.text).toContain('⚠ ignored continuity entries: .ralph/DEMO_STOP: optional "true" ignored');
  });

  // 심볼릭 링크를 못 만드는 환경(Windows 일반 권한)에서는 건너뛴다
  const canLink = (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-165l-'));
    try { fs.symlinkSync(path.join(d, 'nowhere.md'), path.join(d, 'l.md'), 'file'); return true; } catch { return false; }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  })();
  it.skipIf(!canLink)('끊어진 링크는 「없음」 이 아니다 — optional 이어도 ⚠', () => {
    const dir = project({}, [{ path: 'gone.md', label: 'X', optional: true }]);
    fs.symlinkSync(path.join(dir, 'nowhere.md'), path.join(dir, 'gone.md'), 'file');
    const l = line(buildResumeCard(dir, 3200)!.text, 'X');
    expect(l).toBe('### X — `gone.md` · ⚠ NOT READ (file not found (dangling link))');
  });
});
