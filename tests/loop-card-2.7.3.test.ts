// 2.7.3 — loop 최소 카드 후보(기본 꺼짐) (Astra reply-154 PB154-C)
//
// 계약: 출처 = loop **그리고** 설정 opt-in(continuity.loopCard: "minimal") 일 때만 · fix_plan·HANDOFF 본문(role current-task·history)과
// Recent Sessions 를 빼되 정지 원천·각 원천의 경로·상태·「원천은 직접 읽어라」 안내·활성 처분 색인은 남긴다 ·
// no_block 경고 유지 · 원천 검사를 생략하지 않는다 · 일반 카드 회귀 없음.
// 역검증(reply-154 §4 C): DEMO_STOP·no_block·활성 처분을 각각 바꿈 → 해당 변화가 숨겨지면 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildResumeCard, readContinuityDeclaration } from '../src/utils/resume-card.js';
import { migrateSchema } from '../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const built = fs.existsSync(SESSION_START);

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const SOURCES = [
  { path: '.ralph/DEMO_STOP', lines: 3, label: '랄프 정지 사유(있으면)' },
  { path: '.ralph/fix_plan.md', block: '지금 할 일', label: 'fix_plan 지금 할 일', role: 'current-task' },
  { path: 'docs/astra/INDEX.md', block: '활성 처분', label: 'Astra 처분 색인' },
  { path: 'docs/HANDOFF.md', lines: 30, label: 'HANDOFF 최신 절', role: 'history' },
];
const PLAN = ['# fix_plan', '', '## 지금 할 일', '', '- [ ] **N153** 지도 깜빡임 — 촬영·판독 · 원문 reply-153 §2', '', '## 이력', '- [x] N150', ''].join('\r\n');
const INDEX = ['# 색인', '', '## 활성 처분', '', '| ID | 처분 | 재개 조건 |', '|---|---|---|', '| PB154 | passbaton 2.7.3 후보 | 사용자 배포 결정 |', '| H-152 | 미니맵 H 대기 | 사람 사진 |', '', '## 제외', '| X | 옛 답 |', ''].join('\r\n');
const HANDOFF = ['# HANDOFF', '', '## 2026-10-23 N153 진행', '- 촬영 3 장 판독 · 깜빡임 재현 실패', '- 다음: 셰이더 캐시 비교', ''].join('\r\n');

function project(files: Record<string, string>, extra: Record<string, unknown> = { loopCard: 'minimal' }, sources: unknown[] = SOURCES): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-273c-')));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources, ...extra } }));
  return dir;
}
const BASE = { '.ralph/fix_plan.md': PLAN, 'docs/astra/INDEX.md': INDEX, 'docs/HANDOFF.md': HANDOFF };

describe('PB154-C 최소 카드는 loop + opt-in 일 때만', () => {
  it('opt-in 이 있어도 출처가 unknown 이면 전체 카드(기본 · 회귀 없음)', () => {
    const dir = project(BASE);
    const full = buildResumeCard(dir, 3200)!;
    const unk = buildResumeCard(dir, 3200, { origin: 'unknown' })!;
    expect(unk.text).toBe(full.text);
    expect(unk.minimal).toBeUndefined();
    expect(unk.text).toContain('N153** 지도 깜빡임');
    expect(unk.text).toContain('셰이더 캐시 비교');
  });

  it('loop 여도 opt-in 이 없으면 전체 카드 — 출처만으로 줄이지 않는다', () => {
    const dir = project(BASE, {});
    const card = buildResumeCard(dir, 3200, { origin: 'loop' })!;
    expect(card.minimal).toBeUndefined();
    expect(card.text).toBe(buildResumeCard(dir, 3200)!.text);
  });

  it('loopCard 의 모르는 값은 무시하고 알린다', () => {
    const decl = readContinuityDeclaration(project(BASE, { loopCard: 'tiny' }));
    expect(decl.loopCard).toBeUndefined();
    expect(decl.invalid.join()).toContain('continuity.loopCard "tiny" ignored');
  });

  it('loop + opt-in → fix_plan·HANDOFF 본문만 빠지고 경로·범위·해시·상태·직접 읽기 안내는 남는다 · 색인은 본문까지', () => {
    const dir = project(BASE);
    const full = buildResumeCard(dir, 3200)!;
    const min = buildResumeCard(dir, 3200, { origin: 'loop' })!;
    expect(min.minimal).toBe(true);
    expect(min.text).not.toContain('N153** 지도 깜빡임');
    expect(min.text).not.toContain('셰이더 캐시 비교');
    expect(min.text).toContain('loop minimal');
    expect(min.text).toContain('read each source directly');
    for (const it of full.items.filter(i => i.outcome === 'ok')) {
      expect(min.text, it.path).toContain(`\`${it.path}:${it.from}-${it.to}\``);
      expect(min.text, it.path).toContain(`sha1 ${it.sha}`);                     // 원천 검사를 생략하지 않았다 — 같은 해시
    }
    expect(min.text).toMatch(/fix_plan 지금 할 일 — `\.ralph\/fix_plan\.md:3-6` .* · ok · body omitted \(loop card\) — read the source directly/);
    expect(min.text).toContain('| PB154 | passbaton 2.7.3 후보 | 사용자 배포 결정 |');
    expect(min.text).toContain('| H-152 | 미니맵 H 대기 | 사람 사진 |');
    expect(min.text).toContain('`.ralph/DEMO_STOP` · ⚠ NOT READ (file not found)');   // 정지 원천 상태
    expect(min.text.length).toBeLessThan(full.text.length);
  });

  it('DEMO_STOP 생김 → 최소 카드에 사유 본문이 그대로 보인다', () => {
    const dir = project({ ...BASE, '.ralph/DEMO_STOP': 'STOP — N153 사람 확인 대기 (H-152)\r\n' });
    const min = buildResumeCard(dir, 3200, { origin: 'loop' })!;
    expect(min.text).toContain('STOP — N153 사람 확인 대기 (H-152)');
    expect(min.text).not.toContain('DEMO_STOP` · ⚠ NOT READ');
  });

  it('작업 절 소실(no_block) → 최소 카드에서도 첫 줄 ⚠', () => {
    const dir = project({ ...BASE, '.ralph/fix_plan.md': '# fix_plan\r\n\r\n## 이력\r\n- [x] N150\r\n' });
    const min = buildResumeCard(dir, 3200, { origin: 'loop' })!;
    expect(min.taskStatus).toBe('no_block');
    expect(min.text.split(/\r?\n/)[0]).toMatch(/^⚠ CURRENT TASK UNKNOWN/);
    expect(min.text).toContain('`.ralph/fix_plan.md` · ⚠ NOT READ (block not found)');
  });

  it('활성 처분 변경 → 최소 카드에 새 행이 보인다', () => {
    const changed = INDEX.replace('| H-152 | 미니맵 H 대기 | 사람 사진 |', '| H-152 | 미니맵 H 대기 | 사람 사진 |\r\n| N154 | 셰이더 캐시 조사 승인 | 블록 경계 |');
    const min = buildResumeCard(project({ ...BASE, 'docs/astra/INDEX.md': changed }), 3200, { origin: 'loop' })!;
    expect(min.text).toContain('| N154 | 셰이더 캐시 조사 승인 | 블록 경계 |');
  });

  it('본문을 뺄 원천이 못 읽히면 그 상태는 그대로 보인다(HANDOFF 없음)', () => {
    const { 'docs/HANDOFF.md': _h, ...noHandoff } = BASE;
    const min = buildResumeCard(project(noHandoff), 3200, { origin: 'loop' })!;
    expect(min.text).toContain('`docs/HANDOFF.md` · ⚠ NOT READ (file not found)');
  });

  it('모든 예산에서 상한 유지 · 최소 카드 ≤ 전체 카드', () => {
    const dir = project({ ...BASE, '.ralph/DEMO_STOP': 'STOP\n' });
    for (let b = 400; b <= 3200; b += 113) {
      const full = buildResumeCard(dir, b)!;
      const min = buildResumeCard(dir, b, { origin: 'loop' })!;
      expect(min.text.length, `budget ${b}`).toBeLessThanOrEqual(b);
      expect(min.text.length, `budget ${b}`).toBeLessThanOrEqual(full.text.length + 60);   // 머리 문구 차이만큼의 여유
    }
  });
});

describe.skipIf(!built)('PB154-C 훅 경로 — loop 최소 카드는 Recent Sessions 를 싣지 않는다', () => {
  function ws(loopCard: boolean) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-273c-ws-')));
    tmps.push(root);
    const proj = path.join(root, 'apps', 'game');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
    for (const [rel, body] of Object.entries(BASE)) {
      fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
      fs.writeFileSync(path.join(proj, rel), body);
    }
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'passbaton.config.json'), JSON.stringify({ continuity: { sources: SOURCES, ...(loopCard ? { loopCard: 'minimal' } : {}) } }));
    const db = new Database(path.join(root, '.claude', 'sessions.db'));
    migrateSchema(db);
    db.prepare("INSERT INTO sessions (project, last_work, run_origin) VALUES ('game', '대화 — 미니맵 H 요청서를 정리했다', 'unknown')").run();
    db.prepare("INSERT INTO sessions (project, last_work, run_origin) VALUES ('game', '루프 — 지도 깜빡임 촬영 3 장 판독', 'loop')").run();
    db.close();
    return { root, proj };
  }
  const start = (root: string, proj: string, role?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: root };
    delete env.PASSBATON_ROLE;
    if (role) env.PASSBATON_ROLE = role;
    const r = spawnSync('node', [SESSION_START], { input: JSON.stringify({ cwd: proj, session_id: 'S', source: 'startup' }), encoding: 'utf-8', env });
    expect(r.status, r.stderr?.slice(0, 300)).toBe(0);
    return r.stdout;
  };

  it('loop + opt-in → 최소 카드 · Recent 없음 · 색인 본문 있음', () => {
    const { root, proj } = ws(true);
    const out = start(root, proj, 'loop');
    expect(out).toContain('loop minimal');
    expect(out).not.toContain('## Recent Sessions');
    expect(out).toContain('| PB154 | passbaton 2.7.3 후보 |');
  });

  it('loop 이지만 opt-in 없음 → 전체 카드 + Recent(기존 동작)', () => {
    const { root, proj } = ws(false);
    const out = start(root, proj, 'loop');
    expect(out).not.toContain('loop minimal');
    expect(out).toContain('## Recent Sessions');
    expect(out).toContain('N153** 지도 깜빡임');
  });

  it('opt-in 이 있어도 대화(unknown) 세션 → 전체 카드 + Recent(loop 행 제외)', () => {
    const { root, proj } = ws(true);
    const out = start(root, proj);
    expect(out).not.toContain('loop minimal');
    expect(out).toContain('## Recent Sessions');
    expect(out).not.toContain('루프 — 지도 깜빡임');
  });
});
