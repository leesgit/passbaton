/**
 * 재개 카드 — 레포에 있는 **정본**을 그대로 발췌해 세션 시작에 보여 준다.
 *
 * 왜 필요한가 (2026-10-22 Ashfall 실측 · Astra reply-133):
 *   이 레포의 연속성은 passbaton DB 가 아니라 `docs/HANDOFF.md`(맨 위가 최신) ·
 *   `.ralph/fix_plan.md`(「지금 할 일」 블록) 같은 **사람·에이전트가 같이 고치는 문서**로
 *   굴러간다. DB 요약은 그 문서를 모르고, 그래서 세션 8 건이 모두 workDone=null 이었다.
 *   ⇒ passbaton 은 정본을 대신하지 않는다. **정본의 어느 부분을 먼저 읽을지**를 가리키고,
 *      그 발췌가 언제의 내용인지(줄 범위 + 내용 해시) 함께 적는다.
 *
 * ★ 발췌는 매번 파일에서 다시 읽는다. 캐시하지 않는다 — 문서가 앞에 덧붙여지는 구조라
 *   줄 번호가 매 루프 밀린다. 해시는 「지난번 본 것과 같은가」 를 사람이 비교하라고 준다.
 * ★ 못 읽은 원천은 숨기지 않고 「읽지 못함」 으로 낸다. 빠진 카드가 「변경 없음」 처럼
 *   보이면 안 된다.
 *
 * 선언 — `<project>/.claude/passbaton.config.json`:
 * ```json
 * {
 *   "continuity": {
 *     "sources": [
 *       { "path": "docs/HANDOFF.md", "lines": 40, "label": "HANDOFF (최신 절)" },
 *       { "path": ".ralph/fix_plan.md", "block": "지금 할 일", "label": "지금 할 일" }
 *     ]
 *   }
 * }
 * ```
 *   - `lines`: 파일 맨 위 N 줄 (기본 40 · 최대 200)
 *   - `block`: 이 문자열을 담은 **첫** 목록 항목(`- `)·제목(`#`) 줄부터, 같은 깊이 이상의
 *     다음 항목·제목 직전까지 (최대 120 줄). 못 찾으면 「블록 없음」 으로 낸다
 *   - 경로는 프로젝트 폴더 기준 · 폴더 밖으로 나가는 선언은 받지 않는다
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface ContinuitySource {
  path: string;
  lines?: number;
  block?: string;
  label?: string;
}

export interface ContinuityDeclaration {
  sources: ContinuitySource[];
  /** 모양이 틀려 버린 항목. 조용히 무시하면 사용자는 선언이 먹은 줄 안다. */
  invalid: string[];
}

export interface CardItem {
  label: string;
  path: string;
  /** 'ok' | 'missing' | 'no_block' | 'unreadable' */
  outcome: 'ok' | 'missing' | 'no_block' | 'unreadable';
  from?: number;
  to?: number;
  totalLines?: number;
  sha?: string;
  excerpt?: string;
  truncated?: boolean;
}

const DEFAULT_LINES = 40;
const MAX_LINES = 200;
const MAX_BLOCK_LINES = 120;

export function readContinuityDeclaration(projectPath: string): ContinuityDeclaration {
  const out: ContinuityDeclaration = { sources: [], invalid: [] };
  const file = path.join(projectPath, '.claude', 'passbaton.config.json');

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return out;
  }

  const sources = (raw as { continuity?: { sources?: unknown } })?.continuity?.sources;
  if (sources === undefined) return out;
  if (!Array.isArray(sources)) {
    out.invalid.push('continuity.sources');
    return out;
  }

  const base = path.resolve(projectPath);
  for (const s of sources) {
    const src = s as Record<string, unknown>;
    if (typeof src !== 'object' || src === null || typeof src.path !== 'string' || !src.path.trim()) {
      out.invalid.push(JSON.stringify(s).slice(0, 60));
      continue;
    }
    const abs = path.resolve(base, src.path);
    if (!abs.startsWith(base + path.sep)) {
      out.invalid.push(src.path);
      continue;
    }
    if (src.lines !== undefined && (typeof src.lines !== 'number' || src.lines < 1)) {
      out.invalid.push(`${src.path}: lines`);
      continue;
    }
    if (src.block !== undefined && (typeof src.block !== 'string' || !src.block.trim())) {
      out.invalid.push(`${src.path}: block`);
      continue;
    }
    out.sources.push({
      path: src.path,
      lines: src.lines as number | undefined,
      block: src.block as string | undefined,
      label: typeof src.label === 'string' && src.label.trim() ? src.label : src.path,
    });
  }
  return out;
}

/** 목록 항목·제목의 깊이. 아니면 null. 제목은 # 개수, 목록은 100 + 들여쓰기(제목보다 깊다). */
function depthOf(line: string): number | null {
  const h = /^(#{1,6})\s/.exec(line);
  if (h) return h[1].length;
  const li = /^(\s*)[-*]\s/.exec(line);
  if (li) return 100 + li[1].length;
  return null;
}

function findBlock(lines: string[], needle: string): { from: number; to: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const d = depthOf(lines[i]);
    if (d === null || !lines[i].includes(needle)) continue;
    let j = i + 1;
    while (j < lines.length && j - i < MAX_BLOCK_LINES) {
      const dj = depthOf(lines[j]);
      if (dj !== null && dj <= d) break;
      j++;
    }
    return { from: i + 1, to: j };       // 1-based, inclusive
  }
  return null;
}

export function readSource(projectPath: string, src: ContinuitySource, maxChars: number): CardItem {
  const label = src.label ?? src.path;
  const abs = path.resolve(projectPath, src.path);
  let text: string;
  try {
    if (!fs.existsSync(abs)) return { label, path: src.path, outcome: 'missing' };
    text = fs.readFileSync(abs, 'utf-8');
  } catch {
    return { label, path: src.path, outcome: 'unreadable' };
  }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);

  let from = 1;
  let to: number;
  if (src.block) {
    const b = findBlock(lines, src.block);
    if (!b) return { label, path: src.path, outcome: 'no_block', totalLines: lines.length };
    from = b.from; to = b.to;
  } else {
    to = Math.min(lines.length, Math.min(src.lines ?? DEFAULT_LINES, MAX_LINES));
  }

  const slice = lines.slice(from - 1, to).join('\n');
  const sha = createHash('sha1').update(slice).digest('hex').slice(0, 10);

  // ★ 자를 때는 줄 단위로 자르고 그 사실을 적는다. 해시는 **자르기 전** 범위의 것이다.
  let excerpt = slice;
  let truncated = false;
  if (excerpt.length > maxChars) {
    const kept: string[] = [];
    let n = 0;
    for (const l of slice.split('\n')) {
      if (n + l.length + 1 > maxChars) break;
      kept.push(l); n += l.length + 1;
    }
    excerpt = kept.join('\n');
    truncated = true;
  }

  return { label, path: src.path, outcome: 'ok', from, to, totalLines: lines.length, sha, excerpt, truncated };
}

export function buildResumeCard(projectPath: string, maxChars: number): { text: string; items: CardItem[]; invalid: string[] } | null {
  const decl = readContinuityDeclaration(projectPath);
  if (decl.sources.length === 0 && decl.invalid.length === 0) return null;

  const per = Math.max(400, Math.floor(maxChars / Math.max(1, decl.sources.length)));
  const items = decl.sources.map(s => readSource(projectPath, s, per));

  const out: string[] = ['## Resume card — repo source of truth (read this before the DB summary below)'];
  for (const it of items) {
    if (it.outcome === 'ok') {
      const range = `${it.path}:${it.from}-${it.to}`;
      out.push(`### ${it.label} — \`${range}\` (of ${it.totalLines}) · sha1 ${it.sha}${it.truncated ? ' · truncated' : ''}`);
      out.push('```', it.excerpt ?? '', '```');
    } else {
      const why = it.outcome === 'missing' ? 'file not found'
        : it.outcome === 'no_block' ? 'block not found' : 'unreadable';
      out.push(`### ${it.label} — \`${it.path}\` · ⚠ NOT READ (${why})`);
    }
  }
  if (decl.invalid.length) out.push(`⚠ ignored continuity entries: ${decl.invalid.join(', ')}`);
  return { text: out.join('\n'), items, invalid: decl.invalid };
}
