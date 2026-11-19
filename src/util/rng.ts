/** [0, 1) 균등 난수 생성기 */
export type Rng = () => number;

/**
 * 시드 기반 PRNG (mulberry32). 룸마다 시드를 기록해 두면
 * "같은 시드 + 같은 입력 로그 → 같은 매치"가 재현되므로 버그 리포트를 리플레이로 디버깅할 수 있다.
 */
export function createRng(seed: number): Rng {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomSeed = () => (Math.random() * 0x100000000) >>> 0;
