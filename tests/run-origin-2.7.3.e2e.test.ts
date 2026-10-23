// 2.7.3 — 실행 출처 저장 (Astra reply-154 PB154-A)
//
// 계약: 명시된 값(`PASSBATON_ROLE=loop`)만 믿는다 · 미설정·잘못된 값·옛 행 = unknown ·
// 「loop 아님 = 대화」 로 단정하지 않는다 · 출처 추가로 같은 Stop 재전달이 새 행이 되면 실패.
// 역검증(reply-154 §4 A): 부모만 설정하고 자식에서 제거 · 잘못된 값 → loop 로 저장되면 빨강 ·
// 이전 DB 사본 이행 후 같은 Stop 재전달 → 기존 행 손실·추가 중복이면 빨강.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readRunOrigin, originOf } from '../src/utils/run-origin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.resolve(here, '../dist/hooks/session-start.js');
const SESSION_END = path.resolve(here, '../dist/hooks/session-end.js');
const built = [SESSION_START, SESSION_END].every(f => fs.existsSync(f));
if (process.env.CI && !built) throw new Error('dist/ missing — run `npm run build` before the e2e tests');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-273a-')));
  roots.push(ws);
  const proj = path.join(ws, 'apps', 'game');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }));
  return { ws, proj, dbPath: path.join(ws, '.claude', 'sessions.db') };
}

/** role: undefined = 자식 환경에서 **지운다**(부모에 남아 있어도) */
function hook(file: string, ws: string, payload: Record<string, unknown>, role?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ws };
  delete env.PASSBATON_ROLE;
  if (role !== undefined) env.PASSBATON_ROLE = role;
  const r = spawnSync('node', [file], { input: JSON.stringify(payload), encoding: 'utf-8', env });
  expect(r.status, `${path.basename(file)} exit (stderr: ${r.stderr?.slice(0, 300)})`).toBe(0);
}

function transcript(ws: string, name: string, requests: string[]): string {
  const p = path.join(ws, name);
  const lines = requests.flatMap((q, i) => [
    { uuid: `${name}-u${i}`, type: 'user', message: { role: 'user', content: q } },
    { uuid: `${name}-a${i}`, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `지도 화면 ${i} 번 항목을 고치고 회귀 시험을 붙였습니다.` }] } },
  ]);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const dropLocks = (ws: string) => {
  for (const f of fs.readdirSync(path.join(ws, '.claude'))) if (f.startsWith('.session-end-')) fs.rmSync(path.join(ws, '.claude', f));
};
const rows = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare("SELECT id, session_id, last_work, run_origin FROM sessions WHERE project = 'game' ORDER BY id").all() as Array<{ id: number; session_id: string | null; last_work: string; run_origin: string | null }>;
  db.close();
  return r;
};

describe('readRunOrigin — 명시된 loop 만', () => {
  it('loop(앞뒤 공백 허용)만 loop · 나머지는 전부 unknown', () => {
    expect(readRunOrigin({ PASSBATON_ROLE: 'loop' })).toBe('loop');
    expect(readRunOrigin({ PASSBATON_ROLE: ' loop\r\n' })).toBe('loop');
    for (const v of [undefined, '', 'Loop', 'LOOP', 'chat', 'conversation', '1', 'true', 'loops', 'loop1']) {
      expect(readRunOrigin(v === undefined ? {} : { PASSBATON_ROLE: v }), String(v)).toBe('unknown');
    }
  });
  it('DB 칸: loop 만 loop · NULL·모르는 값 = unknown (「대화」 값은 없다)', () => {
    expect(originOf('loop')).toBe('loop');
    for (const v of [null, undefined, 'unknown', 'chat', 'LOOP', 1]) expect(originOf(v)).toBe('unknown');
  });
});

describe.skipIf(!built)('PB154-A Stop 이 실행 출처를 저장한다', () => {
  it('PASSBATON_ROLE=loop → loop · 미설정 → unknown', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'L' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'L', transcript_path: transcript(ws, 'l.jsonl', ['루프 일']) }, 'loop');
    hook(SESSION_END, ws, { cwd: proj, session_id: 'C', transcript_path: transcript(ws, 'c.jsonl', ['대화 일']) });
    const r = rows(dbPath);
    expect(r.map(x => [x.session_id, x.run_origin])).toEqual([['L', 'loop'], ['C', 'unknown']]);
  });

  it('부모 프로세스에만 있고 자식(훅) 환경에서 지워지면 → unknown', () => {
    const { ws, proj, dbPath } = workspace();
    const before = process.env.PASSBATON_ROLE;
    process.env.PASSBATON_ROLE = 'loop';
    try {
      hook(SESSION_START, ws, { cwd: proj, session_id: 'P' });
      hook(SESSION_END, ws, { cwd: proj, session_id: 'P', transcript_path: transcript(ws, 'p.jsonl', ['일']) });
    } finally {
      if (before === undefined) delete process.env.PASSBATON_ROLE; else process.env.PASSBATON_ROLE = before;
    }
    expect(rows(dbPath).map(x => x.run_origin)).toEqual(['unknown']);
  });

  it('잘못된 값(Loop · chat · 1) → loop 로 저장되지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'S' });
    for (const [i, v] of ['Loop', 'chat', '1'].entries()) {
      hook(SESSION_END, ws, { cwd: proj, session_id: `W${i}`, transcript_path: transcript(ws, `w${i}.jsonl`, [`일 ${i}`]) }, v);
    }
    const r = rows(dbPath);
    expect(r).toHaveLength(3);
    expect(r.every(x => x.run_origin === 'unknown')).toBe(true);
  });

  it('같은 Stop 의 재전달이 다른 출처로 와도 한 행 — 출처는 중복 판정에 끼지 않는다', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'A' });
    const t = transcript(ws, 'a.jsonl', ['지도 화면 봐줘']);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t }, 'loop');
    dropLocks(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'A', transcript_path: t }, 'loop');   // 락 안에서도
    const r = rows(dbPath);
    expect(r).toHaveLength(1);
    expect(r[0].run_origin).toBe('loop');
  });

  it('이전(2.7.2) DB 사본 이행 → 기존 행 보존(=unknown) · 같은 Stop 재전달은 한 번 · 새 행만 출처를 갖는다', () => {
    const { ws, proj, dbPath } = workspace();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // 2.7.2 스키마 그대로(run_origin 없음) + 옛 행 둘(대화·루프 — 옛 행은 출처를 모른다)
    const t = transcript(ws, 'old.jsonl', ['지도 화면 봐줘']);
    {
      const old = new Database(dbPath);
      old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_work TEXT, current_status TEXT, next_tasks TEXT, modified_files TEXT, issues TEXT,
        session_id TEXT, prompt_id TEXT, user_intent TEXT, file_coverage TEXT, workspace_writes TEXT)`);
      old.prepare("INSERT INTO sessions (project, last_work, session_id, prompt_id) VALUES ('game', '옛 대화 기록 — 지도 렌더 조사 결과를 남겼다', 'OLD', 'p-1')").run();
      old.prepare("INSERT INTO sessions (project, last_work, session_id, prompt_id) VALUES ('game', '옛 루프 기록 — BLOCKED 사유와 재개 조건을 적었다', 'OLD', 'p-2')").run();
      old.close();
    }
    hook(SESSION_START, ws, { cwd: proj, session_id: 'NEW' });
    hook(SESSION_END, ws, { cwd: proj, session_id: 'NEW', transcript_path: t }, 'loop');
    dropLocks(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'NEW', transcript_path: t }, 'loop');   // 같은 이벤트 재전달
    dropLocks(ws);
    hook(SESSION_END, ws, { cwd: proj, session_id: 'NEW', transcript_path: t });           // 다른 환경으로 재전달
    const r = rows(dbPath);
    expect(r.map(x => x.last_work).slice(0, 2)).toEqual(['옛 대화 기록 — 지도 렌더 조사 결과를 남겼다', '옛 루프 기록 — BLOCKED 사유와 재개 조건을 적었다']);
    expect(r.slice(0, 2).map(x => originOf(x.run_origin))).toEqual(['unknown', 'unknown']);
    expect(r.slice(0, 2).map(x => x.run_origin)).toEqual([null, null]);   // 소급해 채우지 않는다
    expect(r).toHaveLength(3);
    expect(r[2].run_origin).toBe('loop');
  });

  it('변경·커밋 0 인 BLOCKED 진단 턴도 loop 행으로 남는다(공회전 저장 생략 기각)', () => {
    const { ws, proj, dbPath } = workspace();
    hook(SESSION_START, ws, { cwd: proj, session_id: 'B' });
    const last = 'BLOCKED — 원인: 빌드 서버 응답 없음 / 영향: N153 촬영 불가 / 재개 조건: 서버 재기동 뒤 다음 루프.';
    hook(SESSION_END, ws, { cwd: proj, session_id: 'B', transcript_path: transcript(ws, 'b.jsonl', ['계속']), last_assistant_message: last }, 'loop');
    const r = rows(dbPath);
    expect(r).toHaveLength(1);
    expect(r[0].run_origin).toBe('loop');
  });
});
