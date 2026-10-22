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
  /** 선언은 있는데 라우팅을 통째로 끈 이유(예: 해제 명령 없음) */
  disabled?: string;
}

/**
 * cwd 가 워크스페이스 루트 **그 디렉터리**인가 (reply-147 PB139-12 ①).
 * 이름 비교(`project === basename(root)`)는 루트와 같은 이름의 하위 앱을 루트로 본다.
 * 양쪽을 실제 경로로 풀어 비교한다. cwd 가 없거나 못 풀면 루트라고 추정하지 않는다.
 */
export function isWorkspaceRootCwd(cwd: string | undefined, workspaceRoot: string): boolean {
  if (!cwd) return false;
  try {
    return path.relative(fs.realpathSync.native(workspaceRoot), fs.realpathSync.native(cwd)) === '';
  } catch {
    return false;
  }
}

/** child 가 parent **안**인가 — 플랫폼 경로 규칙(path.relative)으로. 같은 디렉터리는 안이 아니다 */
function strictlyInside(child: string, parent: string): boolean {
  const r = path.relative(parent, child);
  return r !== '' && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r);
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
  try { rootReal = fs.realpathSync.native(workspaceRoot); } catch { return out; }

  for (const [cmd, value] of Object.entries(cmds as Record<string, unknown>)) {
    if (!COMMAND.test(cmd) || typeof value !== 'string' || !value.trim()) { out.invalid.push(cmd); continue; }
    const rel = value.trim();
    if (rel === '.') { out.commands.set(cmd.toLowerCase(), { rel, dir: null, name: null }); continue; }
    let real: string;
    try {
      real = fs.realpathSync.native(path.resolve(workspaceRoot, rel));
      if (!fs.statSync(real).isDirectory()) throw new Error('not a dir');
    } catch { out.invalid.push(cmd); continue; }
    // ⛔ 워크스페이스 밖(링크로 빠져나가는 것 포함)은 받지 않는다. 무조건 소문자 비교는 대소문자를 가리는
    //    파일시스템에서 `/work/Repo` 밖의 `/work/repo/app` 을 안으로 본다(reply-147 ②)
    if (!strictlyInside(real, rootReal)) { out.invalid.push(cmd); continue; }
    const relFromRoot = path.relative(rootReal, real).split(path.sep);
    const name = relFromRoot[0] === 'apps' && relFromRoot.length >= 2 ? relFromRoot[1] : path.basename(real);
    out.commands.set(cmd.toLowerCase(), { rel, dir: real, name });
  }
  // ⛔ 돌아갈 길 없는 선택은 만들지 않는다(reply-147 ④ · reply-139 P2 「해제 방법」). 해제 명령("." 값)이
  //    하나도 없으면 라우팅 전체를 끈다 — 기존 선택은 다음 턴에 한 번 알리고 지운다.
  if (out.commands.size > 0 && ![...out.commands.values()].some(v => v.dir === null)) {
    out.disabled = 'no release command (a command mapped to ".")';
    out.commands.clear();
  }
  return out;
}

/**
 * 사용자 입력 **맨 앞**의 명령(원문 `/ashfall …`). 그 밖(문장 속 언급·인용·코드·하네스 알림)은 null.
 * ★ 실측(2026-10-23 · tests/fixtures/hook-input-claude-code-2026-10-23.json): UserPromptSubmit 의 `prompt` 는
 *   입력한 그대로다 — `<command-message>`/`<command-name>` 봉투는 트랜스크립트에만 있고 훅 입력에는 없다.
 *   그래서 봉투 모양은 받지 않는다(reply-147 ⑥ — 실측 전 허용을 안전하다고 보지 않는다).
 */
export function leadingCommand(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const p = prompt.replace(/^\uFEFF/, '').trimStart();
  const raw = p.match(/^(\/[A-Za-z0-9][\w-]*)(?=\s|$)/);
  return raw ? raw[1].toLowerCase() : null;
}

export function cardHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** 카드 앞에 붙는 선택 표시 — 무엇이 골랐고, 기록은 어디로 가고, 어떻게 푸는가 */
export function routeBanner(command: string, target: RouteTarget, rootProject: string, release: string): string {
  return `**Routed project: ${target.name}** (selected by \`${command}\` in this session · this conversation is still recorded under ${rootProject} · send \`${release}\` to return to ${rootProject})`;
}

/** 해제 명령(값이 ".") 하나 — 안내에 쓴다. readRoutingDeclaration 이 명령을 남겼으면 반드시 있다 */
export function releaseCommand(decl: RoutingDeclaration): string {
  for (const [cmd, t] of decl.commands) if (t.dir === null) return cmd;
  throw new Error('routing declaration without a release command');
}

/** 이 세션의 선택이 지금 설정에서도 유효한가 — 명령과 대상이 둘 다 같아야 한다 */
export function currentRoute(decl: RoutingDeclaration, command: string, rel: string): RouteTarget | null {
  const t = decl.commands.get(command);
  return t && t.dir !== null && t.rel === rel ? t : null;
}

/** 골랐던 매핑이 사라졌을 때 **한 번** 내는 알림 — 이전 선택을 계속 암시하지 않는다(reply-147 ④) */
export function routeClearedBlock(command: string, targetName: string, rootProject: string, why: string): string {
  return `\n<routed-context project="${rootProject}" via="${command}">\nRoute cleared — \`${command}\` → ${targetName} is no longer routed (${why}). Back to ${rootProject}; no routed project in this session.\n</routed-context>\n`;
}

/** 라우팅된 프로젝트의 카드 블록과 그 해시. 카드 선언이 없으면 그렇다고 쓴다(지어내지 않는다). */
export function routedBlock(command: string, target: RouteTarget, rootProject: string, release: string, maxChars: number): { text: string; hash: string } {
  const card = target.dir ? buildResumeCard(target.dir, maxChars) : null;
  const body = card ? card.text : `⚠ ${target.name} declares no continuity.sources in ${target.rel}/.claude/passbaton.config.json — no resume card`;
  const text = `\n<routed-context project="${target.name}" via="${command}">\n${routeBanner(command, target, rootProject, release)}\n\n${body}\n</routed-context>\n`;
  // ★ 해시는 **실제로 내는 블록 전체** — 본문만 잡으면 해제 명령·별칭이 바뀌어도 안내가 안 바뀐다(reply-147 ③)
  return { text, hash: cardHash(text) };
}
