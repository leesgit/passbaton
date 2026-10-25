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

- 기준 시험(변경 전 `5c50de5`+문서): `npm run build` 0 · `npx vitest run` **660 + 1 skip** 초록(격리 HOME/TMP — 아래 ⚠ 참고)

## ⚠ 사고 1 건 — 시험 격리 첫 시도가 실제 `~/.claude` 에 썼다 (00:05·00:06)

- 무엇: 「임시 HOME」 규칙대로 `HOME`·`USERPROFILE` 만 스크래치로 바꾸고 `TMP` 는 그대로 둔 채 전체 시험을 2 회 돌렸다. 시험 고정물은 실제 `%TEMP%`(`C:\Users\scea4\AppData\Local\Temp\pb-eph-ptu-*`)에 생기고, 훅의 상위 탐색은 홈 가드(= 바뀐 HOME)에 걸리지 않고 실제 프로필 `C:\Users\scea4`(`.claude` 있음)를 작업 루트로 잡았다 → `tests/ephemeral-root.e2e.test.ts` 계열이 **실제 홈 DB** 에 썼다.
- 바뀐 것(읽기 전용 사본으로 확인 · 고치지 않음): `~/.claude/sessions.db` sha256 `e4fb9cf9…`(00:05 직전) → `8e3b30a6…`(mtime 00:06) — `sessions` id=2(project `scea4` · session `s1` · 「Modified files: a.ts」 · 2026-10-25 15:06:36Z) · `hot_paths` id 1·2(`pb-eph-ptu-*\a.ts`) · `session_files` 1 행 · `active_context` project `scea4` 행(updated_at 15:06:36Z — 그 전부터 있었는지는 **미확인**: 이전 사본 없음) · `~/.claude/.session-end-d0095eedcc26f638.lock`(00:05)·`.session-end-68de85730a53334d.lock`(00:06) 새 파일 · `~/.claude/session-end-debug.log` 2 줄 추가. `settings.json`(a5423fb7…)·`~/.codex/hooks.json` 불변.
- 그 뒤: 격리를 `HOME=USERPROFILE=C:\Users\scea4\AppData\Local\Temp\pb195-iso\home` + `TMP=TEMP=TMPDIR=<그 아래 tmp>` 로 바꿨다(스크래치 경로 안은 안 된다 — 이름에 `scratchpad` 가 들어가면 passbaton 이 그 경로를 관측에서 빼서 26 개 시험이 의도대로 빨개진다). 이후 모든 시험·뮤테이션 뒤 실제 홈 DB sha256 `8e3b30a6…`·mtime 00:06 그대로.
- 정리(사용자 결정 · 이 작업은 홈 DB 를 쓰지 않으므로 안 함): 위 행·락 2 개·로그 2 줄 삭제 여부.
- 새 관찰: **시험 묶음이 「실제 HOME = 홈 가드」 에 기대고 있다** — HOME 만 바꾸면 실제 프로필로 샌다. 다음 후보 작업에서 시험 하네스가 HOME 과 TMP 를 함께 격리하도록 고칠 가치(원장 새 행 제안).

## PB195-100 — B4 정보 인자 (00:05–00:13)

- 커밋 `a8a6562` · `src/index.ts`: CLI 분기(`--version`/`-v`/`version` 신설 · `--help`/`-h`/`help` · `config` · `install`/`uninstall`/`remove`/`status`)를 import 바로 뒤 — WORKSPACE_ROOT 탐지·`.claude/` 생성·`new Database`·스키마·이주 **앞** — 로 옮겼다. 버전 = `dist/../package.json` 의 `version`(못 읽으면 `unknown` · 종료 1). 인자 없음·모르는 인자 = 예전처럼 서버.
- 시험 `tests/cli-info-args-2.8.e2e.test.ts` 9 개: 각 정보 인자에 대해 stdout·종료 0·**stdin 을 연 채로** 스스로 끝남(서버면 시간 초과 = 빨강)·서버 기동 문구 없음·작업 폴더 `.claude/` 미생성·가짜 홈 `sessions.db` 미생성 · **R-83 재현 배치**(WORKSPACE_ROOT 없음 · cwd 상위 = `.claude` 있는 가짜 홈)에서 `--version` 뒤 가짜 홈 `.claude/` 비어 있음 · `config` 도 DB 안 엶 · **양성 대조**: 같은 두 배치에서 인자 없이 띄우면 initialize 응답 + DB 생성.
- 검증: `npm run build` 0 · `tsc --noEmit` 0 · 관련 9/9 · 전체 **669 + 1 skip**(50 파일).
- 역검증(커밋된 깨끗한 분리 worktree `scratchpad/pb195/mutwt` · 실행기 `scratchpad/mut170/run170.mjs` · 정의 `scratchpad/pb195/mut/m100.mjs` · 로그 같은 폴더):
  - 옛 코드(`5c50de5` 의 `src/index.ts`) + 새 시험 → **8 빨강 / 1 초록(양성 대조)** · 복구 → 9/9.
  - B4-1 초기화를 인자 처리 앞으로(블록을 `migrateSchema(db)` 뒤로 이동) → **RED-OK** 8/9(양성 대조만 초록).
  - B4-2 `--version` 분기 제거 → **RED-OK** 4(version 3 + R-83).
  - B4-3 버전 원천을 package.json 아닌 경로로 → **RED-OK** 4.
  - 첫 실행의 B4-2 는 `if (false)` 가 타입 오류 → **INVALID(검출로 안 셈)** → 같은 변이를 `cliArg === '--pb195-mutated-away'` 로 다시 = RED-OK. B4-1 첫 판정 「기대 이름 없음」 은 실행기 정규식(괄호) 오기 — 이름 수정 뒤 RED-OK.
- A-local: **충족**. 미확인: 설치된 tarball(800 몫) 에서의 동작 · `passbaton-hooks`(install.js) 쪽 `--version` 은 범위 밖(서버·DB 를 안 엶 — 확인 안 함).

## PB195-200 — 상태 보존·프로젝트 격리 통합 확인 (00:14–00:20)

- 들어 있음: `561405f`(PB170-010)·`c15179e`(PB170-020) 모두 HEAD 조상 · 2.7.3(`41069a5`) 조상 확인(000).
- 쓰기 경로 여섯(현재 HEAD 에서 다시 셈): `hooks/post-tool-use.ts:269` · `hooks/session-end.ts:1512` · `index.ts` session_end·project_init·verify_build·verify_all — 모두 `writeActiveContext`(ON CONFLICT 칸별). 나머지 `INSERT OR REPLACE INTO active_context` 는 `tools/context.ts`·`tools-v2/*`·`utils/auto-context.ts` — 서버·훅 어디서도 import 안 함(죽은 코드 · 손 안 댐 · C15 보류 그대로).
- 검색 세 원천(`user-prompt-submit.ts` `searchPastWork`): sessions·memories(FTS + LIKE 폴백)·solutions 모두 `project = ?` 를 WHERE 에서 먼저 → ORDER/LIMIT · 프로젝트 불명 = 검색 안 함 · memories 는 `MEMORY_ELIGIBLE`.
- 역검증(PB170 변이 정의를 그대로 재사용 · 관련 두 시험 파일 · `a8a6562`):
  - 쓰기 경로 C5-1~C5-6 각각 부분 REPLACE 복원 → **6/6 RED-OK** · C5-7 공용 함수 REPLACE → RED-OK · C5-12 아무것도 안 씀(무출력) → RED-OK.
  - 원천 N4-1(sessions)·N4-2(memories FTS)·N4-3(solutions) 필터 제거 → **3/3 RED-OK** · N4-6r·N4-7r LIMIT 먼저(현재 코드에 맞춰 다시 씀 — PB170 원본 패턴은 `46c9247` 의 `id` 칸 추가로 「NOT APPLIED」) → RED-OK · N4-9 무출력 → RED-OK(양성 대조·음성 시험의 적격 행 확인이 무출력을 잡음).
  - **틈 1 건**: N4-2b memories **LIKE 폴백**(FTS 표 없음) 경로의 `m.project = ?` 제거 → **생존(초록)**. → 커밋 `99896b3` 시험 1 개 추가(FTS 표를 지운 DB · 다른 프로젝트 기억 없음 + 적격 기억 있음) → 같은 변이 **RED-OK** · 원래 코드 17/17 초록.
- 적격 양성 출력: 모든 원천 변이에서 해당 시험의 적격 행 검사가 함께 돈다(음성 시험 `gameTurn` 이 매번 적격 세션·해법을 요구 · 새 시험도 적격 기억 요구). 실제 코드에서 양성 대조 초록.
- 검증: build 0 · 관련 2 파일 17/17 · 전체 **670 + 1 skip**(50 파일).
- A-local: **충족**(제품 코드 변경 없음 · 시험 보강 1). H(자연 재개에서 State·과거 참조가 실제로 맞게 보이는지) = 미판정 · 설치본 2.7.2 에는 결함 그대로(fb1025 P1 재관찰과 같음).

## 시간

| 조각 | 실측 | 상한 |
|---|---|---|
| 000 | ≈ 0.1 h(00:03–00:05 + 앞 읽기) | 0.5 h |
| 100 | ≈ 0.15 h(사고 조사 제외) | 0.75 h |
| 200 | ≈ 0.1 h | 1.0 h |
| 사고 조사 | ≈ 0.05 h | — |

## PB195-300 — L-06 락 누적 (00:22– )

### 락의 역할 — 코드에서 구분 (수정 전 `0d3e2f4` `src/hooks/session-end.ts:718-753`)

- 키 = `md5(transcript_path \0 턴)` 앞 16 자(턴 = 호스트 `prompt_id`/`turn_id`, 없으면 트랜스크립트 크기 `size:N`) · 트랜스크립트가 없으면 `session_id-턴`. 2.7.1(PB149-03)부터 턴이 키에 들어가 **키가 Stop 마다 새로 생긴다**.
- 동작: `wx`(원자 생성) 성공 = 처리 진행 · `EEXIST` 이고 mtime 5 초 안 = 그냥 종료 · 5 초 넘음 = 덮어쓰고 진행. **어디서도 지우지 않는다.**
- **DB 상호배제가 아니다.** DB 쪽 경합은 따로 막혀 있다: `BEGIN IMMEDIATE` 트랜잭션 + `INSERT … WHERE NOT EXISTS`(턴 식별자 있으면 `project+session_id+prompt_id`, 없으면 10 초 안 같은 요약) + 앞선 `already` 조회.
- **역할 = 같은 Stop 이벤트 재전달의 「처리 진입」 중복 방지**(첫 도착이 차지 · 나머지는 아무것도 안 하고 끝냄). DB 판정이 못 막는 것을 막는다:
  1. 행 밖 부작용 — 디버그 로그 · 트랜스크립트 재파싱 · active_context · 해법·기억 추출이 두 번 도는 것.
  2. 식별 못 한 이벤트(`keepUnidentified` — 세션은 있는데 응답 레코드 없음): DB 는 일부러 중복 억제를 안 한다 → **락이 유일한 억제**.
- 부작용(결함):
  - (a) 키가 다시 안 쓰이므로 5 초가 지나면 아무 효과도 없는 파일이 Stop 마다 1 개씩 남는다 = L-06 누적의 발생 경로.
  - (b) 5 초 창은 「처리 중」 과 무관하다 — 첫 처리가 5 초 넘게 걸리면 그 사이 재전달은 진행한다(상호배제 공백).
  - (c) 강제 종료로 남은 락도 5 초 뒤엔 같은 키만 덮어쓸 뿐 지워지지 않는다.

### 수정 방침

- 역할(처리 진입 중복 방지)은 그대로 · 5 초 창도 그대로(완료 직후 재전달 억제 유지).
- 새 락 = 내용 JSON `{v:2, pid, at, token}` · 처리 중엔 주인 pid 가 살아 있고 `MAX_HOLD` 안이면 5 초가 지나도 막는다((b)).
- 끝날 때(모든 `process.exit` → `exit` 이벤트) 내 토큰이면 `doneAt` 을 적는다 · 매 Stop 이 **v2 락만** 쓸어 낸다: 완료 후 보존 창이 지난 것 · 주인 pid 가 죽은 미완료(강제 종료) · `MAX_HOLD` 지난 미완료.
- **옛 형식(숫자만 든 13 바이트) 락은 지우지 않는다** — 기존 파일 일괄 삭제는 기각된 방법(reply-195 §5). 분류·정리안은 아래 「기존 락」 절(읽기 전용).

### 수정 (커밋 `84a91cf`)

- 새 `src/utils/stop-lock.ts` `acquireStopLock(dir, key)` · `session-end.ts` 의 옛 락 블록을 이것으로 교체 + `process.on('exit', release)`.
  - 생성 = `wx` 원자 생성 · 내용 `{v:2,pid,at,token}`.
  - 같은 키가 있으면: v2 완료(`doneAt`) 5 초 안 = 막음 · v2 미완료 + 주인 pid 생존 + `MAX_HOLD`(10 분) 안 = 막음 · 옛 형식 = 예전 규칙(5 초). 그 밖(완료 후 창 지남 · 주인 죽음) = 내용이 그대로일 때만 지우고 `wx` 재시도(2 회 · 그래도 경합이면 막음).
  - 들어가면 같은 폴더의 **v2 락만** 쓸기: 완료 후 `RETAIN`(60 초) 지남 · 미완료인데 주인 죽음 · `MAX_HOLD` 지남. 옛 형식은 안 건드림.
  - 끝(모든 `process.exit`) = 내 토큰일 때만 `doneAt` 기록.
- ⚠ 한계: 낡은 락을 치우는 순간의 경합은 좁혔을 뿐 0 아님(식별된 이벤트는 DB 정체성이 거름 · 식별 못 한 이벤트는 못 거름) · pid 재사용은 `MAX_HOLD` 로만 막음 · 실제 SIGKILL 은 「주인 pid 가 죽은 미완료 v2 락」 을 심어 흉내(실제 프로세스 강제 종료 시험은 안 함).

### 시험 `tests/stop-lock-2.8.e2e.test.ts` 7 개 (실물 훅 · 관측 = 행 수 + 처리 진입 로그 줄 수)

1. 정상 종료: 네 턴(창 경과 흉내) 뒤 락 1 개(마지막) · 행 4 · 매 락 v2+`doneAt`.
2. 같은 턴 재전달(바로 · 식별 못 한 이벤트): 행 1 · 진입 1.
3. 같은 턴 재전달(창 지난 뒤 · 식별된 이벤트): 행 1(DB 정체성) · 남은 락 1.
4. 동시 실행 4 프로세스(식별 못 한 이벤트): 행 1 · 진입 1 · 락 1. (5 회 반복 안정)
5. 동시 실행: 살아 있는 주인이 30 초 잡고 있음(mtime 도 30 초 전) → 진입 0 · 남의 락 안 고침.
6. 강제 종료 뒤 재개: 같은 키에 죽은 주인 미완료 락 → 처리 1 · 새 주인 완료 표시.
7. 잔류 정리: 다른 키의 죽은 주인 락은 치움 · 살아 있는 주인 락과 옛 형식 락(하루 전)은 남김.

- 검증: build 0 · tsc 0 · 관련(stop-lock + stop-dedup) 16/16 · 전체 **677 + 1 skip**(51 파일).
- 옛 훅(`0d3e2f4` `session-end.ts`) + 새 시험 → **4 빨강**(1·5·6·7) / 3 초록(2·3·4 = 지켜야 할 예전 동작의 회귀 방지).
- 역검증(`84a91cf` 깨끗한 분리 worktree · 정의 `scratchpad/pb195/mut/m300.mjs` · 로그 `m300.log`·`m300-retry.log`):
  - L-1 실행 중 잠금 조기 해제(만들자마자 지움) → RED-OK(재전달·동시 4·정상 종료 등 6)
  - L-2 처리 중 주인 확인 생략(5 초 창만) → RED-OK(시험 5·6)
  - L-3 중복 방지 생략 → RED-OK(시험 2·4·5)
  - L-4 완료 표시 생략 → RED-OK(시험 1·2…)
  - L-5 강제 종료 복구 파손(죽은 주인도 막음) → RED-OK(시험 6 — 강제 종료 복구 별도 확인)
  - L-6 잔류 정리 파손(죽은 주인 안 치움) → RED-OK(시험 7)
  - L-7 쓸기 제거 → RED-OK(시험 1·7)
  - L-8 옛 형식 락도 지움(기각된 일괄 삭제) → RED-OK(시험 7)
  - **8/8** · 첫 실행에서 L-3·L-4·L-8 은 타입 좁힘 오류 = INVALID(검출로 안 셈) → 같은 변이를 컴파일되게 한 번 다시 써서 RED-OK.
- 실제 홈 점검(조정자 정정 기준 · `scratchpad/pb195/homecheck.cjs` · 사본 질의 · 스냅샷 `scratchpad/pb195/hc/t0~t7.json`): 시험 묶음 4 번(관련·전체·뮤테이션·재시도) 앞뒤 모두 **새 행 0 · 새 락 0 = CLEAN**. 참고: sha256 `8e3b30a6…` · mtime 2026-10-25T15:06:36Z 그대로.
- A-local: **충족**(네 경우 · 중복 처리 없음 · v2 잔류 정리). H(실제 사용 중 재발 관찰) = 2.8 설치 뒤.

### 기존 락 — 읽기 전용 분류·정리안 (삭제 안 함)

| 위치 | 수 | 형식 | 키 | 가장 젊은 것 | 날짜(KST) |
|---|---|---|---|---|---|
| `ai-service-generator/.claude` | **713** | 전부 옛 형식(13 자리 시각 · 13 B · 내용 = mtime) · v2 0 | 전부 md5 16 자(트랜스크립트 키) | 12 분 전(00:19) — 설치본 2.7.2 가 지금도 Stop 마다 만든다 | 10-24 295 · 10-25 179 · 10-23 68 · 10-26 5 · 나머지 08-10~10-22 166 |
| `~/.claude` | 5 | 같음 | 같음 | 25 분 전(00:05·00:06 = 시험 사고 2 개) | 10-21 3 · 10-26 2 |

- 판정: 5 초가 지난 옛 락은 2.7.2·2.8 어느 코드에서도 **아무것도 막지 않는다**(같은 키 5 초 창만 봄 · 2.7.1 이후 키에 턴이 들어가 재사용도 거의 없음). 718 개 모두 5 초 지남 → 기능상 무효.
- 정리안(사용자 결정 · 이 작업은 안 함): ① 그대로 둠(디렉터리 비대만 · U-14 미측정) ② 2.8 설치 **뒤** 「옛 형식 + mtime 1 일 넘음」 만 사람이 한 번 지움(새 v2 락은 훅이 스스로 정리) ③ ②를 `passbaton` CLI 명령으로 제공(명시 실행 · 미리보기 먼저) — 자동 일괄 삭제는 기각(reply-195 §5)이라 넣지 않음. `~/.claude` 의 5 개 중 2 개는 시험 사고 잔여(사고 정리 결정과 함께).

### 시간

- 300: 00:22–00:32 ≈ 0.17 h / 상한 2.0 h.

## PB195-400 — 정체성 잔재 · L-31 감사 (03:43–03:50)

### 호환 필요성 확인 (읽기만)

- 이 PC 의 실제 사용처는 **구 bin 이름을 쓰지 않는다**: `~/.claude/settings.json` 훅 = node 절대 경로 + 설치본 `dist/hooks/*.js`(bin 이름 아님) · `~/.claude.json` 전역 `project-manager` = node + `dist/index.js` · `~/.codex/hooks.json` = `passbaton-hook-*`(새 이름) · `GitHub/*/.mcp.json`·`.claude/settings*.json`·`.codex/hooks.json` 에 `claude-hook-*`/`claude-session-*` 0 건.
- 그래도 별칭은 유지: npm 사용자 중 v1(`claude-session-continuity-mcp`)에서 온 설치가 훅 줄을 다시 쓰지 않았으면 `claude-hook-*` 를 PATH 로 부른다(README 「nothing breaks」 약속 · `install.ts` 가 옛 접두사를 인식해 교체) — 지우면 조용히 실패한다.
- **별칭 정책(README 에 명시)**: 구 bin 7 개는 2.x 동안 같은 파일을 가리키는 deprecated 별칭 · 제거는 메이저 + 릴리스 노트에서만 · 시험이 고정.

### 수정 (커밋 `36837a7`)

- B1 `serverInfo`: `project-manager-v5`/`5.0.0` → `passbaton`/package.json 버전(`PKG_VERSION` — `--version` 과 같은 원천). 호스트 설정의 서버 **키** `project-manager` 는 도구 이름(`mcp__project-manager__*`)을 정하므로 그대로.
- B3 도구 수: 기동 줄 `24 tools + 3 prompts` 하드코딩 → `listedTools()`·`listedPrompts()`(tools/list·prompts/list 와 같은 함수) 길이 · 읽기 전용이면 걸러진 수 + `· read-only`. 실제 등록 = **26 tools + 3 prompts**(읽기 전용은 더 적음). 머리 주석 「24개 도구」 정리.
- `glama.json`: 「25 MCP tools」 삭제 · version 2.1.2 → 2.8.0.
- A1 구 bin: 그대로 유지 + README 「Alias policy (2.8)」.
- 남김(범위 밖·기록만): `index.ts` 머리 주석의 카테고리별 개수(1~8 · resume_card 미포함) · README 1034 줄 「v4 API (24 tools)」 = 과거 이력 줄.

### 시험 `tests/identity-2.8.e2e.test.ts` 12 개

- 실제 서버(stdio)의 initialize `serverInfo` = `{name: package.name, version: package.version}`.
- tools/list 이름 집합 = 공개 도구 표(26 · 권한 설정이 기대는 계약) · 기동 줄 `passbaton MCP <버전> started (<tools/list 수> tools + <prompts/list 수> prompts)`.
- 읽기 전용: 기동 줄 수 = 걸러진 tools/list 수(수가 실제로 달라지는 양성 대조).
- glama.json 버전 = package · 「N MCP tools」 를 적으면 N = 등록 수.
- 구 별칭 7 개 각각 bin 에 있고 새 이름과 **같은 파일** · dist 에 실제 파일 · README 정책 문구.
- 검증: build 0 · tsc 0 · 관련(identity + cli-info) 21/21 · 전체 **689 + 1 skip**(52 파일).
- 역검증(`36837a7` 분리 worktree · `scratchpad/pb195/mut/m400.mjs` · `m400.log`) **6/6 RED-OK**:
  - I-1 serverInfo 를 옛 값으로 → 빨강(serverInfo)
  - I-2 등록 도구 하나 이름 변경(`graph_explore`→`graph_explorer`) → 빨강(실제 tools/list 대조)
  - I-3 기동 줄 수 하드코딩 24 → 빨강 2
  - I-4 기동 줄이 읽기 전용 거름 무시 → 빨강(읽기 전용)
  - I-5 구 별칭 `claude-hook-session-end` 제거 → 빨강(호환)
  - I-6 구 별칭 `claude-session-continuity-mcp` 가 다른 파일 → 빨강(호환)
- 홈 점검(u0~u6): 묶음 앞뒤 모두 새 행 0 · 새 락 0 = CLEAN. 참고: 대화 세션이 사고 잔여를 지운 뒤 새 기준 sha `f1be47b7` · mtime 2026-10-25T18:42:44Z(묶음 중 불변).
- A-local: **충족**(공개 이름·서버 식별·도구 수 = 실제 등록 · 별칭 정책 명시 + 호환 시험).

### L-31 이중 MCP 등록 — 감사만 (설정 무수정)

- 유효 설정의 출처 둘:
  1. `~/.claude.json` 전역 `mcpServers.project-manager` = `C:\Program Files\nodejs\node.exe` + 설치본 `dist/index.js`(WORKSPACE_ROOT 없음 → cwd 탐지).
  2. 프로젝트 `ai-service-generator/.mcp.json` `passbaton` = `npx -y passbaton` + `WORKSPACE_ROOT=…/ai-service-generator`. `.claude/settings.local.json` 의 `enableAllProjectMcpServers: true` 가 이것을 켠다(`enabledMcpjsonServers: ["project-manager"]` 는 .mcp.json 에 없는 이름 — 효과 없음).
- **실제로 두 서버가 뜬다(관측)**: 현재 Claude 프로세스 `claude.exe` 33948(10-26 02:49) 아래 `node.exe dist/index.js` 38160(전역 등록) + `cmd → npx-cli -y passbaton(31336) → cmd → node …\npm\node_modules\passbaton\dist\index.js`(35676) — 둘 다 **같은 설치본 2.7.2 · 같은 DB**(cwd 탐지 결과와 WORKSPACE_ROOT 가 같은 루트). 이 세션 도구 목록에도 `mcp__project-manager__*`·`mcp__passbaton__*` 가 26 개씩 둘 다 있다. 10-22 부터 살아 있는 다른 `claude.exe` 26560 아래에도 npx 경유 서버 둘(23540·9176)이 있다.
- 영향(추론): 같은 도구 26 개가 두 이름으로 모델 입력에 들어감 · 같은 DB 에 쓰는 프로세스 둘(WAL 이라 깨지진 않음) · `npx` 쪽은 매 기동 레지스트리 확인 비용. 실제 해(오동작) 관측은 없음.
- 해결안(사용자 결정 · 전역/프로젝트 설정 수정은 사용자 몫): **(가 · 권장)** 프로젝트 `.claude/settings.local.json` 에 `"disabledMcpjsonServers": ["passbaton"]`(또는 `enableAllProjectMcpServers: false`) — 전역 `project-manager` 하나만 남고 권한 규칙의 도구 이름 유지. (나) `.mcp.json` 에서 `passbaton` 항목 삭제(레포 공유 설정이라 다른 사람에겐 영향). (다) 전역을 지우고 프로젝트 것만 — 도구 이름이 `mcp__passbaton__*` 로 바뀌어 권한 규칙 재작성 필요 · 비권장.
- 판정: **미해결(설정 감사 + 실제 중복 기동 관측까지)**.

### L-54 루트 탐지가 사용자 프로필까지 올라감 — 이번 범위 아님 · 재현 근거·제안만

- 근거 1(시험 사고 00:05·00:06): HOME 만 바꾸면 `utils/workspace.ts` `candidateDirs` 의 홈 가드(`os.homedir()` = 바뀐 HOME)가 실제 프로필을 막지 못해 `%TEMP%\pb-eph-ptu-*` → `C:\Users\scea4`(`.claude/sessions.db` 있음 → reason `db`)로 잡혔다(`session-end-debug.log` `ws_root=C:\Users\scea4 (by=db)`).
- 근거 2(자연 발생): `~/.claude/sessions.db` 의 10-21 행 `project=scea4`「reply with just: ok」 — 홈에서 띄운 실제 세션. 가드는 「cwd 자체가 홈이면 예외」 라 홈이 루트가 된다.
- 근거 3(코드): **서버 `src/index.ts` 의 `detectWorkspaceRoot` 는 `utils/workspace.ts` 가 아닌 자체 사본이고 홈 가드가 없다** — 상위 어디든 `.claude` 가 있으면 루트(R-83 에서 `--version` 이 홈 DB 를 연 경로).
- 제안: ① 서버가 `utils/workspace.ts` `resolveWorkspaceRoot` 를 쓰게(R-06 은 「순수 추출」 기각이지 동작 변경 동반은 허용) ② 홈 가드를 `os.homedir()` 와 `os.userInfo().homedir` 둘 다로 ③ cwd 가 홈 자체일 때 `.claude/sessions.db` 를 루트 근거로 쓰지 않기(사람 결정 — 홈에서 쓰는 사용자 영향) ④ 시험 하네스는 HOME·TMP 동시 격리(L-53).

### 시간

- 400: 03:43–03:50 ≈ 0.12 h / 상한 0.75 h.

## PB195-500 — L-48 · L-49 · L-50 (03:51–04:01)

### ① L-48 files 줄 잡음 — 원인 재현 후 수정

- 원인(읽기 전용 증거): 프로젝트 DB 사본에서 `skipped: agent-…: failed` 행 **153 개**(최근 2743·2738·2736 = fb1025 P2 원문과 같은 `1/3 roots`). 그 루트는 `apps/kenshi-fantasy/.claude/worktrees/agent-a55b2e4e5b7a512f3` 등 — 끝난 보조 에이전트의 격리 워크트리(hot_paths 에 경로 남음)이고 **디렉터리가 이미 없다**(`git worktree list` 에도 없음). `writesSince` 가 없는 cwd 로 git 을 띄워 `spawnSync git ENOENT` → `failed`. git 미설치·저장소 파손과 같은 말이 됐다.
- 수정(커밋 `198ed13`): `utils/worktree.ts` `writesSince` — 루트 디렉터리가 없으면 `missing`(git 안 띄움). `session-end.ts` — `missing` 은 `coverage.workspace.removed`(basename 목록)로 따로 적고 `roots`·`uncovered` 에 안 셈. 디렉터리가 있는데 git 이 실패하면 예전대로 `uncovered: <이름>: failed` → 주입 줄 `skipped:` 에 그대로 보인다. 렌더러는 그대로(사라진 루트만 있으면 정상 완전 검사의 짧은 꼴).
- 한계: 이미 저장된 옛 행 153 개는 basename 만 남아 다시 가를 수 없다 → 그 행들이 Recent 에서 밀려날 때까지 옛 꼴로 보인다(소급 재분류 안 함 · P-26).
- 시험 `tests/files-line-2.8.e2e.test.ts` 2 개(실물 UserPromptSubmit → session_roots 에 루트 심기 → 실물 Stop → 실물 SessionStart):
  1. 사라진 `agent-a55b2e4e5b7a512f3` 둘 → `removed` 둘 · `uncovered` 빈 · `1/1 roots` · 주입 줄 `files: 0 obs in checked scope · 1/1 roots · boundary=turn_start` · `failed`·`agent-` 없음.
  2. 실제 실패(색인 파손 저장소 `broken-repo`) + 사라진 루트 → `uncovered: ['broken-repo: failed']` · 주입 줄 긴 꼴 `(1/2 roots, …, skipped: broken-repo: failed)` · `agent-` 없음.

### ② L-49 같은 커밋 · 다른 세션 — 보존 확인 (코드 변경 없음)

- 판단: 같은 커밋 ≠ 같은 기록(대화 요약과 루프 요약은 다른 세션의 다른 작업) → 합치거나 지우지 않는다. 2.8 에서 구분 수단이 이미 있다: `_(via …)_`(PB165-200 요약 출처) · `[origin unknown]` · 확인된 loop 행은 대화 카드에서 **노출만** 뺌(PB154-B · DB 행 유지).
- fb1025 P3 가 셋 다 보인 이유: 설치본 2.7.2 에는 출처 칸·loop 거름이 없다(2.7.3 기능).
- 시험 `tests/recent-same-commit-2.8.e2e.test.ts` 2 개: 대화 카드 = 같은 커밋 06e2fc6 의 대화 요약(`via assistant text`)·루프 요약(`via commit message`) 두 줄 모두 + 둘 다 `[origin unknown]` · 확인된 loop 행은 안 나옴 / 루프 카드 = 세 줄 모두 · DB 행 3.
- **진짜 중복 축소는 보류**: 같은 세션 같은 턴의 재전달은 Stop 턴 정체성이 이미 막는다(stop-dedup 시험) · 같은 세션의 다른 턴이 같은 문구를 남긴 것을 줄이는 것은 L-45 보류 그대로(「같은 문구 ≠ 같은 의미」 r174) — 안전한 판정 기준이 없다.

### ③ L-50 두 CLI 가 후보 tarball 에서 실행되는가

- `scripts/verify-pack.mjs` 확장(커밋 `198ed13`): 포장 단계에서 `dist/cli-card.js`·`dist/utils/card-snapshot.js`·`dist/cli-search.js`·`dist/utils/source-search.js` 포함 확인 · 격리 prefix·HOME 에 **실제 `npm pack` tarball 을 설치한 뒤 설치된 bin 셈**(`<prefix>/passbaton-card.cmd`·`passbaton-search.cmd`)으로: 카드·메타 생성(메타 `packageVersion` = 설치된 package.json 2.8.0) · `--verify` 0 · 검색 결과 1. `--version` 안 씀(R-83). 새 역검증 모드 `--break=cli`(포장에서 `dist/utils/card-snapshot.js` 제외).
- 실행(격리 `pb195-iso` HOME+TMP · npm 캐시도 그 아래): 기본 = **✅ 전부 PASS**(기존 9 + 새 4) · `--break=cli`(깨끗한 분리 worktree) = 포장 확인 FAIL + 설치본 `passbaton-card` 생성·verify FAIL(모듈 없음 → 실행 실패) → **✅ 판정이 빨갛다** · `passbaton-search` 는 그 파일과 무관해 PASS(예상). 로그 `scratchpad/pb195/verify-pack-normal.log`·`verify-pack-break-cli.log`.
- 구분: **배포 가능한 CLI 확보 = 충족**(후보 tarball 에 들어 있고 설치본에서 임시 사본 없이 돈다) · **현재 세션 실행 경로 전환 = 안 함**(Astra 패킷은 여전히 `scratchpad/wt170/dist/cli-card.js` 사본을 쓴다 · 전환 = 사용자 설치 결정) → L-50 의 「임시 사본 의존」 은 해결됐다고 쓰지 않는다.

### 검증 · 역검증

- build 0 · tsc 0 · 관련(files-line + recent-same-commit + noise + workspace-writes) 통과 · 전체 **693 + 1 skip**(54 파일).
- 역검증(`198ed13` 분리 worktree · `scratchpad/pb195/mut/m500.mjs` · `m500.log`) **3/3 RED-OK**: F-1 사라진 루트 판별 제거 → 시험 1 빨강 · F-2 실제 실패도 removed 로 숨김 → 시험 2 빨강(가시성) · R-1 같은 커밋 해시 기록을 합침 → 두 보존 시험 빨강. + verify-pack `--break=cli` 빨강.
- 홈 점검(v0~v12): 묶음 앞뒤 모두 새 행 0 · 새 락 0 = CLEAN. 참고: sha `f1be47b7` · mtime 18:42:44Z 불변.

### A-local

- ① L-48: **충족**(정상 skip 잡음 없음 · 실제 실패 보임 · 옛 행 소급 안 함은 한계로 기록).
- ② L-49: **충족(보존 확인)** · 진짜 중복 축소 = **보류**(L-45).
- ③ L-50: **충족(배포 가능한 CLI)** · 세션 실행 경로 전환 = 사용자 결정 · H(가독성) 미관찰.

### 시간

- 500: 03:51–04:01 ≈ 0.17 h / 상한 0.75 h.

## PB195-800 — 최종 단일 후보 검증 (04:51–05:00)

### 결속 (같은 후보를 가리킨다)

| 항목 | 값 |
|---|---|
| 소스 | `feat/2.8-continuity` **`64550fc`**(시험 2 줄 보정 커밋 · 패키지 내용은 `00dee89` 와 같음) · push 안 함 |
| 2.7.3 포함 | `git merge-base --is-ancestor 41069a5 64550fc` = 참 |
| tarball | `scratchpad/pb195/final/passbaton-2.8.0.tgz` · 288,892 B · 130 항목 · **sha256 `44f0f832b09979f1c47c489c0dba318ca5cb743f4ea5ac597fa9aa9f2d921310`** · npm integrity `sha512-x9KBV74k…WmvZwg==` · `00dee89`·`64550fc` 에서 다시 싸도 같은 sha256(시험은 패키지 밖) |
| dist 트리 | 126 파일 · sha256 `6397f758…a61c160` — 빌드 트리(wt170 `dist/`)와 **격리 설치본** `node_modules/passbaton/dist` 가 같음 · 소스 없는 낡은 dist 파일 0 |
| 설치본 회귀 지문 | 12 시험 파일 102 통과 + 1 건너뜀(glama.json — 패키지 밖) · 결과 지문 `9d98419b…54760b3`(`result-cand.json`) |
| 소스 전체 시험 | `64550fc` · tsc 0 · 694 중 실패 0(54 파일 · 1 skip) · 결과 JSON sha256 앞 16 `f18ff22894de14bd` |
| verify-pack(설치·훅·MCP·SQLite·두 CLI) | `64550fc` 에서 13/13 PASS |

### 설치본 회귀 (`scratchpad/pb195/final/verify-final.mjs`)

- 방법: 위 tarball 을 격리 prefix(`pb195-iso/home/tmp/final/prefix-cand`)에 `npm install -g --prefix` → 설치된 패키지 폴더 안 `tests/` 로 시험 사본(wt170 `64550fc`) 복사 · `../src/` import 는 `../dist/` 로 바꿔 **설치된 dist** 를 쓰게 · 실행기만 wt170 의 vitest · 런타임 의존성(better-sqlite3 네이티브 포함)은 설치본 것.
- 대상: B4(cli-info-args 9) · State 보존(active-context 10) · 프로젝트 격리(past-work-isolation 7) · L-06(stop-lock 7 + stop-dedup 9) · 정체성(identity 11 + 1 skip) · files 줄(files-line 2 + noise 17) · L-49(recent-same-commit 2) · 두 CLI(card-snapshot 11 + source-search 15) · 옛 DB 이행(migrate 2) → **전부 초록**.
- 첫 실행에서 2 건 빨강 → 원인은 시험 쪽: ① 서버를 두 번 띄우는 B4 양성 대조가 설치본 첫 실행에서 vitest 기본 5 초 초과 → 시험 시간 상한 60 초 ② identity 의 glama.json 검사(glama.json 은 패키지 `files` 밖) → 있을 때만. 커밋 `64550fc`(제품 코드 무변경 · tarball sha 그대로).

### 역검증 — 낡은 dist · 누락 파일 tarball

| tarball | sha256(앞 16) | 결과 |
|---|---|---|
| 후보 | `44f0f832b09979f1` | 102 통과 · 실패 0 |
| **낡은 dist**(`5c50de5` 빌드 · 같은 2.8.0 이름) | `40689a8a7d84638b` | **18 빨강** — B4 8 · files 줄 2 · 정체성 4 · stop-lock 4 (State 보존·격리·CLI 는 5c50de5 에도 있어 초록 = 예상) |
| **누락 파일**(`64550fc` 에서 `dist/utils/stop-lock.js` 제외) | `73fab21e4ee0e9df` | **22 빨강** — Stop 훅이 모듈 없음으로 실패 → stop-lock 7 · stop-dedup 9 · active-context(Stop 경로) 4 · files-line 2 |

- 판정기가 이름·버전(셋 다 2.8.0)이 아니라 설치된 내용에서 갈린다.

### 기존 DB 사본 이행 → 2.7.2 재열기 (`scratchpad/pb195/final/mig.mjs` · `mig.log`)

- 원본은 복사만(실제 홈 DB `~/.claude/sessions.db` · 프로젝트 DB `ai-service-generator/.claude/sessions.db`+WAL) · 쓰기는 격리 사본에만 · 2.7.2 는 레지스트리에서 격리 prefix 에 따로 설치(`prefix-272`).
- 순서: 사본 → 후보 서버(initialize · memory_stats · session_history) + 후보 SessionStart → 스키마·행 수 비교 → **2.7.2 서버·SessionStart 로 다시 열기**.

| 사본 | 전 | 후보 이행 | 2.7.2 재열기 |
|---|---|---|---|
| 홈 DB(세션 1 · 표 15) | integrity ok | 서버 3/3 · SessionStart 0 · 추가 칸 없음(10-24 R-83 사고 때 이미 2.8 이 이행) · 행 변화 0 | 서버 3/3 · SessionStart 0 · integrity ok · 행 변화 0 |
| 프로젝트 DB(세션 2,482 · 기억 241 · 표 20) | integrity ok | 서버 3/3 · SessionStart 0 · **칸 추가 3**: `sessions.run_origin`·`sessions.summary_source`·`active_context.state_source` · 삭제 0 · 행 변화 0 | 서버 3/3 · SessionStart 0 · integrity ok · 행 변화 0 |

### 홈 점검

- w0~w14 · 묶음 7 번 앞뒤 모두 새 행 0 · 새 락 0 = CLEAN. 참고 sha `f1be47b7` · mtime 18:42:44Z 불변.

### A-local: 충족 · H: 효과 미판정 유지

### 시간

- 800: 04:51–05:00 ≈ 0.15 h / 상한 1.5 h. PB195 누계(000~800) ≈ 1.2 h / 8 h.

## 후보 요약 초안 (900 용 · 대화 세션이 다듬어 제출)

**후보**: passbaton 2.8.0 · 소스 `64550fc` · tarball sha256 `44f0f832…921310` · 2.7.3(`41069a5`) 포함 · npm 미배포 · push 안 함.

**바뀐 것(2.7.2 대비 — 2.7.3 묶음 포함)**
- 2.7.3: 선택 원천·요약 출처 표시·실행 출처(loop) 거름·잡음 축소(files 줄 정상 축약·Solutions 통계 줄).
- 2.8(PB170·174·175): State 칸별 쓰기(Edit 마다 State·blockers 소실 수정) · 과거 참조 프로젝트 격리 · 해법 자동 주입 제거 · PreCompact 훅 전용 DB · 사람 요청 오표시 · 주입 원장 · `passbaton-card` · `passbaton-search`.
- PB195: `--version`/`--help`/`config` 가 서버·DB 를 띄우지 않음(B4) · Stop 락 누적 중단 + 처리 중 상호배제 + 강제 종료 복구(L-06) · serverInfo `passbaton`/패키지 버전 · 기동 줄 도구 수 = 실제 등록(26+3) · 구 bin 7 개 별칭 정책 · files 줄에서 지워진 보조 에이전트 워크트리를 실패로 안 보임(L-48) · FTS 없는 DB 의 기억 폴백도 프로젝트 격리.

**남은 결함·한계**
- L-31 이중 MCP 등록(현재 세션에 서버 둘) — 설정 결정 필요(해결안 가/나/다).
- L-54 서버 `index.ts` 의 루트 탐지에 홈 가드 없음 · 홈 자체 cwd 는 홈 DB 사용 — 제안만.
- L-53 시험 하네스가 실제 HOME 을 홈 가드로 기대(HOME 만 바꾸면 샌다) — 미수정.
- 기존 옛 형식 락 718 개(무효) · `agent-*: failed` 옛 행 153 개는 소급 정리 안 함.
- L-45 같은 세션 같은 문구 줄이기 보류 · C3·C10·C14·C15·C17 보류 그대로.
- 자연 재개 효과(U-01) 미판정 — 설치 뒤 수집.

**되돌리는 법**: `npm install -g passbaton@2.7.2` → Claude Code 재시작. DB 이행은 칸 추가뿐(삭제 0) — 2.7.2 가 이행된 실제 DB 사본을 그대로 연다(위 표). 훅 등록 형식 변경 없음. 2.8 이 만든 v2 락 파일은 2.7.2 가 5 초 규칙으로만 본다(무해).

**사용자 결정 항목**
1. 2.8.0 npm 배포·전역 설치 여부와 시점(배포 간격 — 「너무 빠르다」 기존 의견) · main 병합 · push.
2. L-31: (가) 프로젝트 `settings.local.json` 에 `disabledMcpjsonServers: ["passbaton"]`(권장) / (나) `.mcp.json` 항목 삭제 / (다) 전역 삭제(비권장).
3. 기존 옛 락 718 개 정리 방식(① 둠 ② 설치 뒤 1 일 넘은 옛 형식만 한 번 수동 삭제 ③ 미리보기 있는 CLI 명령).
4. L-54 ③(홈 cwd 에서 홈 DB 쓰기 중단) 여부.
5. 설치 뒤 Astra 패킷의 카드 실행 경로를 wt170 사본에서 설치본 `passbaton-card` 로 바꿀지(L-50 후반).
