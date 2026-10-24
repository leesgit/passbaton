// 2.8 — 선언 원천 직접 검색 (Astra reply-174 PB174-300 「C1·C2 필수 계약」 C2 · §4 · reply-170 §4 · packet-170 §2-3)
//
// 계약: 선언된 원천만(새 색인 DB 없음) · 결과마다 경로·절·줄·실제 읽은 바이트 sha256·발췌·Git 상태(보조) ·
// 대체 관계는 명시된 절별 근거만(없으면 「대체 관계 미확인」 · 「reply-169 → reply-167 전체 폐기」 금지) ·
// 결과는 권한·자동 적용 입력 아님 · 부작용 없음. 정답표는 결과 개수가 아니라 (경로·절)·대체 표시로 잰다.
// 음성 시험마다 적격 양성 대조를 둔다(§4) — 빈 출력·전부 거부 구현은 통과하지 못한다.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  searchSources, verifySearchReport, measureGold, scoreGoldQuery, parseSupersessionTable, supersessionLabel,
  UNKNOWN_SUPERSESSION, AUTHORITY_NOTE, type GoldTable, type SearchReport, type SearchResult,
} from '../src/utils/source-search.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../dist/cli-search.js');
const built = fs.existsSync(CLI);
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');
const GOLD = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'source-search', 'gold-fixture.json'), 'utf-8')) as GoldTable;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

const R164 = `# Astra 답신 — packet-164

## 최종 답

**1. 결정**

v28 일회성 부채를 받는다.

**2. fix_plan**

| ID | 내용 |
|---|---|
| N164-250 | 감사 |

**250 래칫 계약**

v28 래칫 상향은 최종 실측으로 한 번만 기록한다.

**3. 끝 조건**

끝.

## 레포 읽기 기록

### READ docs/ratchet.txt
래칫 상향 인용 — 라운드 원문(검색 대상 아님)
동일 배우 이탈 복원 인용 — 라운드 원문(검색 대상 아님)
`;
const R166 = `# Astra 답신 — packet-166

## 최종 답

**1. 결정**

접지 보강.

**2. fix_plan 표**

- 동일 배우 이탈 복원 검사 D6 — 그 사람 검사.

## 라운드 1 원문

동일 배우 이탈 복원 — 인용
`;
const R167 = `# Astra 답신 — packet-167

## 최종 답

**1. 결정**

같은 배우로 추적한다.

**2. fix_plan 표**

- 동일 배우 이탈 복원 전체 절차 ①–⑦.

**4. 역검증**

- 동일 배우 이탈 복원 역검증 — 배우 교체 시 실패.
`;
const R169 = `# Astra 답신 — packet-169

## 최종 답

**1. 결정**

동일 배우 이탈 복원을 제한 재개한다(reply-167 계약 유지 · 범위만 제한).

**2. fix_plan 표**

- 200-O · 200-R
`;
const SUPERSESSION = `# 절별 대체 근거

| 대상 | 관계 | 근거 |
|---|---|---|
| reply-167 §2 | 범위 제한 | reply-169 §1–§3 |
| reply-166 §2 | 대체 | reply-167 §2 |
| reply-167 | 전체 폐기 | reply-169 |
| N163 | 대체 | N164 |
`;
const RATCHET = '# UE 어댑터 래칫\nhistory v27 — 래칫 상향은 명시 커밋으로만(자동 상향 금지)\n';
const NOTES = '# 메모\n동일 배우 이탈 복원 — 선언되지 않은 문서\n래칫 상향 — 선언되지 않은 문서\n';

const CONFIG = {
  continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5 }] },
  search: {
    sources: [
      { glob: 'docs/astra/*-reply-*.md', block: '최종 답', label: 'Astra 답신' },
      { path: 'docs/ratchet.txt' },
    ],
    supersession: ['docs/astra/SUPERSESSION.md'],
  },
};

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf-8' }).trim();
}

function project(config: unknown = CONFIG, opts: { git?: boolean } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-28search-')));
  roots.push(ws);
  const proj = path.join(ws, 'proj');
  const home = path.join(ws, 'home');
  const w = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true }); fs.writeFileSync(path.join(proj, rel), body); };
  fs.mkdirSync(home, { recursive: true });
  w('.claude/passbaton.config.json', JSON.stringify(config));
  w('docs/astra/2026-10-24-reply-164.md', R164);
  w('docs/astra/2026-10-24-reply-166.md', R166);
  w('docs/astra/2026-10-24-reply-167.md', R167);
  w('docs/astra/2026-10-24-reply-169.md', R169);
  w('docs/astra/SUPERSESSION.md', SUPERSESSION);
  w('docs/ratchet.txt', RATCHET);
  w('docs/HANDOFF.md', '# 최신\n- 래칫 상향 메모(HANDOFF — search 선언 밖)\n');
  w('docs/notes.md', NOTES);
  if (opts.git !== false) { git(proj, 'init', '-q'); git(proj, 'add', '-A'); git(proj, 'commit', '-q', '-m', 'fixture'); }
  return { ws, proj, home, w };
}

function tree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { m.set(path.relative(root, p), 'dir'); walk(p); } else m.set(path.relative(root, p), sha256(fs.readFileSync(p)));
    }
  };
  walk(root);
  return m;
}

const find = (r: SearchReport, p: string, section?: string) => r.results.filter(x => x.path === p && (section === undefined || x.section.includes(section)));

describe('C2 gold table — fixture (positive control for every negative below)', () => {
  it('finds every expected (path, section) with the expected supersession label; misses 0 · label errors 0', () => {
    const { proj } = project();
    const score = measureGold(proj, GOLD);
    expect(score.totals.expected).toBe(6);
    expect(score.totals.misses).toBe(0);
    expect(score.totals.labelErrors).toBe(0);
    expect(score.pass).toBe(true);
    for (const q of score.queries) {
      expect(q.ms).toBeGreaterThan(0);
      expect(q.bytesRead).toBeGreaterThan(0);
      expect(q.extras).toEqual([]);
    }
  });

  it('each result carries path · section · lines · sha256 of the bytes read · excerpt from those bytes · git(aux) · authority note', () => {
    const { proj } = project();
    const r = searchSources(proj, '래칫 상향');
    expect(r.authority).toBe(AUTHORITY_NOTE);
    expect(r.declaration.from).toBe('search.sources');
    const [x] = find(r, 'docs/astra/2026-10-24-reply-164.md', '250 래칫 계약');
    expect(x).toBeDefined();
    const buf = fs.readFileSync(path.join(proj, x.path));
    expect(x.file.sha256).toBe(sha256(buf));
    expect(x.file.bytes).toBe(buf.length);
    const lines = buf.toString('utf-8').split('\n');
    expect(x.range.sha256).toBe(sha256(lines.slice(x.range.from - 1, x.range.to).join('\n')));
    expect(x.hitLines.some(n => lines[n - 1].includes('래칫 상향'))).toBe(true);
    expect(lines.slice(x.excerpt.from - 1, x.excerpt.to).join('\n')).toBe(x.excerpt.text);
    expect(x.excerpt.text).toContain('래칫 상향');
    expect(x.excerpt.sha256).toBe(sha256(x.excerpt.text));
    expect(x.section).toBe('Astra 답신 — packet-164 › 최종 답 › 2. fix_plan › 250 래칫 계약');
    expect(x.sectionNo).toBe(2);
    expect(x.git).toEqual({ state: 'clean', aux: true });
  });

  it('a lexical result count alone is not accuracy — right count, wrong sections → fails', () => {
    const { proj } = project();
    const q = GOLD.queries[1];
    const real = searchSources(proj, q.query);
    expect(scoreGoldQuery(q, real).misses).toEqual([]);                       // 양성 대조
    const wrong = real.results.map((r, i): SearchResult => ({ ...r, path: 'docs/astra/2026-10-24-reply-164.md', section: `엉뚱한 절 ${i}` }));
    const s = scoreGoldQuery(q, { ...real, results: wrong });
    expect(wrong.length).toBe(real.results.length);
    expect(s.misses.length).toBe(q.expect.length);
    // 같은 파일·같은 개수라도 절이 틀리면 누락 — 파일 단위 적중은 절 정답이 아니다
    const sameFile = real.results.map((r, i): SearchResult => ({ ...r, section: `엉뚱한 절 ${i}` }));
    expect(scoreGoldQuery(q, { ...real, results: sameFile }).misses.length).toBe(q.expect.length);
  });

  it('an empty-output implementation fails the gold table', () => {
    const { proj } = project();
    for (const q of GOLD.queries) {
      const real = searchSources(proj, q.query);
      expect(scoreGoldQuery(q, real).misses).toEqual([]);                     // 양성 대조
      const s = scoreGoldQuery(q, { ...real, results: [] });
      expect(s.found).toBe(0);
      expect(s.misses.length).toBe(q.expect.length);
    }
    const emptyProj = project({ search: { sources: [] } }).proj;
    expect(measureGold(emptyProj, GOLD).pass).toBe(false);
  });
});

describe('C2 supersession — explicit section-level evidence only', () => {
  it('whole-file / row-level rows are ignored (never 「reply-169 → reply-167 전체 폐기」); unlisted sections stay 「대체 관계 미확인」', () => {
    const { proj } = project();
    const r = searchSources(proj, '동일 배우 이탈 복원');
    const all = r.results.flatMap(x => x.supersession.status === 'explicit' ? x.supersession.relations : []);
    expect(all.some(x => x.relation.includes('폐기'))).toBe(false);
    expect(r.ignoredEvidence.map(e => e.text)).toEqual(expect.arrayContaining([expect.stringContaining('전체 폐기'), expect.stringContaining('N163')]));
    // 양성 대조: 절을 명시한 행은 쓰인다 — 근거 위치까지
    const [s2] = find(r, 'docs/astra/2026-10-24-reply-167.md', '2. fix_plan 표');
    expect(supersessionLabel(s2)).toBe('범위 제한');
    expect(s2.supersession.status === 'explicit' && s2.supersession.relations[0].evidence).toMatchObject({ path: 'docs/astra/SUPERSESSION.md', line: 5 });
    const [s4] = find(r, 'docs/astra/2026-10-24-reply-167.md', '4. 역검증');
    expect(s4.supersession).toEqual({ status: 'unknown', label: UNKNOWN_SUPERSESSION });
  });

  it('parser: a whole-file row produces no relation; a §-row does', () => {
    const p = parseSupersessionTable('S.md', Buffer.from(SUPERSESSION));
    expect(p.relations.map(x => `${x.target.ref}§${x.target.from}-${x.target.to}:${x.relation}`)).toEqual(['reply-167§2-2:범위 제한', 'reply-166§2-2:대체']);
    expect(p.ignored).toHaveLength(2);
  });

  it('an old disposition shown as wholly valid fails the gold table', () => {
    const { proj } = project();
    const q = GOLD.queries[1];
    const real = searchSources(proj, q.query);
    expect(scoreGoldQuery(q, real).labelErrors).toEqual([]);                  // 양성 대조
    const valid = real.results.map((r): SearchResult => (r.path.endsWith('reply-167.md')
      ? { ...r, supersession: { status: 'explicit', relations: [{ relation: '유효', target: { ref: 'reply-167', from: 1, to: 99, text: 'reply-167 전체' }, by: '', evidence: { path: 'x', line: 1, sha256: '' } }] } }
      : r));
    const s = scoreGoldQuery(q, { ...real, results: valid });
    expect(s.labelErrors.length).toBe(2);
  });

  it('without a declared evidence table every result is 「대체 관계 미확인」 (no implicit validity or voiding)', () => {
    const { proj } = project({ search: { sources: CONFIG.search.sources } });
    const r = searchSources(proj, '동일 배우 이탈 복원');
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) expect(x.supersession).toEqual({ status: 'unknown', label: UNKNOWN_SUPERSESSION });
  });
});

describe('C2 bounds — declared sources only', () => {
  it('undeclared files and quoted round transcripts outside the declared block are not searched', () => {
    const { proj } = project();
    const r = searchSources(proj, '동일 배우 이탈 복원');
    expect(r.results.map(x => x.path)).not.toContain('docs/notes.md');
    expect(r.results.map(x => x.path)).not.toContain('docs/HANDOFF.md');
    expect(r.results.some(x => /레포 읽기 기록|라운드 1 원문/.test(x.section))).toBe(false);
    // 양성 대조: 선언하면 찾는다 · block 없이 선언하면 인용 절도 찾는다
    const wide = project({ search: { sources: [{ path: 'docs/notes.md' }, { glob: 'docs/astra/*-reply-*.md' }] } });
    const r2 = searchSources(wide.proj, '동일 배우 이탈 복원');
    expect(r2.results.map(x => x.path)).toContain('docs/notes.md');
    expect(r2.results.some(x => /라운드 1 원문/.test(x.section))).toBe(true);
  });

  it('without search.sources it falls back to continuity.sources paths only', () => {
    const { proj } = project({ continuity: { sources: [{ path: 'docs/HANDOFF.md', lines: 5 }] } });
    const r = searchSources(proj, '래칫 상향');
    expect(r.declaration.from).toBe('continuity.sources');
    expect([...new Set(r.results.map(x => x.path))]).toEqual(['docs/HANDOFF.md']);
  });

  it("another project's documents are excluded (nested project root · ../ path) — own copy is found", () => {
    const cfg = { search: { sources: [{ glob: '**/*.md' }, { path: '../other/doc.md' }] } };
    const { ws, proj, w } = project(cfg);
    w('vendor/other-proj/.claude/passbaton.config.json', '{}');
    w('vendor/other-proj/docs/plan.md', '# 다른 프로젝트\n격리 표지 문구 zq-other\n');
    w('vendor/gitproj/.git/HEAD', 'ref: refs/heads/main\n');
    w('vendor/gitproj/readme.md', '# 다른 git\n격리 표지 문구 zq-other\n');
    fs.mkdirSync(path.join(ws, 'other'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'other', 'doc.md'), '# 밖\n격리 표지 문구 zq-other\n');
    const r = searchSources(proj, 'zq-other');
    expect(r.results).toEqual([]);
    expect(r.excluded.map(e => e.path)).toEqual(expect.arrayContaining(['vendor/other-proj/', 'vendor/gitproj/', '../other/doc.md']));
    // 양성 대조: 같은 글이 이 프로젝트 문서에 있으면 찾는다
    w('docs/own.md', '# 우리\n격리 표지 문구 zq-other\n');
    expect(searchSources(proj, 'zq-other').results.map(x => x.path)).toEqual(['docs/own.md']);
  });
});

describe('C2 identity — bytes, not git', () => {
  it('source changed or deleted after a result → verify detects it; unchanged → ok', () => {
    const { proj } = project();
    const r = searchSources(proj, '동일 배우 이탈 복원');
    expect(verifySearchReport(r)).toEqual([]);                                // 양성 대조
    const p = path.join(proj, 'docs/astra/2026-10-24-reply-167.md');
    fs.writeFileSync(p, R167.replace('전체 절차', '전체 절차!'));
    expect(verifySearchReport(r).join('\n')).toMatch(/reply-167\.md: file bytes changed/);
    fs.writeFileSync(p, R167);
    expect(verifySearchReport(r)).toEqual([]);
    fs.rmSync(path.join(proj, 'docs/astra/2026-10-24-reply-169.md'));
    expect(verifySearchReport(r).join('\n')).toMatch(/reply-169\.md: deleted/);
  });

  it('git state is auxiliary: clean · modified (same HEAD) · untracked — each identified by its bytes', () => {
    const { proj, w } = project();
    w('docs/astra/2026-10-24-reply-164.md', R164.replace('한 번만', '한 번만(작업 사본)'));
    w('docs/astra/2026-10-25-reply-175.md', '# 새\n\n## 최종 답\n\n**1. 결정**\n\n래칫 상향 없음.\n');
    const r = searchSources(proj, '래칫 상향');
    const st = (p: string) => find(r, p)[0]?.git.state;
    expect(st('docs/ratchet.txt')).toBe('clean');
    expect(st('docs/astra/2026-10-24-reply-164.md')).toBe('modified');
    expect(st('docs/astra/2026-10-25-reply-175.md')).toBe('untracked');
    const [u] = find(r, 'docs/astra/2026-10-25-reply-175.md');
    expect(u.file.sha256).toBe(sha256(fs.readFileSync(path.join(proj, u.path))));
    const nogit = project(CONFIG, { git: false });
    expect(find(searchSources(nogit.proj, '래칫 상향'), 'docs/ratchet.txt')[0].git.state).toBe('unknown');
  });
});

describe.skipIf(!built)('C2 CLI — no side effects', () => {
  const cli = (ws: { home: string; proj: string }, args: string[]) => {
    const env = { ...process.env, HOME: ws.home, USERPROFILE: ws.home, APPDATA: path.join(ws.home, 'AppData') };
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ws.proj, env, encoding: 'utf-8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('search · --json · --gold · --verify write nothing (project, HOME) and say results are not authority', () => {
    const ws = project();
    const before = tree(ws.ws);
    const t = cli(ws, ['--project-dir', ws.proj, '래칫', '상향']);
    expect(t.code).toBe(0);
    expect(t.out).toContain('250 래칫 계약');
    expect(t.out).toContain(`authority: ${AUTHORITY_NOTE}`);
    const j = cli(ws, ['--project-dir', ws.proj, '--json', '동일', '배우', '이탈', '복원']);
    expect(j.code).toBe(0);
    const rep = JSON.parse(j.out) as SearchReport;
    expect(rep.results.length).toBeGreaterThan(0);
    const g = cli(ws, ['--project-dir', ws.proj, '--gold', path.join(here, 'fixtures', 'source-search', 'gold-fixture.json')]);
    expect(g.code).toBe(0);
    expect(JSON.parse(g.out).pass).toBe(true);
    expect(tree(ws.ws)).toEqual(before);
    // verify: 저장한 결과(작업 폴더 밖 임시 파일)와 원문 변경
    const saved = path.join(os.tmpdir(), `pb-28search-rep-${process.pid}-${Date.now()}.json`);
    roots.push(saved);
    fs.writeFileSync(saved, j.out);
    expect(cli(ws, ['--verify', saved]).code).toBe(0);
    fs.appendFileSync(path.join(ws.proj, 'docs/astra/2026-10-24-reply-169.md'), '\n');
    const v = cli(ws, ['--verify', saved]);
    expect(v.code).toBe(1);
    expect(v.out).toMatch(/MISMATCH docs\/astra\/2026-10-24-reply-169\.md: file bytes changed/);
  });

  it('no declaration → exit 3, nothing searched', () => {
    const ws = project({});
    expect(cli(ws, ['--project-dir', ws.proj, '래칫']).code).toBe(3);
  });
});
