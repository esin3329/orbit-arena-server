import { ORB_RADIUS } from '../../shared/sim.js';
import type { PlayerInput } from './types.ts';

export interface BotView {
  eid: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  aim: number;
}

export interface OrbView {
  x: number;
  y: number;
  active: boolean;
}

/**
 * 간단한 상태 기반 봇 AI. 사람과 "같은 입력 파이프라인"으로 들어가므로
 * 봇도 서버 이동 규칙/쿨다운/입력 예산을 우회할 수 없다.
 */
export class BotBrain {
  private seq = 0;
  private strafe = 1;
  private nextDecisionTick = 0;
  private wander: number;
  private rand: () => number;

  constructor(rand: () => number) {
    this.rand = rand;
    this.wander = rand() * Math.PI * 2;
  }

  think(self: BotView, players: Iterable<BotView>, orbs: OrbView[], tick: number): PlayerInput {
    const input: PlayerInput = { seq: ++this.seq, dx: 0, dy: 0, aim: self.aim, fire: false, dash: false };
    if (!self.alive) return input;

    let target: BotView | null = null;
    let best = Infinity;
    for (const p of players) {
      if (p.eid === self.eid || !p.alive) continue;
      const d = Math.hypot(p.x - self.x, p.y - self.y);
      if (d < best) {
        best = d;
        target = p;
      }
    }

    if (tick >= this.nextDecisionTick) {
      this.strafe = this.rand() < 0.5 ? 1 : -1;
      this.wander += (this.rand() - 0.5) * 1.5;
      this.nextDecisionTick = tick + 25 + Math.floor(this.rand() * 45);
    }

    if (target && best < 520) {
      const ang = Math.atan2(target.y - self.y, target.x - self.x);
      input.aim = ang + (this.rand() - 0.5) * 0.3; // 의도적인 조준 오차
      input.fire = best < 470 && this.rand() < 0.55;
      const radial = best > 300 ? 1 : best < 180 ? -1 : 0;
      input.dx = Math.cos(ang) * radial + Math.cos(ang + Math.PI / 2) * this.strafe * 0.8;
      input.dy = Math.sin(ang) * radial + Math.sin(ang + Math.PI / 2) * this.strafe * 0.8;
      input.dash = self.hp <= 40 && this.rand() < 0.04;
      return input;
    }

    let orb: OrbView | null = null;
    let orbDist = Infinity;
    for (const o of orbs) {
      if (!o.active) continue;
      const d = Math.hypot(o.x - self.x, o.y - self.y);
      if (d < orbDist) {
        orbDist = d;
        orb = o;
      }
    }
    const ang = orb && orbDist > ORB_RADIUS ? Math.atan2(orb.y - self.y, orb.x - self.x) : this.wander;
    input.dx = Math.cos(ang);
    input.dy = Math.sin(ang);
    input.aim = ang;
    return input;
  }
}
