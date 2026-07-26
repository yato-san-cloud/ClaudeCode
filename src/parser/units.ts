/**
 * 数量と単位の抽出。
 *
 * 「牛乳2本」「卵 1パック」「豚こま300g」「トイレットペーパー×2」「たまねぎ3つ」
 * 「にんじん二本」あたりを拾う。数量が無いものは quantity=null で返す
 * (「醤油」だけ、のような指示は数量なしが正しい)。
 */

import { normalize } from './normalize';

/** 数量の後ろに来る単位。長いものから順に試すので並び順が意味を持つ。 */
export const UNITS = [
  // 重さ・容量 (アルファベットは NFKC 後に小文字化して比較する)
  'キログラム', 'グラム', 'ミリリットル', 'リットル',
  'kg', 'mg', 'ml', 'cc', 'g', 'l',
  // 数え方
  'パック', 'ボトル', 'ケース', 'セット', 'カップ', 'ダース',
  '人前', '切れ', '切', '本', '個', '袋', '枚', '箱', '缶', '束', '丁', '玉',
  '房', '尾', '杯', '株', '把', '合', '斤', '巻', '粒', '匹', '羽', '足', '台',
  'つ', 'コ', 'P', 'pc', 'pcs',
] as const;

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「十」「二十」「十五」「三十二」程度の漢数字。買い物リストではこれで十分。 */
export function parseKanjiNumber(text: string): number | null {
  if (!text) return null;
  if (!/^[〇零一二三四五六七八九十]+$/.test(text)) return null;

  const tenIndex = text.indexOf('十');
  if (tenIndex === -1) {
    let value = 0;
    for (const ch of text) {
      const digit = KANJI_DIGITS[ch];
      if (digit === undefined) return null;
      value = value * 10 + digit;
    }
    return value;
  }

  const head = text.slice(0, tenIndex);
  const tail = text.slice(tenIndex + 1);
  const tens = head === '' ? 1 : (KANJI_DIGITS[head] ?? null);
  if (tens === null) return null;
  if (tail === '') return tens * 10;
  const ones = tail.length === 1 ? (KANJI_DIGITS[tail] ?? null) : parseKanjiNumber(tail);
  if (ones === null) return null;
  return tens * 10 + ones;
}

/** 「ふたつ」など和語の数詞 */
const JAPANESE_COUNTS: Record<string, number> = {
  ひとつ: 1, ふたつ: 2, みっつ: 3, よっつ: 4, いつつ: 5,
  むっつ: 6, ななつ: 7, やっつ: 8, ここのつ: 9, とお: 10,
  いっぽん: 1, にほん: 2, さんぼん: 3,
  いっこ: 1, にこ: 2, さんこ: 3,
};

export interface Quantity {
  quantity: number | null;
  unit: string | null;
}

export interface QuantityMatch extends Quantity {
  /** 数量表現を取り除いた残り = 商品名の候補 */
  name: string;
}

const NUM_PATTERN = '(?:[0-9]+(?:\\.[0-9]+)?|[〇零一二三四五六七八九十]+)';
const UNIT_PATTERN = UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** 数量文字列を数値に。半角数字・漢数字の両対応。 */
function toNumber(raw: string): number | null {
  if (/^[0-9]/.test(raw)) {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  }
  return parseKanjiNumber(raw);
}

/** 単位の表記ゆれを代表形に寄せる */
export function canonicalUnit(unit: string): string {
  const lowered = unit.toLowerCase();
  const map: Record<string, string> = {
    キログラム: 'kg', グラム: 'g', ミリリットル: 'ml', リットル: 'L',
    l: 'L', kg: 'kg', g: 'g', mg: 'mg', ml: 'ml', cc: 'ml',
    コ: '個', p: 'パック', pc: '個', pcs: '個', 切: '切れ',
  };
  return map[lowered] ?? map[unit] ?? unit;
}

/**
 * 断片から数量を1つだけ取り出す。見つからなければ quantity/unit は null。
 * 商品名の中の数字 (「7プレミアム」「三ツ矢サイダー」) を誤爆させないよう、
 * 数値だけの一致は末尾に限定している。
 */
export function extractQuantity(fragment: string): QuantityMatch {
  const text = normalize(fragment);

  // 1) 「×2」「x2」「*2」— 末尾のかけ算表記
  const times = text.match(/[×xX*✕]\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
  if (times?.[1]) {
    return {
      quantity: Number.parseFloat(times[1]),
      unit: null,
      name: text.slice(0, times.index).trim(),
    };
  }

  // 2) 「2本」「300g」「1パック」— 数値+単位。末尾を優先し、無ければ先頭も見る。
  const numUnit = new RegExp(`(${NUM_PATTERN})\\s*(${UNIT_PATTERN})(?![ぁ-ん])`, 'giu');
  const matches = [...text.matchAll(numUnit)];
  const chosen = matches[matches.length - 1];
  if (chosen?.[1] && chosen[2]) {
    const value = toNumber(chosen[1]);
    if (value !== null) {
      const start = chosen.index;
      const end = start + chosen[0].length;
      const name = (text.slice(0, start) + ' ' + text.slice(end)).replace(/\s+/g, ' ').trim();
      return { quantity: value, unit: canonicalUnit(chosen[2]), name: name || text };
    }
  }

  // 3) 「ふたつ」など和語の数詞
  for (const [word, value] of Object.entries(JAPANESE_COUNTS)) {
    if (text.endsWith(word) && text.length > word.length) {
      return { quantity: value, unit: null, name: text.slice(0, -word.length).trim() };
    }
  }

  // 4) 末尾の裸の数値。「牛乳 2」
  const trailing = text.match(/\s([0-9]+(?:\.[0-9]+)?)\s*$/);
  if (trailing?.[1]) {
    return {
      quantity: Number.parseFloat(trailing[1]),
      unit: null,
      name: text.slice(0, trailing.index).trim(),
    };
  }

  return { quantity: null, unit: null, name: text };
}
