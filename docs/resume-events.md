# 재개 사건 기록 — 최소 양식 (2.8 · Astra reply-170 PB170-100 · C9)

다른 개선이 「재개를 낫게 했다」 고 말하려면 기준선이 먼저 있어야 한다. 기준선은 **자연 발생** 재개(컴팩션 직후 · 새 세션)마다
한 줄씩 쌓는다. 통제된 시험(예: C7 의 격리 컴팩션)은 `sample: controlled` 로 적고 **효과 집계에 넣지 않는다.**

## 자동 칸 — passbaton 이 적는다

`hookTrace` 를 켜면(`.claude/passbaton.config.json` → `features.hookTrace.enabled: true`) SessionStart 가
`.claude/hook-trace.log` 에 재개마다 한 줄을 남긴다:

```
hook=session-start:resume-event project=<p> version=<passbaton 버전> host=claude|codex|gemini source=startup|resume|compact
  session=<session_id> card=<원천 경로@sha1,…|none> emitted_sha=<모델에 들어간 본문 sha256 앞 12>
```

같은 로그의 `hook=session-start:frag` / `:omit` / `:emitted` 줄이 그 본문의 조각(원천·바이트·위치)과 빠진 것(사유)이다(N3).
자동 칸은 **그 줄에서 그대로 옮긴다** — 다른 재개·다른 빌드의 값을 붙이면 `checkResumeEvent` 가 거부한다.

## 판정 칸 — 사람·대화 세션이 근거와 함께

JSONL 한 줄 = 한 재개(`src/utils/resume-event.ts` 의 `ResumeEventRecord`):

| 칸 | 값 | 규칙 |
|---|---|---|
| `sample` | `natural` · `controlled` | 효과 집계는 natural 만 |
| `first_action` | 재개 뒤 첫 실제 행동(한 줄) | 「무엇을 했나」 — 의도가 아니라 행동 |
| `calls_before_first_action` | 정수 · `null` | 첫 행동 전 도구 호출 수 |
| `first_action_ok` | `yes` · `no` · `unjudged` | 정지 유지·원문 확인 포함 · 판정했으면 `judge`·`evidence` 필수 |
| `verdict` | `better` · `same` · `worse` · `unjudged` | `first_action_ok` 가 unjudged 면 unjudged · **better 는 첫 행동이 맞았을 때만** |
| `judge` | `human` · `session` · `null` | |
| `evidence` | 판정 근거(파일·절·대화 위치) | |
| `requery_reason` | 다시 물은 이유 · `null` | |

⛔ **호출 0 으로 끝난 오행동은 효율 개선이 아니다** — `calls_before_first_action: 0` 이어도 `first_action_ok: no` 면 better 를 받지 않는다.
⛔ 미측정은 효과가 아니다 — 판정하지 않은 줄은 `unjudged` 로 남긴다.
