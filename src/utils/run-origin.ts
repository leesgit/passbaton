/**
 * 실행 출처 (2.7.3 · Astra reply-154 PB154-A).
 *
 * 랄프 같은 자동 루프는 `PASSBATON_ROLE=loop` 를 내보내고, 훅은 상속된 환경에서 그것을 읽는다.
 *
 * ⛔ 계약:
 *   - 명시된 값만 믿는다. 의미 있는 값은 `loop` 하나뿐이다.
 *   - 미설정·빈 값·그 밖의 값(`Loop` · `chat` · `1` …) = `unknown`.
 *   - `loop` 가 아니라는 이유로 「대화 세션」 이라고 단정하지 않는다 — 그래서 `chat` 같은 값을 만들지 않는다.
 *   - DB 의 옛 행(칸이 NULL)도 `unknown` 이다. 프롬프트 문구로 과거 행을 재분류하지 않는다.
 */

export type RunOrigin = 'loop' | 'unknown';

export const ORIGIN_ENV = 'PASSBATON_ROLE';

/** 환경에서 이번 프로세스의 출처를 읽는다. 앞뒤 공백만 허용 — 대소문자는 엄격하다. */
export function readRunOrigin(env: NodeJS.ProcessEnv = process.env): RunOrigin {
  const v = env[ORIGIN_ENV];
  return typeof v === 'string' && v.trim() === 'loop' ? 'loop' : 'unknown';
}

/** DB 칸 값을 출처로. NULL·모르는 값 = unknown. */
export function originOf(raw: unknown): RunOrigin {
  return raw === 'loop' ? 'loop' : 'unknown';
}
