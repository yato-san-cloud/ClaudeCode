/**
 * JST 固定のカレンダー計算。日本にサマータイムはないので UTC+9 の決め打ちでよく、
 * Intl に依存しないぶんテストが素直に書ける。
 */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** JSTでの曜日 (0=日 .. 6=土) */
export function jstDayOfWeek(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCDay();
}

/** JSTでの YYYY-MM-DD */
export function jstDateString(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JSTでの時刻 (0..23) */
export function jstHour(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCHours();
}

/** 2時刻の差を日数で。小数を返す。 */
export function daysBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / DAY_MS;
}

/** 「3日前」「今日」などの日本語表現 */
export function humanizeDaysAgo(days: number): string {
  const rounded = Math.round(days);
  if (rounded <= 0) return '今日';
  if (rounded === 1) return '昨日';
  if (rounded < 7) return `${rounded}日前`;
  if (rounded < 30) return `${Math.round(rounded / 7)}週間前`;
  return `${Math.round(rounded / 30)}か月前`;
}
