/**
 * 요약(last_work · State)의 생성 출처 (2.7.3 · Astra reply-165 PB165-200).
 *
 * Stop 훅은 사다리로 요약을 만든다: 커밋 메시지 → assistant 문장 추출 → 폴백(액션 줄·파일 목록) → 「결과 요약 없음」.
 * 같은 칸에 담기면 읽는 쪽은 「커밋에서 왔다」 와 「assistant 가 그렇게 말했다」 를 구별할 수 없다 —
 * 설명문이 검증 결과처럼 읽힌다. 그래서 **실제로 고른 분기**를 같은 행에 함께 적는다.
 *
 * ⛔ 계약:
 *   - 값은 Stop 이 그 행을 쓸 때 정한다. 읽는 쪽이 글 모양으로 추정하지 않는다.
 *   - 옛 행(칸이 NULL)·다른 도구가 쓴 행·모르는 값 = `unknown`. 소급해 채우지 않는다.
 *   - 표시는 같은 기록의 것만 — State 는 active_context 의 칸, Recent 는 그 sessions 행의 칸.
 *   - 커밋 메시지 출처도 완료 증명이 아니다(트랜스크립트 전체에서 모은 것이다). 출처를 밝힐 뿐이다.
 */

export type SummarySource = 'commit' | 'assistant-text' | 'fallback' | 'no-result';

const SOURCES: ReadonlySet<string> = new Set<SummarySource>(['commit', 'assistant-text', 'fallback', 'no-result']);
const isSource = (v: unknown): v is SummarySource => typeof v === 'string' && SOURCES.has(v);

/** DB 칸 값을 출처로. NULL·모르는 값 = unknown. */
export function summarySourceOf(raw: unknown): SummarySource | 'unknown' {
  return isSource(raw) ? raw : 'unknown';
}

const LABEL: Record<SummarySource | 'unknown', string> = {
  commit: 'via commit message',
  'assistant-text': 'via assistant text',
  fallback: 'via fallback (action line or file list)',
  'no-result': 'via no result',
  unknown: 'via unknown',
};

/** 표시용 한 조각 — 「via commit message」 처럼. */
export function viaLabel(raw: unknown): string {
  return LABEL[summarySourceOf(raw)];
}
