import { metrics } from '../util/metrics.ts';
import type { PlayerInput } from './types.ts';

/** 틱당 입력 예산 회복량. 1.0 이면 정확히 30Hz, 5% 여유를 둬 클라이언트 클럭 오차를 흡수한다. */
export const INPUT_CREDIT_PER_TICK = 1.05;
/** 네트워크 지터로 몰려온 입력을 한 틱에 최대 몇 개까지 따라잡을지 */
export const MAX_INPUT_CREDIT = 4;
/** 큐 상한 — 초과 시 가장 오래된 입력을 버려 지연이 무한히 쌓이지 않게 한다 */
export const MAX_INPUT_QUEUE = 8;

/**
 * 플레이어 1명의 입력 파이프라인 (안티치트 1차 방어선).
 *  - seq 단조 증가 강제: 중복/역순 입력(리플레이 공격 포함) 폐기
 *  - 큐 상한: 오래된 입력부터 폐기
 *  - 입력 예산(token bucket, 틱 단위): 입력을 몰아 보내도 틱당 처리량이 제한돼 스피드핵이 불가능
 *
 * 시뮬레이션과 분리되어 있어 단독으로 테스트할 수 있다.
 */
export class InputBuffer {
  private queue: PlayerInput[] = [];
  private credit = 1;
  /** 마지막으로 시뮬레이션에 적용된 seq — 스냅샷 ack 로 클라이언트에 전달된다 (0 = 아직 없음) */
  lastProcessedSeq = 0;

  get length() {
    return this.queue.length;
  }

  push(input: PlayerInput): boolean {
    const lastQueued = this.queue.length ? this.queue[this.queue.length - 1].seq : this.lastProcessedSeq;
    if (input.seq <= lastQueued) {
      metrics.inc('game_inputs_out_of_order_total');
      return false;
    }
    if (this.queue.length >= MAX_INPUT_QUEUE) {
      this.queue.shift();
      metrics.inc('game_inputs_dropped_total');
    }
    this.queue.push(input);
    return true;
  }

  /** 이번 틱에 처리할 입력을 예산만큼 꺼낸다 */
  drain(): PlayerInput[] {
    this.credit = Math.min(MAX_INPUT_CREDIT, this.credit + INPUT_CREDIT_PER_TICK);
    const n = Math.min(this.queue.length, Math.floor(this.credit));
    if (n === 0) return [];
    this.credit -= n;
    const out = this.queue.splice(0, n);
    this.lastProcessedSeq = out[out.length - 1].seq;
    return out;
  }

  /** 연결 끊김: 남은 입력 폐기 */
  clear() {
    this.queue.length = 0;
  }

  /** 새 클라이언트로 재접속: seq 를 처음부터 다시 센다 */
  reset() {
    this.queue.length = 0;
    this.lastProcessedSeq = 0;
  }

  /** 테스트용 */
  peekSeqs() {
    return this.queue.map((i) => i.seq);
  }
}
