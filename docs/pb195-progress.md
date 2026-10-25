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
