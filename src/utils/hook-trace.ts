import * as fs from 'fs';
import * as path from 'path';
import { isEnabled } from './config.js';

/**
 * 훅 발화 추적 로그 — `<workspaceRoot>/.claude/hook-trace.log`.
 *
 * **기본 OFF.** 이 패키지의 ON-by-default 규칙은 「조용하고 안전하고 보편적으로
 * 유용할 것」인데, PostToolUse 는 Edit/Write 마다 파일을 쓰므로 조용하지 않다.
 *
 * 켜는 법: `~/.claude/passbaton.config.json` 의 `features.hookTrace.enabled = true`.
 * `PASSBATON_HOOKTRACE=1` 도 읽지만 **Windows 에서는 실용적이지 않다** — 훅은
 * settings.json 의 command 로 cmd.exe 에서 실행되어 `VAR=1 cmd` 문법이 안 먹는다.
 *
 * ── 이 로그가 무엇을 위한 것인가 (2026-09-07 교차검증에서 근거를 한 번 갈아엎음)
 *
 * 처음엔 「SessionStart·PostToolUse 는 측정 수단이 아예 없다」고 적었다. **틀렸다.**
 * 반박·측정 관점이 코드 한 줄 없이 소급으로 답을 냈다:
 *   - Claude Code 는 훅 발화를 트랜스크립트에 `hook_success` + `hookEvent` 로 남긴다.
 *     실측: 메인 트랜스크립트 6개 전부 SessionStart 1건, **서브에이전트 32개는 0건**.
 *     → SessionStart 는 세션당 1회 + 컴팩션당 1회. 서브에이전트마다 발화하지 않는다.
 *   - 서브에이전트의 Edit/Write 는 PostToolUse 를 태우고 공유 DB 에 쓴다.
 *     실측: 2026-08-15 15:43~15:49 에 서브에이전트가 쓴 스크래치패드 13개가
 *     `hot_paths.last_accessed` 에 20~30초 간격으로 1:1 대응한다.
 *
 * 그래서 **남은 신규 가치는 그 둘이 원리적으로 못 보는 것뿐**이고, 필드가 거기 맞춰져 있다:
 *   - 트랜스크립트는 stdout 을 낸 발화만 남긴다 → 조용한 발화는 안 보인다
 *   - `hot_paths` 는 파일 경로가 있는 추적 도구만, 그것도 7일 반감 decay 로 센다
 *   - **어느 쪽도 프로세스를 구분하지 못한다** → `pid`. 이게 없으면 「한 프로세스가
 *     N번」과 「N 프로세스가 1번씩」이 로그상 같아 보여 동시성을 못 잰다
 *   - **`session_id` 로는 메인/서브를 못 가른다** — 서브에이전트는 부모의 session_id 를
 *     그대로 받는다(실측: 서브 8개 전부 부모와 동일). 가르는 건 `tpath` 다.
 *     서브에이전트 트랜스크립트는 `subagents/agent-<id>.jsonl` 이다
 *   - 어느 쪽도 **해석된 워크스페이스 루트**를 남기지 않는다 → `ws_root`.
 *     이 패키지가 고친 결함군이 전부 「cwd → root 매핑이 틀렸다」였다
 *
 * ── 안전 규칙
 * `.claude` 디렉터리를 **새로 만들지 않는다.** 만들면 워크스페이스 탐지가 그 자리에
 * 멈춰 다음부터 엉뚱한 루트를 잡는다 — 방금 고친 결함을 진단 코드가 되살리는 꼴이다.
 * 디렉터리가 없으면 조용히 아무것도 안 한다.
 * ⚠ 그 대가로 사각지대가 하나 남는다: 「엉뚱한 루트로 갔다」의 최악 사례는 그 루트에
 * `.claude` 가 없는 경우인데, 그때는 0줄이 나온다. **0줄을 「발화 안 함」으로 읽지 마라.**
 */

/** 5 MB 를 넘으면 한 세대만 굴린다. 회전 정책이 아니라 폭주 방지 상한이다. */
const MAX_BYTES = 5 * 1024 * 1024;

export function trace(
  hook: string,
  workspaceRoot: string,
  fields: Record<string, string | number | boolean | undefined | null>,
): void {
  try {
    if (!isEnabled('hookTrace', workspaceRoot)) return;

    const claudeDir = path.join(workspaceRoot, '.claude');
    if (!fs.existsSync(claudeDir)) return; // 만들지 않는다

    const logPath = path.join(claudeDir, 'hook-trace.log');
    try {
      if (fs.statSync(logPath).size > MAX_BYTES) fs.renameSync(logPath, logPath + '.1');
    } catch {
      // 파일이 아직 없으면 statSync 가 던진다 — 정상 경로다
    }

    // pid 와 ws_root 는 진단의 핵심이라 호출부에 맡기지 않고 여기서 강제로 붙인다.
    const merged = { pid: process.pid, ws_root: workspaceRoot, ...fields };
    const parts = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, '_')}`);

    fs.appendFileSync(logPath, `[${new Date().toISOString()}] hook=${hook} ${parts.join(' ')}\n`);
  } catch {
    // 추적 실패가 훅을 깨뜨리지 않는다 — 진단 코드는 fail-soft 여야 한다
  }
}

/**
 * 서브에이전트 판별용 트랜스크립트 이름. 서브에이전트는 부모의 session_id 를 그대로
 * 받으므로 `sid` 로는 못 가른다. 경로 전체는 길고 개인정보성이 있어 basename 만 쓴다.
 */
export function tpathOf(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  try {
    return path.basename(transcriptPath);
  } catch {
    return undefined;
  }
}
