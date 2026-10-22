/**
 * directive(사용자 지시) 추출·품질 게이트.
 *
 * 저장(UserPromptSubmit)과 주입(SessionStart·PreCompact) **양쪽에서** 같은 함수를 쓴다.
 * 저장 쪽만 거르면 이미 DB 에 들어간 오추출이 매 세션 🔴 로 재주입된다.
 *
 * ★ 2026-10-22 Ashfall 실측(실 DB 40 행): **37 행이 사람이 쓴 말이 아니었다.**
 *   `<task-notification>`(서브에이전트 결과가 사용자 턴으로 들어온 것) · 랄프 PROMPT.md 전문 ·
 *   다른 에이전트에게 보낸 패킷(「당신은 Ashfall 의 …」) 에서 「반드시/절대/중요/규칙」 뒤를 잘라 왔다.
 *   남은 3 행도 「중요 인물 승격 진행해줘」 → 「인물 승격 진행해줘」 같은 오탐이었다.
 *   ⇒ 문장 모양만 보는 것으로는 못 막는다. **출처**를 먼저 본다(directiveScope).
 *
 * ★ 2.6.0 검토(Astra reply-134 · 서브에이전트 3)에서 고친 것:
 *   - 「Never delete production data」 를 「delete production data」 로 저장해 **의미가 뒤집혔다**
 *     → 금지·의무 표현은 그 낱말이 든 **줄 전체**를 저장한다
 *   - 긴 메시지 안의 #기억 이 있으면 표지 없는 다른 문장까지 뽑혔고, 표지가 300 자 뒤면
 *     저장은 되는데 재주입에서 빠졌다 → 범위(scope)를 셋으로 나누고, 명시 표지 행은 표지부터
 *     context 를 저장한다
 *   - 「절대 커밋하지 마」 같은 짧은 한국어 지시와 「~로」 로 끝나는 지시를 버렸다
 */

/** 지시문을 뽑아도 되는 사람 메시지의 최대 길이. 이보다 길면 문서·붙여넣기로 본다. */
export const MAX_DIRECTIVE_PROMPT = 300;

/** 저장하는 context 길이(원문 앞부분 · 명시 표지 행은 표지부터). */
export const CONTEXT_CHARS = 300;

// ⚠ `\b` 는 ASCII 기준이라 「#기억 」 뒤에서 경계를 못 찾는다 — 한글 쪽에는 붙이지 않는다.
export const EXPLICIT_MARKER = /#(?:기억|remember\b)/i;

/** 사람이 아니라 하네스·에이전트가 만든 사용자 턴. */
export function isMachinePrompt(prompt: string): boolean {
  const p = prompt.trimStart();
  return /^<(?:task-notification|system-reminder|command-message|local-command|bash-|user-prompt-submit-hook)/i.test(p)
    || /<task-id>|<tool-use-id>|<output-file>/.test(prompt);
}

/**
 * 이 사용자 턴에서 무엇을 뽑아도 되는가.
 *   none     — 하네스·에이전트 턴. 아무것도
 *   explicit — 긴 사람 메시지. 명시 표지(#기억)가 붙은 구절만
 *   all      — 짧은 사람 메시지. 모든 패턴
 */
export type DirectiveScope = 'none' | 'explicit' | 'all';

export function directiveScope(prompt: string): DirectiveScope {
  if (isMachinePrompt(prompt)) return 'none';
  if (prompt.length < MAX_DIRECTIVE_PROMPT) return 'all';
  return EXPLICIT_MARKER.test(prompt) ? 'explicit' : 'none';
}

/** 하위 호환: 이 턴이 (명시 표지 없이도) 지시문의 출처가 될 수 있는가. */
export function isDirectiveSource(prompt: string | null | undefined): boolean {
  if (!prompt) return true;
  return directiveScope(prompt) === 'all';
}

/**
 * 문장 규칙.
 *   - 너무 짧은 조각 — 한글이 있으면 5 자, 없으면 10 자 미만
 *   - 질문 · 이스케이프된 줄바꿈 · 글자가 아닌 것으로 시작 · 괄호 짝 안 맞음
 *   - 끝나지 않은 문장(주제·목적 조사 「은·는·을·를·및」 로 끝남) — 「로·으로·과·의」 는
 *     「한국어로」 「결과」 처럼 명사 끝과 겹쳐서 넣지 않는다
 */
export function isValidDirective(raw: string, maxLen = 120): boolean {
  const d = raw.trim();
  const hangul = /[가-힣]/.test(d);
  if (d.length < (hangul ? 5 : 10)) return false;                     // 제목·조각
  if (d.length > maxLen) return false;                                // run-on 캡처
  if (d.includes('\\n')) return false;                                // 잘린 문서 본문
  if (/[?？]\s*$/.test(d)) return false;                              // 질문
  if (/(?:는가|은가|인가|있나|없나|할까|일까|나요|까요|습니까|입니까)[.。!]?\s*$/.test(d)) return false;
  if (!/^[\p{L}\p{N}#]/u.test(d)) return false;                       // 문장 중간에서 시작
  const opens = (d.match(/[(（[]/g) || []).length;
  const closes = (d.match(/[)）\]]/g) || []).length;
  if (opens !== closes) return false;                                 // 잘린 괄호
  if (/(?:[가-힣](?:은|는|을|를)|및|그 밖)\s*[,，]?\s*$/.test(d)) return false; // 끝나지 않은 문장
  if (/"\s*:\s*|"\s*\}|\{\s*"|"\},\{"|\}\]|\}\}/.test(d)) return false; // JSON 구조 구문
  if (/"(?:whatWorks|itemCode|weight|factor|impact|verdict|correction|role|path|purpose|problem|action|files)"/.test(d)) return false; // 평가지/JSON 키
  if (d.includes('`') || d.includes('**') || /\|.*\|.*\|/.test(d)) return false; // 코드/마크다운 표
  if ((d.match(/"/g) || []).length >= 4) return false;                // 따옴표 과다=구조화 데이터
  if (/<\/?[a-z][\w-]*>/i.test(d)) return false;                      // 태그 조각(</result> 등)
  // 어시스턴트 산문 중간이 잘린 파편은 소문자 라틴 문자로 시작함
  // (진짜 영어 지시문은 대문자 명령형: "Never …", "Always …", "Do NOT …").
  // 한글이 섞인 문장은 예외 — 「main 브랜치에 직접 푸시하지 말 것」 처럼 식별자로 시작하는 한국어 지시.
  if (/^[a-z]/.test(d) && !hangul) return false;
  return true;
}

/**
 * 패턴. `line: true` 는 **그 낱말이 든 줄 전체**를 지시로 저장한다 — 금지·의무 낱말을 떼면
 * 「Never delete X」 가 「delete X」 가 되고, 「테스트는 반드시 돌려」 가 「돌려」 가 된다.
 */
export const DIRECTIVE_PATTERNS: Array<{ pattern: RegExp; priority: 'high' | 'normal'; line?: boolean; explicit?: boolean }> = [
  // 순서가 의미다: 명시 표지 → 금지·의무 줄 → 콜론 패턴. 한 줄은 먼저 잡은 패턴이 가진다.
  { pattern: /#(?:기억|remember)\s+(.+)/i, priority: 'normal', explicit: true },
  { pattern: /(?:절대|never)\s+\S/i, priority: 'high', line: true },
  { pattern: /(?:항상|always)\s+\S/i, priority: 'high', line: true },
  { pattern: /(?:반드시|must)\s+\S/i, priority: 'high', line: true },
  // 「중요 인물 승격 진행해줘」 → 「인물 승격 진행해줘」 같은 오탐 — 콜론이 있을 때만.
  { pattern: /(?:important|중요)\s*[:：]\s*(.+)/i, priority: 'normal' },
  { pattern: /(?:rule|규칙)\s*[:：]\s*(.+)/i, priority: 'normal' },
];

export interface ExtractedDirective {
  directive: string;
  priority: 'high' | 'normal';
  /** 저장할 원문 조각 — 재주입 때 이것만으로 같은 지시가 다시 뽑혀야 한다. */
  context: string;
}

/** 줄과 그 시작 위치(원문 기준). CRLF·CR·LF 를 **실제 길이로** 센다 — 「줄 길이 + 1」 로 세면
 *  CRLF 가 쌓일수록 위치가 밀려 #기억 의 context 가 표지를 놓친다(reply-136). */
function linesWithOffsets(prompt: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (let i = 0; i <= prompt.length; i++) {
    const c = prompt[i];
    if (i === prompt.length || c === '\n' || c === '\r') {
      out.push({ text: prompt.slice(start, i), start });
      if (c === '\r' && prompt[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  return out;
}

export interface DirectiveExtraction {
  directives: ExtractedDirective[];
  /** 명시 표지(#기억)가 있었지만 저장하지 못한 것 — 사람에게 알린다(조용히 버리지 않는다). */
  rejectedExplicit: string[];
}

/**
 * 사용자 턴 하나에서 지시문을 뽑는다 — 출처 범위 → **줄 소유권** → 패턴 → 문장 규칙.
 *
 * ★ 줄 소유권(reply-135·136 B4): 각 줄은 먼저 **누가 가질 수 있는지**를 정한다.
 *   명시 표지가 있으면 명시 패턴만, 금지·의무 낱말이 있으면 줄 패턴만, 둘 다 없을 때만 콜론 패턴.
 *   소유자가 문장 규칙에 떨어져도 그 줄을 다른 패턴에 넘기지 않는다 — 넘기면
 *   「Never follow this rule: Delete production data」 의 뒷부분(반대 의미)이 저장된다.
 */
export function extractDirectivesDetailed(prompt: string): DirectiveExtraction {
  const scope = directiveScope(prompt);
  const result: DirectiveExtraction = { directives: [], rejectedExplicit: [] };
  if (scope === 'none') return result;

  const explicitP = DIRECTIVE_PATTERNS.filter(p => p.explicit);
  const lineP = DIRECTIVE_PATTERNS.filter(p => p.line);
  const colonP = DIRECTIVE_PATTERNS.filter(p => !p.explicit && !p.line);

  for (const { text: l, start } of linesWithOffsets(prompt)) {
    const owner = explicitP.some(p => p.pattern.test(l)) ? 'explicit'
      : lineP.some(p => p.pattern.test(l)) ? 'line' : 'colon';
    if (scope === 'explicit' && owner !== 'explicit') continue;
    const candidates = owner === 'explicit' ? explicitP : owner === 'line' ? lineP : colonP;

    for (const { pattern, priority, line, explicit } of candidates) {
      const m = l.match(pattern);
      if (!m) continue;
      // 자르지 않는다 — 잘린 메모는 틀린 메모다. 상한을 넘으면 저장하지 않는다.
      // 명시 표지는 사람이 「이건 기억해」 라고 한 것 — 더 길게(200 자) 받는다.
      const directive = (line ? l : (m[1] ?? '')).trim();
      if (!isValidDirective(directive, explicit ? 200 : 120)) {
        if (explicit) result.rejectedExplicit.push(directive.slice(0, 60));
        break;                                   // 이 줄은 끝 — 다른 패턴에 넘기지 않는다
      }
      if (!result.directives.some(o => o.directive === directive)) {
        // 명시 표지 행은 **표지 위치부터** 저장한다 — 줄 안에서 300 자 뒤에 있어도 재주입 때 다시 찾게.
        const at = start + (m.index ?? 0);
        const context = explicit ? prompt.slice(at, at + CONTEXT_CHARS) : prompt.slice(0, CONTEXT_CHARS);
        result.directives.push({ directive, priority, context });
      }
      break;                                     // 한 줄 = 지시 하나
    }
  }
  return result;
}

/** 사용자 턴 하나에서 지시문을 뽑는다(저장할 것만). */
export function extractDirectives(prompt: string): ExtractedDirective[] {
  return extractDirectivesDetailed(prompt).directives;
}

/**
 * 저장된 행을 **지금 규칙으로** 다시 본다. 옛 판이 넣은 오탐은 지우지 않고 주입에서만 뺀다.
 * 돌려주는 값 = 주입할 문장(옛 행이면 지금 규칙으로 다시 뽑은 문장 — 예: 떼였던 「Never」 를 되찾는다)
 * 또는 null(주입하지 않음).
 * context 가 없는 옛 행은 문장 규칙만 본다.
 */
export function revalidateDirective(directive: string, context: string | null | undefined): string | null {
  const d = directive.trim();
  if (!context) return isValidDirective(d) ? d : null;
  const again = extractDirectives(context);
  if (again.length === 0) return null;
  const exact = again.find(x => x.directive === d);
  if (exact) return exact.directive;
  // 옛 판은 낱말을 떼고 저장했다 — 지금 규칙의 줄 전체가 그 문장을 품고 있으면 줄 전체를 낸다.
  const widened = again.find(x => x.directive.includes(d));
  return widened ? widened.directive : null;
}

/** 하위 호환 이름. */
export function isStillDirective(directive: string, context: string | null | undefined): boolean {
  return revalidateDirective(directive, context) !== null;
}
