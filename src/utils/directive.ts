/**
 * directive 품질 게이트.
 *
 * 저장(UserPromptSubmit)과 주입(SessionStart·PreCompact) **양쪽에서** 같은 함수를 쓴다.
 * 저장 쪽만 거르면 이미 DB 에 들어간 오추출이 매 세션 🔴 로 재주입된다.
 *
 * ★ 2026-10-22 Ashfall 실측(실 DB 40 행): **37 행이 사람이 쓴 말이 아니었다.**
 *   `<task-notification>`(서브에이전트 결과가 사용자 턴으로 들어온 것) · 랄프 PROMPT.md 전문 ·
 *   다른 에이전트에게 보낸 패킷(「당신은 Ashfall 의 …」) 에서 「반드시/절대/중요/규칙」 뒤를 잘라 왔다.
 *   남은 3 행도 「중요 인물 승격 진행해줘」 → 「인물 승격 진행해줘」 같은 오탐이었다.
 *   ⇒ 문장 모양만 보는 것으로는 못 막는다. **출처**를 먼저 본다(isDirectiveSource).
 *
 * P4 (2026-07-08) 규칙: DIRECTIVE_PATTERNS 의 `.+` 탐욕 캡처가 붙여넣은 산출물
 * (JSON 평가지/스토리보드/코드)에서 '절대/반드시/must' 뒤를 통째로 잡았다.
 * 진짜 지시문은 짧고 자족적 — 데이터/코드 구문 냄새가 나면 거부.
 */

/** 지시문을 뽑아도 되는 사람 메시지의 최대 길이. 이보다 길면 문서·붙여넣기로 본다. */
export const MAX_DIRECTIVE_PROMPT = 300;

/** 명시 표지 — 길이·출처 제한 없이 받는다. 사람이 「이건 기억해」 라고 한 것이다. */
// ⚠ `\b` 는 ASCII 기준이라 「#기억 」 뒤에서 경계를 못 찾는다 — 한글 쪽에는 붙이지 않는다.
export const EXPLICIT_MARKER = /#(?:기억|remember\b)/i;

/** 사람이 아니라 하네스·에이전트가 만든 사용자 턴. */
export function isMachinePrompt(prompt: string): boolean {
  const p = prompt.trimStart();
  return /^<(?:task-notification|system-reminder|command-message|local-command|bash-|user-prompt-submit-hook)/i.test(p)
    || /<task-id>|<tool-use-id>|<output-file>/.test(prompt);
}

/**
 * 이 사용자 턴에서 (명시 표지 없이) 지시문을 뽑아도 되는가.
 * 저장 때는 프롬프트 전문으로, 주입 때는 저장된 context(프롬프트 앞 300 자)로 부른다 —
 * context 가 300 자를 꽉 채웠다면 원문은 그보다 길었다는 뜻이다.
 */
export function isDirectiveSource(prompt: string | null | undefined): boolean {
  if (!prompt) return true;                         // 출처를 모르는 옛 행은 문장 검사만
  if (EXPLICIT_MARKER.test(prompt)) return true;
  if (isMachinePrompt(prompt)) return false;
  return prompt.length < MAX_DIRECTIVE_PROMPT;
}

/**
 * 2.6.0 추가 규칙:
 *   - 너무 짧은 조각(10 자 미만) — 「반드시 해야 할 것」 제목에서 남은 「해야 할 것」
 *   - 질문 — 지시가 아니다(「…있는가.」 「…할까요?」)
 *   - 이스케이프된 줄바꿈(`\n` 두 글자) — 문서 본문을 잘라 온 흔적
 *   - 글자가 아닌 것으로 시작(「— 사용자 …」 「(값 보기 …」 「*"픽셀 …」) — 문장 중간
 *   - 괄호가 짝이 안 맞음(「…결합되므로).」) — 문장 중간에서 잘림
 *   - 조사로 끝남(「…기록은」 「…유지) (c) 그 밖」) — 문장이 끝나지 않음
 */
export function isValidDirective(raw: string): boolean {
  const d = raw.trim();
  if (d.length < 10) return false;                                    // 제목·조각
  if (d.length > 120) return false;                                   // run-on 캡처
  if (d.includes('\\n')) return false;                                // 잘린 문서 본문
  if (/[?？]\s*$/.test(d)) return false;                              // 질문
  if (/(?:는가|은가|인가|있나|없나|할까|일까|나요|까요|습니까|입니까)[.。!]?\s*$/.test(d)) return false;
  if (!/^[\p{L}\p{N}]/u.test(d)) return false;                        // 문장 중간에서 시작
  const opens = (d.match(/[(（[]/g) || []).length;
  const closes = (d.match(/[)）\]]/g) || []).length;
  if (opens !== closes) return false;                                 // 잘린 괄호
  if (/(?:은|는|을|를|의|와|과|에서|으로|로|및|그 밖)\s*[,，]?\s*$/.test(d)) return false; // 끝나지 않은 문장
  if (/"\s*:\s*|"\s*\}|\{\s*"|"\},\{"|\}\]|\}\}/.test(d)) return false; // JSON 구조 구문
  if (/"(?:whatWorks|itemCode|weight|factor|impact|verdict|correction|role|path|purpose|problem|action|files)"/.test(d)) return false; // 평가지/JSON 키
  if (d.includes('`') || d.includes('**') || /\|.*\|.*\|/.test(d)) return false; // 코드/마크다운 표
  if ((d.match(/"/g) || []).length >= 4) return false;                // 따옴표 과다=구조화 데이터
  if (/<\/?[a-z][\w-]*>/i.test(d)) return false;                      // 태그 조각(</result> 등)
  // 어시스턴트 산문 중간이 잘린 파편은 소문자 라틴 문자로 시작함
  // (진짜 영어 지시문은 대문자 명령형: "Never …", "Always …", "Do NOT …").
  // 2.6.0: 한글이 섞인 문장은 예외 — 「main 브랜치에 직접 푸시하지 말 것」 처럼 식별자로
  // 시작하는 한국어 지시문을 버리고 있었다.
  if (/^[a-z]/.test(d) && !/[가-힣]/.test(d)) return false;
  return true;
}

export const DIRECTIVE_PATTERNS: Array<{ pattern: RegExp; priority: 'high' | 'normal' }> = [
  { pattern: /(?:절대|never)\s+(.+)/i, priority: 'high' },
  { pattern: /(?:항상|always)\s+(.+)/i, priority: 'high' },
  { pattern: /(?:반드시|must)\s+(.+)/i, priority: 'high' },
  { pattern: /never\s+(?:use|modify|touch)\s+(.+)/i, priority: 'high' },
  { pattern: /always\s+(?:use|check|include)\s+(.+)/i, priority: 'high' },
  { pattern: /#(?:기억|remember)\s+(.+)/i, priority: 'normal' },
  // 2.6.0: 「중요 인물 승격 진행해줘」 → 「인물 승격 진행해줘」 같은 오탐 — 콜론이 있을 때만.
  { pattern: /(?:important|중요)\s*[:：]\s*(.+)/i, priority: 'normal' },
  { pattern: /(?:rule|규칙)\s*[:：]\s*(.+)/i, priority: 'normal' },
];


/**
 * 사용자 턴 하나에서 지시문을 뽑는다 — 출처 규칙 → 패턴 → 문장 규칙.
 * 하네스·에이전트 턴에서는 아무것도, 긴 붙여넣기에서는 명시 표지(#기억)만.
 */
export function extractDirectives(prompt: string): Array<{ directive: string; priority: 'high' | 'normal' }> {
  if (isMachinePrompt(prompt)) return [];
  const sourceOk = isDirectiveSource(prompt);
  const out: Array<{ directive: string; priority: 'high' | 'normal' }> = [];
  for (const { pattern, priority } of DIRECTIVE_PATTERNS) {
    if (!sourceOk && !pattern.source.startsWith('#')) continue;
    const match = prompt.match(pattern);
    if (!match || !match[1]) continue;
    const directive = match[1].trim().slice(0, 200);
    if (directive.length < 5 || !isValidDirective(directive)) continue;
    if (!out.some(o => o.directive === directive)) out.push({ directive, priority });
  }
  return out;
}

/**
 * 저장된 행이 **지금 규칙으로도** 지시문인가. 옛 판이 넣은 오탐을 지우지 않고 주입에서만 뺀다.
 * context 는 원문 앞 300 자다 — 그보다 짧으면 원문 전체이므로 다시 뽑아 같은 지시가 나오는지 본다.
 * 출처를 모르는 행(context 없음)은 문장 규칙만 본다.
 */
export function isStillDirective(directive: string, context: string | null | undefined): boolean {
  if (!isValidDirective(directive)) return false;
  if (!context) return true;
  if (!isDirectiveSource(context)) return false;
  if (context.length < MAX_DIRECTIVE_PROMPT) {
    return extractDirectives(context).some(x => x.directive === directive.trim());
  }
  return true;   // 명시 표지가 있는 긴 원문 — 잘린 context 로는 다시 뽑을 수 없다
}
