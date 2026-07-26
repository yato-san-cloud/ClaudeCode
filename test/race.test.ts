import { describe, expect, it } from 'vitest';
import {
  MAX_TRIP_MS,
  MIN_ITEMS_FOR_RECORD,
  formatDuration,
  ghostProgress,
  isCountable,
  raceResult,
  secondsPerItem,
  summarizePace,
  type TripRecord,
} from '../src/domain/race';

const MINUTE = 60_000;

function trip(overrides: Partial<TripRecord> = {}): TripRecord {
  return {
    listId: 'sl_1',
    durationMs: 10 * MINUTE,
    itemCount: 10, // = 60秒/件
    completedAt: 1_000,
    ...overrides,
  };
}

describe('secondsPerItem', () => {
  it('1件あたりの秒数を返す', () => {
    expect(secondsPerItem(10 * MINUTE, 10)).toBe(60);
  });

  it('品数ゼロなら測れない', () => {
    expect(secondsPerItem(10 * MINUTE, 0)).toBeNull();
  });

  it('所要時間ゼロなら測れない', () => {
    expect(secondsPerItem(0, 10)).toBeNull();
  });
});

describe('isCountable', () => {
  it('品数が少なすぎる買い物は記録に採用しない', () => {
    // 2件だけ買って1分、のような日が自己ベストになると記録が意味を失う
    expect(isCountable(trip({ itemCount: MIN_ITEMS_FOR_RECORD - 1 }))).toBe(false);
    expect(isCountable(trip({ itemCount: MIN_ITEMS_FOR_RECORD }))).toBe(true);
  });

  it('長すぎる買い物は計測ミスとして外す', () => {
    // 画面を開いたまま帰宅した、のようなケース
    expect(isCountable(trip({ durationMs: MAX_TRIP_MS + 1 }))).toBe(false);
  });
});

describe('summarizePace', () => {
  it('履歴が無ければすべて null', () => {
    expect(summarizePace([])).toEqual({
      bestSecondsPerItem: null,
      previousSecondsPerItem: null,
      trips: 0,
    });
  });

  it('自己ベストは最速の1件あたり秒数', () => {
    const records = [
      trip({ durationMs: 10 * MINUTE, itemCount: 10 }), // 60秒/件
      trip({ durationMs: 6 * MINUTE, itemCount: 10 }), // 36秒/件
      trip({ durationMs: 20 * MINUTE, itemCount: 10 }), // 120秒/件
    ];
    expect(summarizePace(records).bestSecondsPerItem).toBe(36);
  });

  it('前回は履歴の先頭（新しい順で渡す前提）', () => {
    const records = [
      trip({ durationMs: 20 * MINUTE, itemCount: 10 }),
      trip({ durationMs: 6 * MINUTE, itemCount: 10 }),
    ];
    expect(summarizePace(records).previousSecondsPerItem).toBe(120);
  });

  it('採用外の買い物は前回にも自己ベストにも数えない', () => {
    const records = [
      trip({ durationMs: 1 * MINUTE, itemCount: 2 }), // 品数不足
      trip({ durationMs: 10 * MINUTE, itemCount: 10 }),
    ];
    const pace = summarizePace(records);
    expect(pace.previousSecondsPerItem).toBe(60);
    expect(pace.bestSecondsPerItem).toBe(60);
    expect(pace.trips).toBe(1);
  });

  it('品数が違う買い物を公平に比べる', () => {
    // 5件を5分 (60秒/件) より、25件を20分 (48秒/件) の方が速い
    const records = [
      trip({ durationMs: 5 * MINUTE, itemCount: 5 }),
      trip({ durationMs: 20 * MINUTE, itemCount: 25 }),
    ];
    expect(summarizePace(records).bestSecondsPerItem).toBe(48);
  });
});

describe('ghostProgress', () => {
  it('自己ベストのペースで進んだ件数を返す', () => {
    // 60秒/件で5分経過 = 5件終わっているはず
    expect(ghostProgress(5 * MINUTE, 60, 20)).toBe(5);
  });

  it('総数を超えない', () => {
    expect(ghostProgress(60 * MINUTE, 60, 10)).toBe(10);
  });

  it('自己ベストが無ければ出さない', () => {
    expect(ghostProgress(5 * MINUTE, null, 20)).toBeNull();
  });

  it('品物が無ければ出さない', () => {
    expect(ghostProgress(5 * MINUTE, 60, 0)).toBeNull();
  });
});

describe('raceResult', () => {
  it('初回は自己ベスト扱い（基準になるため）', () => {
    const result = raceResult(10 * MINUTE, 10, []);
    expect(result.isPersonalBest).toBe(true);
    expect(result.deltaVsBest).toBeNull();
    expect(result.counted).toBe(true);
  });

  it('過去より速ければ自己ベスト更新', () => {
    const history = [trip({ durationMs: 10 * MINUTE, itemCount: 10 })]; // 60秒/件
    const result = raceResult(8 * MINUTE, 10, history); // 48秒/件
    expect(result.isPersonalBest).toBe(true);
    expect(result.deltaVsBest).toBe(-12);
  });

  it('遅ければ更新にならず、差が出る', () => {
    const history = [trip({ durationMs: 10 * MINUTE, itemCount: 10 })];
    const result = raceResult(12 * MINUTE, 10, history); // 72秒/件
    expect(result.isPersonalBest).toBe(false);
    expect(result.deltaVsBest).toBe(12);
  });

  it('前回との差も出す', () => {
    const history = [
      trip({ durationMs: 12 * MINUTE, itemCount: 10 }), // 前回 72秒/件
      trip({ durationMs: 10 * MINUTE, itemCount: 10 }), // ベスト 60秒/件
    ];
    const result = raceResult(11 * MINUTE, 10, history); // 66秒/件
    expect(result.deltaVsPrevious).toBe(-6);
    expect(result.deltaVsBest).toBe(6);
    expect(result.isPersonalBest).toBe(false);
  });

  it('品数が少ない買い物は記録に絡ませない', () => {
    const history = [trip({ durationMs: 10 * MINUTE, itemCount: 10 })];
    const result = raceResult(30_000, 2, history);
    expect(result.counted).toBe(false);
    expect(result.isPersonalBest).toBe(false);
    expect(result.deltaVsBest).toBeNull();
  });

  it('自己ベスト判定に今回自身が混ざらない', () => {
    // 履歴に今回と同じ記録が入っていると「更新できない」になってしまう
    const result = raceResult(10 * MINUTE, 10, []);
    expect(result.isPersonalBest).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [9_000, '0:09'],
    [65_000, '1:05'],
    [12 * MINUTE + 34_000, '12:34'],
    [3_723_000, '1:02:03'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('負の値でも壊れない', () => {
    expect(formatDuration(-5000)).toBe('0:00');
  });
});
