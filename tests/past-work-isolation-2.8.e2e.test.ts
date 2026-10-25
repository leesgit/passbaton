// 2.8 — 「저번에/예전에」 과거 참조의 프로젝트 격리 (Astra reply-170 PB170-020 · N4)
//
// 결함: searchPastWork 의 세 원천(sessions·memories·solutions) 모두 project 조건이 없었고 memories 는 중요도·unverified
// 거름도 없었다 → 다른 프로젝트 행·정규식 조각이 `<past-context project="현재">` 이름표로 주입됐다.
//
// 계약: 세 원천 모두 현재 프로젝트 행만 · WHERE 에서 거른 뒤 정렬·LIMIT(더 최신·더 높은 순위의 부적격 행이 칸을 먹지 않는다) ·
// 출처 프로젝트 불명(NULL·빈) 행 차단 · 현재 프로젝트 불명이면 전역 검색으로 대체하지 않음 · 중요도 높은 unverified 차단.
// 양성 대조: 현재 프로젝트의 적격 행은 세 원천 모두 **반드시 출력**된다 — 「아무것도 안 내는」 구현은 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const USER_PROMPT = path.resolve(here, '../dist/hooks/user-prompt-submit.js');
const built = [SESSION_START, USER_PROMPT].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function run(file: string, ws: string, payload: Record<string, unknown>): string {
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, WORKSPACE_ROOT: ws } });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
  return r.stdout;
}

// 적격(현재 프로젝트 game) — 반드시 나와야 한다
const OK_SESSION = '미니맵 렌더러 깜빡임을 고쳤다 — game 적격 세션';
const OK_MEMORY = '미니맵 렌더러 셰이더 노이즈 텍스처는 256 으로 고정했고 그 이유는 깜빡임 원인 분석 결과다 — game 적격 기억';
const OK_SOL_SIG = 'game 적격 오류 — 미니맵 렌더러 깜빡임';
// 부적격 — 하나도 나오면 안 된다(같은 문구 · 더 최신 · 더 높은 순위)
const OTHER = '타프로젝트';
const UNVERIFIED = '미니맵 렌더러 instead of waking up 조각';
const ORPHAN = '출처불명';

/**
 * 부적격 묶음은 골라 깐다 — 음성 시험마다 **그 묶음만** 깔아야 고치기 전 코드에서 그 행이 실제로 새어 나온다
 * (묶음을 다 깔면 서로 칸을 먹어 한 묶음의 누수가 가려진다). 양성 대조는 전부 깔아 밀어내기까지 본다.
 */
type Bad = { other?: boolean; unverified?: boolean; orphan?: boolean; noFts?: boolean };
const ALL: Bad = { other: true, unverified: true, orphan: true };
function seeded(bad: Bad = ALL): { ws: string; proj: string } {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-28pw-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  run(SESSION_START, ws, { cwd: proj, session_id: 's1' });            // 훅이 sessions 스키마를 만든다
  const db = new Database(path.join(ws, '.claude', 'sessions.db'));
  // 메모리·해법 표는 MCP 서버가 만든다 — 서버 스키마(src/db/database.ts)의 필요한 부분만
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'observation', tags TEXT, project TEXT, importance INTEGER DEFAULT 5,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      access_count INTEGER DEFAULT 0, metadata TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;
    CREATE TABLE IF NOT EXISTS solutions (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, error_signature TEXT NOT NULL,
      error_message TEXT, solution TEXT NOT NULL, related_files TEXT, keywords TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  // FTS 표가 없는 DB(옛·손상) → memories 는 LIKE 폴백 경로로 찾는다. 그 경로도 같은 거름을 지켜야 한다(PB195-200).
  if (bad.noFts) db.exec('DROP TRIGGER IF EXISTS memories_ai; DROP TABLE IF EXISTS memories_fts;');

  // sessions: 적격 1(가장 오래됨) · 타 프로젝트 3 + 프로젝트 빈 행 1(더 최신 — LIMIT 3 을 먼저 하면 적격이 밀려난다)
  const ses = db.prepare('INSERT INTO sessions (project, last_work, timestamp) VALUES (?, ?, ?)');
  ses.run('game', OK_SESSION, sqlTime(-60));
  if (bad.other) for (let i = 0; i < 3; i++) ses.run('other', `미니맵 렌더러 깜빡임을 고쳤다 — ${OTHER} 세션 ${i}`, sqlTime(-30 + i));
  if (bad.orphan) ses.run('', `미니맵 렌더러 깜빡임 — ${ORPHAN} 세션`, sqlTime(-1));

  // memories: 적격 1(긴 글 → bm25 순위 낮음) · 부적격 셋(짧은 글 → 순위 높음 · 중요도 9)
  const mem = db.prepare('INSERT INTO memories (content, memory_type, project, importance, tags) VALUES (?, ?, ?, ?, ?)');
  mem.run(OK_MEMORY, 'decision', 'game', 6, null);
  if (bad.other) mem.run(`미니맵 렌더러 ${OTHER} 기억`, 'decision', 'other', 9, null);
  if (bad.unverified) mem.run(UNVERIFIED, 'observation', 'game', 9, JSON.stringify(['auto-extracted', 'unverified']));
  if (bad.orphan) mem.run(`미니맵 렌더러 ${ORPHAN} 기억`, 'reference', null, 9, null);
  for (let i = 0; i < 40; i++) mem.run(`관련 없는 메모 ${i} 빌드 순서`, 'observation', 'game', 3, null);   // IDF 를 넘기게

  // solutions: 적격 1(가장 오래됨) · 타 프로젝트 · 프로젝트 NULL(더 최신 — LIMIT 2 를 먼저 하면 밀려난다)
  const sol = db.prepare('INSERT INTO solutions (project, error_signature, solution, created_at) VALUES (?, ?, ?, ?)');
  sol.run('game', OK_SOL_SIG, '노이즈 텍스처 크기 고정', sqlTime(-60));
  if (bad.other) sol.run('other', `${OTHER} 오류 — 미니맵 렌더러 깜빡임`, '다른 프로젝트 해법', sqlTime(-10));
  if (bad.orphan) sol.run(null, `${ORPHAN} 오류 — 미니맵 렌더러 깜빡임`, '출처 불명 해법', sqlTime(-5));
  db.close();
  return { ws, proj };
}
function sqlTime(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

const PROMPT = '저번에 미니맵 렌더러 어떻게 고쳤지';
const pastBlock = (out: string) => {
  const m = out.match(/<past-context project="([^"]*)">([\s\S]*?)<\/past-context>/);
  return m ? { project: m[1], body: m[2] } : null;
};

describe.skipIf(!built)('PB170-020 N4 과거 참조 — 현재 프로젝트·주입 자격', () => {
  it('양성 대조: 세 원천 모두 현재 프로젝트 적격 행이 나온다 — 더 최신·더 높은 순위의 부적격 행에 밀려나지 않는다', () => {
    const { ws, proj } = seeded();
    const past = pastBlock(run(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: PROMPT }));
    expect(past?.project).toBe('game');
    expect(past?.body).toContain(OK_SESSION);
    expect(past?.body).toContain(OK_MEMORY.slice(0, 80));
    expect(past?.body).toContain(OK_SOL_SIG);
  });

  // 음성 셋: 그 묶음만 깔고, 적격 행이 함께 나오는지(양성)도 매번 본다
  const gameTurn = (bad: Bad) => {
    const { ws, proj } = seeded(bad);
    const past = pastBlock(run(USER_PROMPT, ws, { cwd: proj, session_id: 's1', prompt: PROMPT }));
    expect(past?.project).toBe('game');
    expect(past?.body).toContain(OK_SESSION);
    expect(past?.body).toContain(OK_SOL_SIG);
    return past!.body;
  };

  it('같은 문구의 다른 프로젝트 행은 세 원천 어디에서도 나오지 않는다', () => {
    const body = gameTurn({ other: true });
    expect(body).toContain(OK_MEMORY.slice(0, 80));
    expect(body.split(/\r?\n/).filter(l => l.includes(OTHER))).toEqual([]);
  });

  it('중요도가 높아도 unverified 조각은 나오지 않는다', () => {
    const body = gameTurn({ unverified: true });
    expect(body).toContain(OK_MEMORY.slice(0, 80));
    expect(body).not.toContain('instead of waking up');
  });

  it('FTS 없는 DB(LIKE 폴백): 다른 프로젝트 기억은 나오지 않고 적격 기억은 나온다', () => {
    const body = gameTurn({ other: true, noFts: true });
    expect(body).toContain(OK_MEMORY.slice(0, 80));
    expect(body.split(/\r?\n/).filter(l => l.includes(OTHER))).toEqual([]);
  });

  it('출처 프로젝트 불명(NULL·빈) 행은 전역으로 보지 않는다', () => {
    const body = gameTurn({ orphan: true });
    expect(body).toContain(OK_MEMORY.slice(0, 80));
    expect(body.split(/\r?\n/).filter(l => l.includes(ORPHAN))).toEqual([]);
  });

  it('현재 프로젝트 불명(apps/ 바로 아래 cwd) → 과거 문맥 없음 — 전역 검색으로 대체하지 않는다', () => {
    const { ws } = seeded();
    const out = run(USER_PROMPT, ws, { cwd: path.join(ws, 'apps') + path.sep, session_id: 's1', prompt: PROMPT });
    expect(out).not.toContain('<past-context');
    expect(out).not.toContain('미니맵 렌더러');
  });

  it('다른 프로젝트에서 물으면 그 프로젝트 것만 — game 적격 행이 새지 않는다', () => {
    const { ws } = seeded({});
    const db = new Database(path.join(ws, '.claude', 'sessions.db'));
    db.prepare('INSERT INTO sessions (project, last_work, timestamp) VALUES (?, ?, ?)').run('other', `미니맵 렌더러 손봄 — ${OTHER} 세션`, sqlTime(-90));
    db.close();
    const otherProj = path.join(ws, 'apps', 'other');
    fs.mkdirSync(otherProj, { recursive: true });
    const past = pastBlock(run(USER_PROMPT, ws, { cwd: otherProj, session_id: 's2', prompt: PROMPT }));
    expect(past?.project).toBe('other');
    expect(past?.body).toContain(`${OTHER} 세션`);
    expect(past?.body).not.toContain('game 적격');
  });
});
