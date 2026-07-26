/**
 * 買い物をタイムアタックとして扱うための計算。純粋関数だけ。
 *
 * 記録は「所要時間」そのものではなく **1件あたりの秒数** で持つ。
 * 5件の日と25件の日を同じ土俵に載せないと、買う量が多い日ほど自己ベストから
 * 遠ざかることになり、記録が意味を持たなくなる。
 */

/** これ未満の品数は記録に採用しない (数件だけの日が自己ベストになってしまう) */
export const MIN_ITEMS_FOR_RECORD = 5;

/** これ以上かかった買い物は計測ミス (画面を開いたまま帰宅した等) として除外する */
export const MAX_TRIP_MS = 3 * 60 * 60 * 1000;

/** 連続チェックが途切れたとみなす間隔 */
export const COMBO_WINDOW_MS = 8000;

export interface TripRecord {
  listId: string;
  durationMs: number;
  itemCount: number;
  completedAt: number;
}

export interface PaceStats {
  /** 自己ベストの1件あたり秒数 */
  bestSecondsPerItem: number | null;
  /** 直近の買い物の1件あたり秒数 */
  previousSecondsPerItem: number | null;
  /** 記録として採用された買い物の回数 */
  trips: number;
}

export function secondsPerItem(durationMs: number, itemCount: number): number | null {
  if (itemCount <= 0 || durationMs <= 0) return null;
  return durationMs / 1000 / itemCount;
}

/** 記録として採用できる買い物か */
export function isCountable(record: TripRecord): boolean {
  return (
    record.itemCount >= MIN_ITEMS_FOR_RECORD &&
    record.durationMs > 0 &&
    record.durationMs <= MAX_TRIP_MS
  );
}

/**
 * @param records 完了済みの買い物。新しい順に並んでいること。
 */
export function summarizePace(records: readonly TripRecord[]): PaceStats {
  const countable = records.filter(isCountable);
  if (countable.length === 0) {
    return { bestSecondsPerItem: null, previousSecondsPerItem: null, trips: 0 };
  }

  let best = Number.POSITIVE_INFINITY;
  for (const record of countable) {
    const pace = secondsPerItem(record.durationMs, record.itemCount);
    if (pace !== null && pace < best) best = pace;
  }

  return {
    bestSecondsPerItem: Number.isFinite(best) ? best : null,
    previousSecondsPerItem: secondsPerItem(
      countable[0]!.durationMs,
      countable[0]!.itemCount,
    ),
    trips: countable.length,
  };
}

/**
 * ゴーストランナー。いまの経過時間で、自己ベストのペースなら何件終わって
 * いるはずかを返す。進捗バーの目印に使う。
 */
export function ghostProgress(
  elapsedMs: number,
  bestSecondsPerItem: number | null,
  totalItems: number,
): number | null {
  if (bestSecondsPerItem === null || bestSecondsPerItem <= 0 || totalItems <= 0) return null;
  const done = elapsedMs / 1000 / bestSecondsPerItem;
  return Math.max(0, Math.min(totalItems, done));
}

export interface RaceResult {
  durationMs: number;
  itemCount: number;
  secondsPerItem: number | null;
  /** 記録として採用されたか */
  counted: boolean;
  isPersonalBest: boolean;
  /** 自己ベストとの差 (秒/件)。マイナスなら速い。 */
  deltaVsBest: number | null;
  deltaVsPrevious: number | null;
}

/**
 * @param records 今回を **含まない** 過去の買い物 (新しい順)
 */
export function raceResult(
  durationMs: number,
  itemCount: number,
  records: readonly TripRecord[],
): RaceResult {
  const pace = secondsPerItem(durationMs, itemCount);
  const counted = isCountable({ listId: '', durationMs, itemCount, completedAt: 0 });
  const history = summarizePace(records);

  if (!counted || pace === null) {
    return {
      durationMs,
      itemCount,
      secondsPerItem: pace,
      counted: false,
      isPersonalBest: false,
      deltaVsBest: null,
      deltaVsPrevious: null,
    };
  }

  return {
    durationMs,
    itemCount,
    secondsPerItem: pace,
    counted: true,
    // 過去に記録が無ければ、今回が最初の基準になる = 自己ベスト扱い
    isPersonalBest: history.bestSecondsPerItem === null || pace < history.bestSecondsPerItem,
    deltaVsBest:
      history.bestSecondsPerItem === null ? null : pace - history.bestSecondsPerItem,
    deltaVsPrevious:
      history.previousSecondsPerItem === null ? null : pace - history.previousSecondsPerItem,
  };
}

/** ミリ秒を "12:34" 形式に。1時間を超えたら "1:02:03"。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
