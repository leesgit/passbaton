/**
 * 주입 원장 (2.8 · Astra reply-170 PB170-100 · N3) — hook-trace 확장.
 *
 * 모델에 들어간 본문이 **어느 원천의 어떤 조각으로 몇 바이트** 였는지, 무엇이 **왜 빠졌는지**를 훅마다 남긴다.
 * 잡음(R7)·누수(N4 같은 것)를 잴 수 있게 하는 계기이지 기능이 아니다.
 *
 * ⛔ 계약:
 *   - 기록 끄기 = hookTrace 토글(기본 OFF · hook-trace.ts 와 같은 스위치). 꺼져 있으면 아무것도 쓰지 않는다.
 *   - **본문을 바꾸지 않는다.** add() 는 받은 글을 그대로 돌려준다 — 추적 on/off 에서 모델 전달 본문이 같다.
 *   - 바이트 수·위치·해시는 **실제로 낸 본문**(flush 에 넘긴 문자열)에서 잰다. 조각 글이 본문에 그대로 없으면
 *     (잘림·가공·누락) `in_body=no at=-1` — 기록이 본문을 대신 말하지 않는다.
 *   - 조각은 낸 순서대로 찾는다(앞 조각 끝 뒤에서) — 같은 글이 두 번 나와도 다른 자리를 가리키지 않는다.
 *   - 줄 형식(hook-trace.log 한 줄씩):
 *       hook=<훅>:frag   n=<순번> src=<원천> ids=<원천 식별> bytes=<UTF-8 바이트> at=<본문 안 바이트 위치|-1> sha=<sha256 앞 12> in_body=yes|no
 *       hook=<훅>:omit   src=<원천> ids=<…> reason=<생략 사유>
 *       hook=<훅>:emitted bytes=<본문 바이트> sha=<…> frags=<수> omitted=<수>
 */

import * as crypto from 'crypto';
import { trace } from './hook-trace.js';

const bytesOf = (s: string) => Buffer.byteLength(s, 'utf8');
export const sha12 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

type Frag = { src: string; ids?: string; text: string };
type Omit = { src: string; ids?: string; reason: string };

export class InjectLedger {
  private readonly frags: Frag[] = [];
  private readonly omits: Omit[] = [];
  constructor(private readonly hook: string, private readonly workspaceRoot: string, private readonly project: string | null) {}

  /** 본문에 넣을 조각을 적고 **그대로** 돌려준다. */
  add(src: string, text: string, ids?: string): string {
    this.frags.push({ src, ids, text });
    return text;
  }

  /** 그 원천으로 적힌 첫 조각의 식별(없으면 undefined) — 재개 사건 기록의 자동 칸에 쓴다 */
  idsOf(src: string): string | undefined {
    return this.frags.find(f => f.src === src)?.ids;
  }

  omit(src: string, reason: string, ids?: string): void {
    this.omits.push({ src, ids, reason });
  }

  /** 실제로 낸 본문으로 원장을 쓴다. 조각이 없으면 아무것도 쓰지 않는다(발화 줄은 기존 trace 몫). */
  flush(body: string | null): void {
    if (this.frags.length === 0 && this.omits.length === 0) return;
    const out = body ?? '';
    let cursor = 0;
    this.frags.forEach((f, n) => {
      const at = f.text ? out.indexOf(f.text, cursor) : -1;
      if (at >= 0) cursor = at + f.text.length;
      trace(`${this.hook}:frag`, this.workspaceRoot, {
        project: this.project, n, src: f.src, ids: f.ids, bytes: bytesOf(f.text),
        at: at >= 0 ? bytesOf(out.slice(0, at)) : -1, sha: sha12(f.text), in_body: at >= 0 ? 'yes' : 'no',
      });
    });
    for (const o of this.omits) trace(`${this.hook}:omit`, this.workspaceRoot, { project: this.project, src: o.src, ids: o.ids, reason: o.reason });
    trace(`${this.hook}:emitted`, this.workspaceRoot, {
      project: this.project, bytes: bytesOf(out), sha: sha12(out), frags: this.frags.length, omitted: this.omits.length,
    });
  }
}
