/**
 * 「そろそろこれ、切れてない?」を出すための学習ロジック。
 *
 * 純粋関数だけを置く (DBアクセスは catalog.ts 側)。おかげでテストで
 * 時刻を固定して周期予測の挙動を確認できる。
 *
 * 学習しているのは2つ:
 *   - 購入間隔の指数移動平均 (mean_interval_days) … 「10日周期の牛乳」
 *   - 購入回数 (purchase_count)                   … 「よく買う定番」
 * どちらも購入イベント (= 買い物完了) のたびに更新する。
 */

import { daysBetween, humanizeDaysAgo } from '../util/time';

export interface CatalogSnapshot {
  id: string;
  canonical_name: string;
  category: string;
  default_unit: string | null;
  default_quantity: number | null;
  purchase_count: number;
  last_purchased_at: number | null;
  mean_interval_days: number | null;
  interval_samples: number;
}

export interface Suggestion {
  item: CatalogSnapshot;
  score: number;
  /** UIにそのまま出す理由書き */
  reason: string;
}

/** 新しい観測の重み。0.3 = 直近の変化にそこそこ追従しつつ、1回の異常値では動かない。 */
export const EMA_ALPHA = 0.3;

/** これ未満の周期は「同じ買い物の重複記録」とみなして学習に使わない。 */
const MIN_INTERVAL_DAYS = 0.5;
/** これを超える間隔は季節ものや一過性の購入とみなし、平均を汚さない。 */
const MAX_INTERVAL_DAYS = 120;

/**
 * 購入間隔のEMAを更新する。
 * @returns 新しい {mean, samples}。学習に使わない場合は元の値をそのまま返す。
 */
export function updateInterval(
  previousMean: number | null,
  samples: number,
  lastPurchasedAt: number | null,
  purchasedAt: number,
): { mean: number | null; samples: number } {
  if (lastPurchasedAt === null) return { mean: previousMean, samples };

  const interval = daysBetween(lastPurchasedAt, purchasedAt);
  if (interval < MIN_INTERVAL_DAYS || interval > MAX_INTERVAL_DAYS) {
    return { mean: previousMean, samples };
  }
  if (previousMean === null || samples === 0) {
    return { mean: interval, samples: 1 };
  }
  return {
    mean: previousMean * (1 - EMA_ALPHA) + interval * EMA_ALPHA,
    samples: samples + 1,
  };
}

/** 周期に対してどれだけ経ったか。1.0 = ちょうど周期ぶん経過。 */
export function stalenessRatio(item: CatalogSnapshot, now: number): number | null {
  if (item.last_purchased_at === null || !item.mean_interval_days) return null;
  if (item.mean_interval_days <= 0) return null;
  return daysBetween(item.last_purchased_at, now) / item.mean_interval_days;
}

/** 「よく買う」度合いを 0..1 に潰す。20回でほぼ頭打ち。 */
export function frequencyScore(purchaseCount: number): number {
  if (purchaseCount <= 0) return 0;
  return Math.min(1, Math.log1p(purchaseCount) / Math.log(21));
}

function buildReason(item: CatalogSnapshot, ratio: number | null, now: number): string {
  if (item.last_purchased_at === null) return 'まだ買っていません';
  const ago = humanizeDaysAgo(daysBetween(item.last_purchased_at, now));
  if (ratio !== null && item.mean_interval_days) {
    const cycle = Math.round(item.mean_interval_days);
    if (ratio >= 1.4) return `前回 ${ago} — いつも約${cycle}日周期なので切れてるかも`;
    if (ratio >= 0.8) return `前回 ${ago} — そろそろ約${cycle}日周期のタイミング`;
    return `前回 ${ago}（約${cycle}日周期）`;
  }
  return `前回 ${ago} — ${item.purchase_count}回買っています`;
}

export interface SuggestOptions {
  now: number;
  /** すでにリストに載っている商品の catalog_item_id */
  excludeIds?: ReadonlySet<string>;
  limit?: number;
  /** このスコア未満は出さない */
  minScore?: number;
}

/**
 * 提案の並べ替え。周期の切迫度を主、購入頻度を従として重み付けする。
 *
 * 周期がまだ学習できていない商品 (購入1回のみ) も、頻度だけで薄く候補に残す。
 * 「まだ学習中だから何も出ない」という初期状態を避けるため。
 */
export function suggestItems(
  catalog: readonly CatalogSnapshot[],
  options: SuggestOptions,
): Suggestion[] {
  const { now, excludeIds, limit = 8, minScore = 0.35 } = options;
  const suggestions: Suggestion[] = [];

  for (const item of catalog) {
    if (excludeIds?.has(item.id)) continue;

    const ratio = stalenessRatio(item, now);
    const frequency = frequencyScore(item.purchase_count);

    let score: number;
    if (ratio === null) {
      // 周期未学習。頻度だけで控えめに評価する。
      score = frequency * 0.45;
    } else {
      // ratio 1.0 付近で最大。行き過ぎても下げない (切らしっぱなしの可能性)。
      const urgency = Math.min(ratio, 1.5) / 1.5;
      score = urgency * 0.7 + frequency * 0.3;
    }

    if (score < minScore) continue;
    suggestions.push({ item, score, reason: buildReason(item, ratio, now) });
  }

  return suggestions
    .sort((a, b) => b.score - a.score || b.item.purchase_count - a.item.purchase_count)
    .slice(0, limit);
}

/**
 * 「いつもの」= 毎回のように買っている定番。提案より強い確信度で一括投入する。
 * 直近の買い物回数 (`recentTrips`) に対する登場率で判定する。
 */
export function usualItems(
  catalog: readonly CatalogSnapshot[],
  appearanceByItemId: ReadonlyMap<string, number>,
  recentTrips: number,
  options: { limit?: number; minRate?: number } = {},
): CatalogSnapshot[] {
  const { limit = 20, minRate = 0.5 } = options;
  if (recentTrips <= 0) return [];

  return catalog
    .filter((item) => {
      const appearances = appearanceByItemId.get(item.id) ?? 0;
      return appearances >= 2 && appearances / recentTrips >= minRate;
    })
    .sort(
      (a, b) =>
        (appearanceByItemId.get(b.id) ?? 0) - (appearanceByItemId.get(a.id) ?? 0) ||
        b.purchase_count - a.purchase_count,
    )
    .slice(0, limit);
}

/**
 * 購入履歴から「いつもの買い物曜日」を推定する。
 * 最頻の曜日が全体の3割以上を占めるときだけ採用する (バラけていれば null)。
 */
export function inferShoppingDow(dows: readonly number[]): number | null {
  if (dows.length < 3) return null;
  const counts = new Array<number>(7).fill(0);
  for (const dow of dows) {
    if (dow >= 0 && dow <= 6) counts[dow]! += 1;
  }
  let best = 0;
  for (let i = 1; i < 7; i++) {
    if (counts[i]! > counts[best]!) best = i;
  }
  return counts[best]! / dows.length >= 0.3 ? best : null;
}
