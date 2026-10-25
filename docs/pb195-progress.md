# PB195 진행 — 000·100·200 (2026-10-26 · 대화 세션 위임 서브에이전트)

> 처분: `ai-service-generator/apps/kenshi-fantasy/docs/astra/2026-10-25-reply-195.md` 「## 최종 답」 §2 (PB195 · 총상한 8 h · Meshy 0)
> 이 범위: 000(≤0.5 h) · 100(≤0.75 h) · 200(≤1.0 h). 300 이후 안 함. push·main 병합·npm 배포·전역 설치 = 사용자.
> 브랜치 `feat/2.8-continuity` · 시작 HEAD `5c50de5`

## PB195-000 — 읽기 전용 기준 (00:03–00:12)

### 세 판

| 판 | 위치 | version | bin | 비고 |
|---|---|---|---|---|
| 설치본 | `%APPDATA%/npm/node_modules/passbaton` | 2.7.2 | 14 개(`passbaton`·`passbaton-hooks`·훅 5·구 이름 `claude-*` 7) | 실제 사용 중 |
| 2.7.3 후보 | `GitHub/passbaton` `feat/2.7.3-source` `41069a5` | 2.7.3 | 14 개(설치본과 같은 이름) | 미배포 |
| 2.8 후보 | wt170 `feat/2.8-continuity` `5c50de5` | 2.8.0 | 16 개(+`passbaton-card`·`passbaton-search`) | 미배포 · push 안 함 |

- **2.7.3 포함**: `git merge-base --is-ancestor 41069a5 HEAD` → 참(5c50de5 의 조상). 2.8 은 2.7.3 위 11 커밋. 재병합 불필요(reply-195 §1).

### 실제 실행 경로 (읽기만 · 설정 무수정)

- 훅: `~/.claude/settings.json` 5 이벤트(SessionStart · UserPromptSubmit · PostToolUse `Edit`·`Write` · PreCompact · Stop→`session-end.js`) 모두 exec 형식 `C:\Program Files\nodejs\node.exe` + `…\npm\node_modules\passbaton\dist\hooks\<이벤트>.js` → **설치본 2.7.2 를 직접**(bin 이름 경유 아님).
- MCP: `~/.claude.json` 전역 `project-manager` = `node.exe …\passbaton\dist\index.js`(설치본 2.7.2).
- **추가 관찰(L-31 범위 · 400 몫 · 안 고침)**: 프로젝트 `ai-service-generator/.mcp.json` 에 `passbaton` = `npx -y passbaton`(+`WORKSPACE_ROOT`) 도 있다 → 같은 `dist/index.js` 가 두 이름(`project-manager`·`passbaton`)으로 뜰 수 있음. 실제 중복 기동 여부는 미확인.
- B4 가 사는 곳: `dist/index.js`(= bin `passbaton`·`claude-session-continuity-mcp`). 세 판 모두 모듈 최상위에서 `WORKSPACE_ROOT` 탐지 → `.claude/` 생성 → `new Database(DB_PATH)` → 스키마 → 마이그레이션을 끝낸 **뒤** 파일 맨 끝에서 `process.argv[2]` 를 본다. 따라서 `--help`·`config`·`install` 도 DB 를 먼저 열고, `--version` 은 아예 분기가 없어 stdio 서버까지 뜬다(설치본 `dist/index.js:2268`, 2.7.3 `src/index.ts:2599`, 2.8 `src/index.ts:2590`).

### 원장 모순 8 건 중 이번 범위 영향

- #2(도구 수 25/26/24) — 400 몫. 100·200 영향 없음.
- 나머지(1·3–8) — 100·200 판정에 영향 없음.

### 이번 범위 변경 예정 파일

- 100: `src/index.ts`(CLI 분기를 초기화 앞으로 · `--version`/`-v` 추가) · 새 시험 `tests/cli-info-args-2.8.e2e.test.ts`
- 200: 기존 시험 `tests/active-context-2.8.e2e.test.ts`·`tests/past-work-isolation-2.8.e2e.test.ts` 확인 → 부족할 때만 보강
- 이 파일
