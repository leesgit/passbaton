/**
 * 트랜스크립트의 user 줄 하나가 **사람이 한 요청**인가, 그렇다면 그 글은 무엇인가.
 *
 * ★ 왜 한 곳인가 (2.6.1)
 *   Stop(session-end) 과 PreCompact 가 각자 판별했고, PreCompact 쪽은 아예 판별이 없었다.
 *   2026-10-22 컴팩션 직후 주입이 `♻️ Recovered after compaction: <task-notification>` 이었다 —
 *   하네스가 보낸 백그라운드 작업 알림이 「하던 일」 이 됐다. Stop 쪽도 `<task-notification>` 은
 *   거르지 못했다(시스템 리마인더·명령 태그만 벗겼다).
 *
 * 빈 문자열 = 사람 요청이 아니다(메타 턴·컴팩션 요약·하네스 알림·셸 입출력·도구 결과).
 */

import { isMachinePrompt } from './directive.js';

export interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  message?: { role?: string; content?: unknown };
  content?: unknown;
}

export function humanText(entry: TranscriptEntry): string {
  // 슬래시 커맨드 확장으로 주입된 메타 턴은 사용자 요청이 아님
  // (예: "# /work - 프로젝트 작업 메인 명령어 (v2)…" 커맨드 본문 전체가 여기 들어옴)
  if (entry.isMeta === true) return '';
  // 컴팩션 요약은 user 줄로 기록되지만 사람이 쓴 것이 아니다.
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return '';

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

  // 슬래시 커맨드 실행 시 실제 사용자 요청은 <command-args> 안에 있음 → 삭제 말고 추출
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch && argsMatch[1].trim().length >= 3) {
    return argsMatch[1].trim();
  }

  // 하네스 알림(<task-notification> 등)·셸 입출력(<bash-input>/<bash-stdout>)은 통째로 사람 요청이 아니다.
  // ⚠ <command-message> 도 여기 걸리지만 위에서 인자를 이미 뽑았다 — 인자 없는 명령은 요청 글이 없다.
  if (isMachinePrompt(text)) return '';

  // system-reminder, local-command 태그 제거
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  // Codex support (2026-07-09): Codex injects <environment_context> into the first user message -> strip it
  text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
  // Gemini support (2026-07-10): Gemini injects <session_context> into the first user message -> strip it
  text = text.replace(/<session_context>[\s\S]*?<\/session_context>/g, '').trim();
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim();
  text = text.replace(/<command-name>[\s\S]*?<\/command-name>/g, '').trim();
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>/g, '').trim();
  text = text.replace(/<command-args>[\s\S]*?<\/command-args>/g, '').trim();
  text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '').trim();
  if (text.length < 5) return '';

  // 시스템/메타 메시지 스킵
  if (text.startsWith('[Request interrupted')) return '';
  if (text.startsWith('This session is being continued')) return '';
  if (text.startsWith('No response requested')) return '';

  return text;
}
