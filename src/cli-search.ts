#!/usr/bin/env node
/**
 * `passbaton-search` — 선언 원천 직접 검색 (2.8 · Astra reply-174 PB174-300 C2).
 *
 *   passbaton-search --project-dir <dir> [--config <file>] [--max-results N] [--no-git] [--json] <query…>
 *   passbaton-search --verify <report.json>
 *   passbaton-search --project-dir <dir> --gold <gold.json> [--config <file>] [--no-git]
 *
 * ⛔ 부작용 없음: DB 를 열지 않고 아무 파일도 쓰지 않는다(출력은 stdout 뿐). 결과는 권한 판정·처분 자동 적용 입력이 아니다.
 *    --config 는 「제안 설정으로 재 보기」 용 — 그 파일이 선언이 되며 출력에 그 경로가 남는다.
 * 종료: 0 성공·일치·정답표 통과 · 1 verify 불일치·정답표 실패 · 2 사용법 · 3 선언 없음
 */
import * as fs from 'fs';
import {
  searchSources, verifySearchReport, measureGold, supersessionLabel, AUTHORITY_NOTE,
  type SearchReport, type GoldTable,
} from './utils/source-search.js';

function usage(msg: string): number {
  process.stderr.write(`passbaton-search: ${msg}\n`
    + 'usage: passbaton-search --project-dir <dir> [--config <file>] [--max-results N] [--no-git] [--json] <query…>\n'
    + '       passbaton-search --verify <report.json>\n'
    + '       passbaton-search --project-dir <dir> --gold <gold.json> [--config <file>] [--no-git]\n');
  return 2;
}

function text(r: SearchReport): string {
  const out: string[] = [];
  out.push(`SEARCH "${r.query}" — declared ${r.declaration.from} (${r.declaration.config.path}) · results ${r.results.length}/${r.totalMatches} · files ${r.stats.filesRead} · bytes ${r.stats.bytesRead} · ${r.stats.ms.toFixed(1)} ms${r.stats.capped ? ' · ⚠ capped' : ''}`);
  for (const x of r.results) {
    out.push(`- ${x.path}:${x.lines.from}-${x.lines.to} 「${x.section}」 sha256 ${x.file.sha256.slice(0, 12)} · range ${x.range.sha256.slice(0, 12)} · git ${x.git.state}(aux) · 대체: ${supersessionLabel(x)}`);
    if (x.supersession.status === 'explicit') for (const s of x.supersession.relations) out.push(`    근거 ${s.evidence.path}:${s.evidence.line} — ${s.target.text} ${s.relation} ${s.by}`);
    out.push(`    ${x.excerpt.from}-${x.excerpt.to}${x.excerpt.truncated ? ' (truncated)' : ''}: ${x.excerpt.text.replace(/\n/g, ' ⏎ ').slice(0, 400)}`);
  }
  for (const e of r.excluded) out.push(`  excluded ${e.path}: ${e.why}`);
  for (const e of r.ignoredEvidence) out.push(`  ignored evidence ${e.path}:${e.line}: ${e.why}`);
  for (const e of r.declaration.invalid) out.push(`  ⚠ ${e}`);
  out.push(`authority: ${AUTHORITY_NOTE}`);
  return out.join('\n') + '\n';
}

export function runSearchCli(argv: string[]): number {
  const opt: Record<string, string> = {};
  const flags = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-git' || a === '--json') { flags.add(a); continue; }
    if (['--project-dir', '--config', '--max-results', '--verify', '--gold'].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return usage(`${a} needs a value`);
      opt[a] = v; i++; continue;
    }
    if (a.startsWith('--')) return usage(`unknown argument ${a}`);
    words.push(a);
  }

  if (opt['--verify']) {
    let rep: SearchReport;
    try { rep = JSON.parse(fs.readFileSync(opt['--verify'], 'utf-8')) as SearchReport; } catch (e) { return usage(`cannot read report: ${(e as Error).message}`); }
    const bad = verifySearchReport(rep);
    for (const b of bad) process.stdout.write(`MISMATCH ${b}\n`);
    process.stdout.write(bad.length ? `SEARCH-VERIFY mismatch=${bad.length}\n` : `SEARCH-VERIFY ok results=${rep.results.length}\n`);
    return bad.length ? 1 : 0;
  }

  const dir = opt['--project-dir'];
  if (!dir) return usage('--project-dir is required');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return usage(`project dir not found: ${dir}`);
  const maxResults = opt['--max-results'] ? Number(opt['--max-results']) : undefined;
  if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1)) return usage('--max-results must be a positive integer');
  const base = { git: !flags.has('--no-git'), ...(opt['--config'] ? { configPath: opt['--config'] } : {}), ...(maxResults ? { maxResults } : {}) };

  if (opt['--gold']) {
    let gold: GoldTable;
    try { gold = JSON.parse(fs.readFileSync(opt['--gold'], 'utf-8')) as GoldTable; } catch (e) { return usage(`cannot read gold: ${(e as Error).message}`); }
    if (!Array.isArray(gold.queries) || !gold.queries.length) return usage('gold has no queries');
    const score = measureGold(dir, gold, base);
    process.stdout.write(JSON.stringify(score, null, 1) + '\n');
    return score.pass ? 0 : 1;
  }

  const query = words.join(' ').trim();
  if (!query) return usage('query is empty');
  const rep = searchSources(dir, query, base);
  if (rep.declaration.from === 'none') { process.stderr.write('passbaton-search: no search/continuity sources declared in .claude/passbaton.config.json — nothing searched\n'); return 3; }
  process.stdout.write(flags.has('--json') ? JSON.stringify(rep, null, 1) + '\n' : text(rep));
  return 0;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(new URL(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exit(runSearchCli(process.argv.slice(2)));
