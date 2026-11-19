export interface RatingEntry {
  playerId: string;
  rating: number;
  placement: number;
}

/**
 * 다인전용 Elo: 모든 참가자 쌍(pair)을 1:1 대결로 보고 기대 승률과 실제 결과의 차이를 평균낸다.
 * - 순위가 높으면 승(1), 같으면 무(0.5), 낮으면 패(0)
 * - (n-1)로 나눠 인원수와 무관하게 변동폭이 K 이내가 되도록 정규화
 * 사람 플레이어끼리만 계산한다(봇으로 레이팅을 파밍하지 못하도록).
 */
export function computeRatingDeltas(entries: RatingEntry[], k = 32): Map<string, number> {
  const out = new Map<string, number>();
  const n = entries.length;
  for (const a of entries) {
    if (n < 2) {
      out.set(a.playerId, 0);
      continue;
    }
    let sum = 0;
    for (const b of entries) {
      if (a === b) continue;
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const actual = a.placement < b.placement ? 1 : a.placement === b.placement ? 0.5 : 0;
      sum += actual - expected;
    }
    out.set(a.playerId, Math.round((k * sum) / (n - 1)));
  }
  return out;
}
