#!/usr/bin/env node
// 역검증(Astra reply-148 PB148-01): 대소문자를 가리는 파일시스템에서 라우팅 경계 시험이 정말 일하는가.
//   정상 → 초록(건너뛰지 않음) · 옛 「소문자 startsWith」 경계로 바꿈 → 빨강(바깥 형제 허용 때문에) · 복구 → 초록
// Windows·macOS 에서는 그 시험이 건너뛰어지므로 의미가 없다 — Linux CI 전용.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FILE = 'src/utils/routing.ts';
const GOOD = '    if (!strictlyInside(real, rootReal)) { out.invalid.push(cmd); continue; }';
const BAD = '    if (!real.toLowerCase().startsWith(rootReal.toLowerCase() + path.sep)) { out.invalid.push(cmd); continue; }';
const NAME = '대소문자만 다른 바깥 형제';

if (process.platform !== 'linux') { console.error('linux only'); process.exit(2); }

function run(label) {
  const out = path.join(os.tmpdir(), `pb-mut-${label}.json`);
  spawnSync('npx', ['vitest', 'run', 'tests/routing-2.7.e2e.test.ts', '-t', NAME, '--reporter=json', `--outputFile=${out}`], { encoding: 'utf-8', stdio: 'inherit' });
  const j = JSON.parse(fs.readFileSync(out, 'utf-8'));
  const t = j.testResults.flatMap(r => r.assertionResults).filter(a => a.title.includes(NAME));
  const r = { passed: t.filter(a => a.status === 'passed').length, failed: t.filter(a => a.status === 'failed').length,
    skipped: t.filter(a => a.status === 'pending' || a.status === 'skipped').length,
    why: t.flatMap(a => a.failureMessages ?? []).join(' ').slice(0, 300) };
  console.log(label, JSON.stringify(r));
  // 로그를 못 읽는 쪽(비인증 API)도 결과를 보도록 주석으로도 남긴다
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=boundary ${label}::${JSON.stringify(r).replace(/[\r\n]+/g, ' ')}`);
  return r;
}

const orig = fs.readFileSync(FILE, 'utf-8');
if (orig.split(GOOD).length !== 2) { console.error('mutation anchor not found once'); process.exit(1); }
let ok = true;
const a = run('normal');
ok &&= a.passed === 1 && a.failed === 0 && a.skipped === 0;
try {
  fs.writeFileSync(FILE, orig.replace(GOOD, BAD));
  const b = run('mutated');
  // 실패 이유가 「바깥 형제를 받아들였다」 여야 한다 — commands.has('/sib') 가 true 이거나 invalid 에 없음
  ok &&= b.failed === 1 && /expected true to be false|not.*contain|toContain/.test(b.why);
} finally {
  fs.writeFileSync(FILE, orig);
}
const c = run('restored');
ok &&= c.passed === 1 && c.failed === 0;
const verdict = ok ? 'BOUNDARY MUTATION: normal green → mutated red → restored green' : 'BOUNDARY MUTATION CHECK FAILED';
console.log(verdict);
if (process.env.GITHUB_ACTIONS) console.log(`::${ok ? 'notice' : 'error'} title=boundary verdict::${verdict}`);
process.exit(ok ? 0 : 1);
