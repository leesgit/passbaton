#!/usr/bin/env node
/**
 * `passbaton-card` — 공유 재개 카드 스냅샷 (2.8 · Astra reply-174 PB174-200 C1).
 *
 *   passbaton-card --project-dir <dir> --out <card.md> [--meta <meta.json>] [--max-chars N] [--origin loop|unknown] [--no-git] [--force]
 *   passbaton-card --verify <meta.json> [--card <card.md>]
 *
 * ⛔ 부작용 없음: DB 를 열지 않고(index.ts 는 열린다 — 그래서 별도 진입점), hook-trace·설정·디렉터리를 만들지 않는다.
 *    쓰는 것은 --out(카드 바이트 그대로)과 --meta 뿐이다. 이미 있으면 --force 없이는 쓰지 않는다(스냅샷은 불변).
 *    --meta 가 없으면 메타 JSON 은 stdout 으로.
 * 종료: 0 성공·일치 · 1 verify 불일치 · 2 사용법 · 3 선언 없음(카드 없음) · 4 쓰기 거부·실패
 */
import * as fs from 'fs';
import * as path from 'path';
import { clampCardChars } from './utils/resume-card.js';
import { renderCardSnapshot, verifyCardSnapshot, type CardMeta } from './utils/card-snapshot.js';
import { readRoutingDeclaration } from './utils/routing.js';
import { resolveWorkspaceRoot } from './utils/workspace.js';

function usage(msg: string): number {
  process.stderr.write(`passbaton-card: ${msg}\n`
    + 'usage: passbaton-card --project-dir <dir> --out <card.md> [--meta <meta.json>] [--max-chars N] [--origin loop|unknown] [--no-git] [--force]\n'
    + '       passbaton-card --verify <meta.json> [--card <card.md>]\n'
    + '       passbaton-card --routes [--workspace <dir>]\n');
  return 2;
}

/**
 * 2.9 (Astra P4 reply-4 P4-300) — `passbaton-card --routes [--workspace <dir>]`
 * 훅이 쓰는 **같은 함수**(readRoutingDeclaration · resolveWorkspaceRoot)로 라우팅 선언을 풀어 그대로 보여 준다.
 * 새 게임을 만든 직후 「선언이 실제로 읽히는가」 를 DB·훅 없이 확인하는 용도. 아무것도 쓰지 않는다.
 * 종료: 0 문제 없음 · 1 invalid·disabled·이름 충돌 있음 · 3 선언 없음
 */
function runRoutes(wsArg: string | undefined): number {
  const ws = wsArg ? path.resolve(wsArg) : resolveWorkspaceRoot(process.cwd()).root;
  const file = path.join(ws, '.claude', 'passbaton.config.json');
  if (!fs.existsSync(file)) { process.stdout.write(`ROUTES none — no ${file}\n`); return 3; }
  const d = readRoutingDeclaration(ws);
  const byName = new Map<string, Set<string>>();
  for (const t of d.commands.values()) {
    if (!t.dir || !t.name) continue;
    if (!byName.has(t.name)) byName.set(t.name, new Set());
    byName.get(t.name)!.add(t.dir);
  }
  const clashes = [...byName].filter(([, dirs]) => dirs.size > 1).map(([n]) => n);
  process.stdout.write(`ROUTES workspace=${ws} record=${d.record}\n`);
  for (const [cmd, t] of [...d.commands].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(t.dir ? `ROUTE ${cmd} -> ${t.rel} project=${t.name} dir=${t.dir}\n` : `ROUTE ${cmd} -> . (release)\n`);
  }
  for (const c of d.invalid) process.stdout.write(`INVALID ${c}\n`);
  if (d.disabled) process.stdout.write(`DISABLED ${d.disabled}\n`);
  for (const n of clashes) process.stdout.write(`CLASH project name ${n} is used by more than one folder (routing.record = target will not attribute it)\n`);
  const bad = d.invalid.length > 0 || !!d.disabled || clashes.length > 0;
  process.stdout.write(bad ? 'ROUTES-CHECK problems\n' : 'ROUTES-CHECK ok\n');
  return bad ? 1 : 0;
}

export function runCardCli(argv: string[]): number {
  const opt: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-git' || a === '--force' || a === '--routes') { flags.add(a); continue; }
    if (['--project-dir', '--out', '--meta', '--max-chars', '--origin', '--verify', '--card', '--workspace'].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return usage(`${a} needs a value`);
      opt[a] = v; i++; continue;
    }
    return usage(`unknown argument ${a}`);
  }

  if (flags.has('--routes')) return runRoutes(opt['--workspace']);
  if (opt['--verify']) {
    let meta: CardMeta;
    try { meta = JSON.parse(fs.readFileSync(opt['--verify'], 'utf-8')) as CardMeta; } catch (e) { return usage(`cannot read meta: ${(e as Error).message}`); }
    const cardPath = opt['--card'] ?? meta.card.path;
    if (!cardPath) return usage('--card needed (meta has no card path)');
    let bytes: Buffer;
    try { bytes = fs.readFileSync(cardPath); } catch { process.stdout.write(`MISMATCH card file unreadable: ${cardPath}\n`); return 1; }
    const bad = verifyCardSnapshot(meta, bytes);
    for (const b of bad) process.stdout.write(`MISMATCH ${b}\n`);
    process.stdout.write(bad.length ? `CARD-VERIFY mismatch=${bad.length}\n` : `CARD-VERIFY ok sha256=${meta.card.sha256}\n`);
    return bad.length ? 1 : 0;
  }

  const dir = opt['--project-dir'];
  const out = opt['--out'];
  if (!dir || !out) return usage('--project-dir and --out are required');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return usage(`project dir not found: ${dir}`);
  const origin = opt['--origin'] ?? 'unknown';
  if (origin !== 'loop' && origin !== 'unknown') return usage('--origin must be loop or unknown');
  const maxChars = clampCardChars(opt['--max-chars'] ?? process.env.PASSBATON_CARD_CHARS, 3200);
  const outAbs = path.resolve(out);
  const metaAbs = opt['--meta'] ? path.resolve(opt['--meta']) : null;
  if (metaAbs && metaAbs === outAbs) return usage('--meta and --out must differ');
  const force = flags.has('--force');
  for (const f of [outAbs, metaAbs]) {
    if (!f) continue;
    if (!fs.existsSync(path.dirname(f))) { process.stderr.write(`passbaton-card: folder does not exist (not created): ${path.dirname(f)}\n`); return 4; }
    if (fs.existsSync(f) && !force) { process.stderr.write(`passbaton-card: ${f} exists — snapshots are not overwritten (use a new name or --force)\n`); return 4; }
  }

  let snap;
  try {
    snap = renderCardSnapshot(dir, { maxChars, origin, git: !flags.has('--no-git'), cardPath: outAbs });
  } catch (e) {
    process.stderr.write(`passbaton-card: ${(e as Error).message}\n`);
    return 4;
  }
  if (!snap) { process.stderr.write('passbaton-card: no continuity declaration in .claude/passbaton.config.json — no card\n'); return 3; }
  const metaText = JSON.stringify(snap.meta, null, 1) + '\n';
  try {
    fs.writeFileSync(outAbs, snap.bytes, { flag: force ? 'w' : 'wx' });
    if (metaAbs) fs.writeFileSync(metaAbs, metaText, { flag: force ? 'w' : 'wx', encoding: 'utf-8' });
  } catch (e) {
    process.stderr.write(`passbaton-card: write failed: ${(e as Error).message}\n`);
    return 4;
  }
  if (metaAbs) {
    const full = snap.meta.sources.filter(s => s.delivery === 'full').length;
    process.stdout.write(`CARD ${outAbs} sha256=${snap.meta.card.sha256} bytes=${snap.meta.card.bytes} sources=${snap.meta.sources.length} full=${full} meta=${metaAbs}\n`);
  } else {
    process.stdout.write(metaText);
  }
  return 0;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(new URL(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exit(runCardCli(process.argv.slice(2)));
