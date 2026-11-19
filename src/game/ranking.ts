export interface RankStats {
  score: number;
  kills: number;
  deaths: number;
}

/**
 * 경쟁 순위(standard competition ranking, "1224")를 계산한다.
 * 정렬 기준: 점수 ↓ → 킬 ↓ → 데스 ↑. 세 값이 모두 같으면 같은 순위.
 * 입력 배열은 변경하지 않고, 순위 순으로 정렬된 [항목, 순위] 쌍을 반환한다.
 */
export function rank<T extends RankStats>(items: readonly T[]): Array<{ item: T; placement: number }> {
  const sorted = [...items].sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
  const out: Array<{ item: T; placement: number }> = [];
  sorted.forEach((item, i) => {
    const prev = out[i - 1];
    const tied = prev && prev.item.score === item.score && prev.item.kills === item.kills && prev.item.deaths === item.deaths;
    out.push({ item, placement: tied ? prev.placement : i + 1 });
  });
  return out;
}
