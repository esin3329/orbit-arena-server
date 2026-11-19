/**
 * 클라이언트 → 서버 메시지 스키마와 검증.
 * 신뢰할 수 없는 입력이므로 타입·범위를 모두 검사하고, 통과한 값만 게임 로직에 전달한다.
 */
export interface InputMessage {
  t: 'input';
  seq: number;
  dx: number;
  dy: number;
  aim: number;
  fire: boolean;
  dash: boolean;
  rt?: number;
}

export type ClientMessage = { t: 'queue' } | { t: 'leave' } | { t: 'ping'; ts: number } | InputMessage;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'queue':
      return { t: 'queue' };
    case 'leave':
      return { t: 'leave' };
    case 'ping':
      return isNum(o.ts) ? { t: 'ping', ts: o.ts } : null;
    case 'input': {
      if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 0 || (o.seq as number) > 0x7fffffff) return null;
      if (!isNum(o.dx) || !isNum(o.dy) || !isNum(o.aim)) return null;
      return {
        t: 'input',
        seq: o.seq as number,
        dx: clamp(o.dx, -1, 1),
        dy: clamp(o.dy, -1, 1),
        aim: clamp(o.aim, -Math.PI * 4, Math.PI * 4),
        fire: o.fire === true,
        dash: o.dash === true,
        // 지연 보상용 시점. 없거나 이상하면 보상 없이 처리 (범위 제한은 GameWorld 가 서버 틱 기준으로 수행)
        ...(isNum(o.rt) && o.rt >= 0 ? { rt: o.rt } : {}),
      };
    }
    default:
      return null;
  }
}
