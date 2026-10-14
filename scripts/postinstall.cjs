#!/usr/bin/env node
'use strict';
/**
 * npm postinstall — passbaton 훅·MCP 자동 설정.
 *
 * 예전 줄 `node dist/hooks/install.js install 2>/dev/null || true` 는 POSIX 셸 문법이다.
 * Windows 에서 npm 은 기본으로 cmd 로 스크립트를 돌리고, cmd 에는 `/dev/null` 도 `true` 도
 * 없어 **종료 1 → npm 이 설치 전체를 되돌렸다** (2026-10-14 실측). 그래서 셸을 거치지 않는다.
 *
 * 규칙 (Astra P1 A):
 * - 자동 설정이 실패해도 **패키지 설치는 막지 않는다** — 이 래퍼는 늘 0 으로 끝난다
 * - 대신 실패를 숨기지 않는다: 원인과 다시 할 명령을 stderr 한 줄로 남긴다
 * - 설치기를 **별도 프로세스**로 돌린다 — 설치기 파일이 없거나 로드 중 죽는 것도 여기서 잡힌다
 * - 사용자가 직접 돌리는 `passbaton-hooks install` 은 이 완화를 받지 않는다(실패 = 비0)
 * Node 기본 모듈만 쓴다.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const installer = path.join(__dirname, '..', 'dist', 'hooks', 'install.js');
const r = spawnSync(process.execPath, [installer, 'install'], {
  stdio: ['ignore', 'inherit', 'pipe'],
  env: { ...process.env, PASSBATON_POSTINSTALL: '1' },
  encoding: 'utf8',
});

if (r.stderr) process.stderr.write(r.stderr);

if (r.error || r.status !== 0) {
  const lines = (r.stderr || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const reason = r.error ? r.error.message : (lines[lines.length - 1] || `exit ${r.status}`);
  process.stderr.write(
    `passbaton: automatic hook setup did NOT complete (${reason}). ` +
    'The package itself is installed. Retry with: npx passbaton-hooks install\n',
  );
}

process.exit(0);
