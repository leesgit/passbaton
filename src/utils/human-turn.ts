/**
 * 트랜스크립트의 user 줄 하나가 **사람이 한 요청**인가, 그렇다면 그 글은 무엇인가.
 *
 * ★ 왜 한 곳인가 (2.6.1)
 *   Stop(session-end) 과 PreCompact 가 각자 판별했고, PreCompact 쪽은 아예 판별이 없었다.
 *   2026-10-22 컴팩션 직후 주입이 `♻️ Recovered after compaction: <task-notification>` 이었다 —
 *   하네스가 보낸 백그라운드 작업 알림이 「하던 일」 이 됐다. Stop 쪽도 `<task-notification>` 은
 *   거르지 못했다(시스템 리마인더·명령 태그만 벗겼다).
 *
 * ★ 지시문 추출(directive.ts 의 isMachinePrompt)과 **정책이 다르다** (Astra reply-140 PB140-01)
 *   지시문은 의심스러우면 버리는 쪽이 안전하다 — 잘못 저장하면 매 세션 재주입된다.
 *   사람 요청은 버리면 안 된다 — 「중단해」 를 놓치면 그 앞의 요청이 「마지막 요청」 이 된다.
 *   그래서 여기서는
 *     1) 벗겨 낼 수 있는 문맥 봉투(system-reminder 등)를 **먼저 벗기고** 남은 사람 글을 본다
 *     2) 하네스 알림은 **봉투 자체**(맨 앞 태그·알림 전용 태그)로만 판정한다 — 알림 본문 속
 *        `<command-args>` 인용은 명령이 아니다
 *     3) 명령 인자는 진짜 명령 봉투(맨 앞이 <command-message>/<command-name>)일 때만 꺼낸다
 *     4) 길이로 사람 여부를 정하지 않는다 — 최소 길이는 Stop 의 요약 품질 규칙이고 거기서 건다
 *     5) 글 **중간·뒤의** 완전한 태그 블록(`<bash-stdout>…</bash-stdout>` 등)은 사람이 붙여 넣은 인용이다 —
 *        걷어 내지 않는다(Astra reply-142 PB142-03). 실측(2026-10-22, 이 PC 트랜스크립트 500 개): 하네스 출력은
 *        194 건 모두 **메시지 맨 앞 봉투**였고 봉투 뒤에 사람 글이 이어진 경우 0 · 사람 글 뒤에 하네스 블록이
 *        붙어 온 경우 0. 그래서 하네스 출력 = 맨 앞 봉투(→ 메시지 전체가 기계 줄)로만 판정한다
 *
 * 빈 문자열 = 사람 요청이 아니다(메타 턴·컴팩션 요약·하네스 알림·셸 입출력·도구 결과).
 */

export interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  message?: { role?: string; content?: unknown };
  content?: unknown;
}

/** 사람 글을 감싸거나 앞에 붙는 문맥 — 벗기면 사람 글이 남을 수 있다. */
const CONTEXT_WRAPPERS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  // Codex support (2026-07-09): Codex injects <environment_context> into the first user message
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  // Gemini support (2026-07-10): Gemini injects <session_context> into the first user message
  /<session_context>[\s\S]*?<\/session_context>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
];

/** 메시지 **전체가** 하네스 산출물인 봉투. 맨 앞에 올 때만 본다. */
const MACHINE_ENVELOPE = /^<(?:task-notification|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|user-prompt-submit-hook)\b/i;

/** 맨 앞 봉투의 완전한 블록들. 걷어 내고 남는 글이 있으면 사람이 붙여 넣은 인용 + 요청이다. */
export const ENVELOPE_BLOCKS = /<(task-notification|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** 명령 봉투 — 맨 앞일 때만 진짜 명령이다. */
const COMMAND_ENVELOPE = /^<(?:command-message|command-name)>/;

export interface HumanTurn {
  text: string;
  /** 진짜 명령 봉투의 <command-args> 에서 꺼낸 글이다 */
  viaCommand: boolean;
  /** 닫히지 않은 맨 앞 봉투 — 잘린 기계 알림인지 사람의 불완전 인용인지 글만으로 가를 수 없다 */
  uncertain?: boolean;
}

/** 맨 앞에 붙은 봉투 블록 하나(뒤 공백 포함). */
const LEADING_BLOCK = /^<(task-notification|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>\s*/i;

/**
 * 요청을 **한 줄로 요약할 때** 쓸 글. 원문(인용 포함)은 그대로 두고, 요약은 **맨 앞에 붙여 넣은** 인용
 * 블록을 건너뛴 사람 글부터 본다 — `<bash-stdout>오류</bash-stdout>\n이 오류를 설명해줘` 의 요청은
 * 「이 오류를 설명해줘」 다(Astra reply-144 PB144-02). 글 중간·뒤의 인용(`이 태그를 설명해줘: <bash-stdout>…`)은
 * 요청 문장의 일부라 건드리지 않는다. 건너뛰고 남는 글이 없으면 원문.
 */
export function requestLine(text: string): string {
  let rest = text.trim();
  while (LEADING_BLOCK.test(rest)) rest = rest.replace(LEADING_BLOCK, '');
  return rest.trim() || text;
}

export function humanText(entry: TranscriptEntry): string {
  return humanTurn(entry).text;
}

export function humanTurn(entry: TranscriptEntry): HumanTurn {
  const none: HumanTurn = { text: '', viaCommand: false };
  // 슬래시 커맨드 확장으로 주입된 메타 턴은 사용자 요청이 아님
  // (예: "# /work - 프로젝트 작업 메인 명령어 (v2)…" 커맨드 본문 전체가 여기 들어옴)
  if (entry.isMeta === true) return none;
  // 컴팩션 요약은 user 줄로 기록되지만 사람이 쓴 것이 아니다.
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return none;

  const content = entry.message?.content ?? entry.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }

  for (const re of CONTEXT_WRAPPERS) text = text.replace(re, '');
  text = text.trim();

  // 맨 앞 봉투: 그 블록들을 걷어 내고 사람 글이 남지 않으면 기계 줄이다(실측 194/194 가 이 모양).
  //   남으면 — `<bash-stdout>오류</bash-stdout>\n이 오류 설명해줘` — 사람이 붙여 넣은 인용 + 요청이다.
  //   닫히지 않은 봉투(잘린 알림)는 걷어 낼 수 없으므로 기계 줄로 본다(Astra reply-143 PB143-02).
  if (MACHINE_ENVELOPE.test(text)) {
    const rest = text.replace(ENVELOPE_BLOCKS, '').trim();
    if (!rest) return none;
    // 닫히지 않은 봉투: 사람 요청으로 쓰지 않지만 「없었던 줄」 로도 치지 않는다 — 그 앞의 옛 요청이
    //   「마지막 요청」 으로 올라오지 않게 호출부가 표지를 본다(PB144-03)
    if (MACHINE_ENVELOPE.test(rest)) return { ...none, uncertain: true };
    return { text, viaCommand: false };
  }

  if (COMMAND_ENVELOPE.test(text)) {
    // 슬래시 커맨드 실행 시 실제 사용자 요청은 <command-args> 안에 있음 → 삭제 말고 추출
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '';
    // 인자 없는 명령(`/ashfall` 만)은 요청 글이 없다 — 명령 이름 보존은 2.7 라우팅(PB139-12)에서
    return { text: args, viaCommand: args.length > 0 };
  }

  // 시스템/메타 메시지 스킵
  if (text.startsWith('[Request interrupted')) return none;
  if (text.startsWith('This session is being continued')) return none;
  if (text.startsWith('No response requested')) return none;

  return { text, viaCommand: false };
}
