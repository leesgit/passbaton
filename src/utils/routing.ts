/**
 * 루트 세션에서 **명시적으로 고른** 하위 프로젝트의 재개 카드를 전달한다 (2.7 · Astra reply-139 PB139-12).
 *
 * ★ 왜 필요한가 (2026-10-22 실측)
 *   사용자는 모노레포 루트에서 `/ashfall` 로 Ashfall 을 이어 한다. 프로젝트 판별은 cwd 로만 해서
 *   루트 대화 15 개에 Ashfall 재개 카드가 한 번도 안 나왔다(랄프는 cwd 가 앱 안이라 받았다).
 *
 * ★ 계약 (reply-139 P2 표)
 *   - 신호는 **실제 사용자 입력 맨 앞의 등록된 명령**뿐이다. 문장·인용·코드 안의 `/ashfall`, 경로 언급,
 *     최근 쓴 파일로는 바꾸지 않는다. 하네스 알림(맨 앞 봉투)은 사람 입력이 아니다.
 *   - 선택은 **세션별**로 둔다(다른 세션·다른 창에 새지 않는다). 다른 프로젝트를 고르면 갈아탄다.
 *     값이 "." 인 명령은 선택을 풀고 루트로 돌아간다.
 *   - 같은 선택·같은 카드 내용이면 매 턴 반복하지 않는다. 전환·내용 변경·컴팩션 뒤에는 다시 낸다.
 *   - 카드에 현재 선택과 해제 방법을 적는다. 이 대화의 기록은 여전히 루트 프로젝트로 쌓인다는 것도 —
 *     루트 대화를 소급해 하위 프로젝트 세션으로 바꾸지 않는다.
 *   - 경로는 워크스페이스 안의 실제 디렉터리만(realpath 기준).
 *
 * ```json
 * { "routing": { "commands": { "/ashfall": "apps/kenshi-fantasy", "/astra": "apps/kenshi-fantasy", "/home": "." } } }
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { buildResumeCard } from './resume-card.js';

export interface RouteTarget {
  /** 워크스페이스 기준 상대경로 · "." = 루트(선택 해제) */
  rel: string;
  /** 절대경로(realpath) · 해제면 null */
  dir: string | null;
  /** 프로젝트 이름(apps/<name> 이면 name, 아니면 폴더 이름) · 해제면 null */
  name: string | null;
}

export interface RoutingDeclaration {
  commands: Map<string, RouteTarget>;
  /** 모양이 틀렸거나 워크스페이스 밖·없는 경로 — 조용히 버리지 않는다 */
  invalid: string[];
}

const COMMAND = /^\/[A-Za-z0-9][\w-]*$/;

export function readRoutingDeclaration(workspaceRoot: string): RoutingDeclaration {
  const out: RoutingDeclaration = { commands: new Map(), invalid: [] };
  let raw: unknown;
  try {
    const file = path.join(workspaceRoot, '.claude', 'passbaton.config.json');
    if (fs.statSync(file).size > 64 * 1024) return out;
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return out;
  }
  const cmds = (raw as { routing?: { commands?: unknown } })?.routing?.commands;
  if (typeof cmds !== 'object' || cmds === null || Array.isArray(cmds)) return out;

  let rootReal: string;
  try { rootReal = fs.realpathSync(workspaceRoot); } catch { return out; }

  for (const [cmd, value] of Object.entries(cmds as Record<string, unknown>)) {
    if (!COMMAND.test(cmd) || typeof value !== 'string' || !value.trim()) { out.invalid.push(cmd); continue; }
    const rel = value.trim();
    if (rel === '.') { out.commands.set(cmd.toLowerCase(), { rel, dir: null, name: null }); continue; }
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(workspaceRoot, rel));
      if (!fs.statSync(real).isDirectory()) throw new Error('not a dir');
    } catch { out.invalid.push(cmd); continue; }
    // ⛔ 워크스페이스 밖(링크로 빠져나가는 것 포함)은 받지 않는다
    if (!real.toLowerCase().startsWith(rootReal.toLowerCase() + path.sep)) { out.invalid.push(cmd); continue; }
    const relFromRoot = path.relative(rootReal, real).split(path.sep);
    const name = relFromRoot[0] === 'apps' && relFromRoot.length >= 2 ? relFromRoot[1] : path.basename(real);
    out.commands.set(cmd.toLowerCase(), { rel, dir: real, name });
  }
  return out;
}

/**
 * 사용자 입력 **맨 앞**의 명령. 원문(`/ashfall …`)과 확장 봉투(`<command-message>…<command-name>/ashfall</command-name>`)
 * 둘 다 맨 앞일 때만 인정한다. 그 밖(문장 속 언급·인용·코드·하네스 알림)은 null.
 */
export function leadingCommand(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const p = prompt.replace(/^\uFEFF/, '').trimStart();
  const raw = p.match(/^(\/[A-Za-z0-9][\w-]*)(?=\s|$)/);
  if (raw) return raw[1].toLowerCase();
  const env = p.match(/^(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\s*(\/[A-Za-z0-9][\w-]*)\s*<\/command-name>/);
  return env ? env[1].toLowerCase() : null;
}

export function cardHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** 카드 앞에 붙는 선택 표시 — 무엇이 골랐고, 기록은 어디로 가고, 어떻게 푸는가 */
export function routeBanner(command: string, target: RouteTarget, rootProject: string, release: string | null): string {
  const how = release ? `send \`${release}\` to return to ${rootProject}` : `send a routed command for another project to switch`;
  return `**Routed project: ${target.name}** (selected by \`${command}\` in this session · this conversation is still recorded under ${rootProject} · ${how})`;
}

/** 해제 명령(값이 ".") 하나 — 안내에 쓴다 */
export function releaseCommand(decl: RoutingDeclaration): string | null {
  for (const [cmd, t] of decl.commands) if (t.dir === null) return cmd;
  return null;
}

/** 라우팅된 프로젝트의 카드 블록과 그 해시. 카드 선언이 없으면 그렇다고 쓴다(지어내지 않는다). */
export function routedBlock(command: string, target: RouteTarget, rootProject: string, release: string | null, maxChars: number): { text: string; hash: string } {
  const card = target.dir ? buildResumeCard(target.dir, maxChars) : null;
  const body = card ? card.text : `⚠ ${target.name} declares no continuity.sources in ${target.rel}/.claude/passbaton.config.json — no resume card`;
  const text = `\n<routed-context project="${target.name}" via="${command}">\n${routeBanner(command, target, rootProject, release)}\n\n${body}\n</routed-context>\n`;
  return { text, hash: cardHash(body) };
}
