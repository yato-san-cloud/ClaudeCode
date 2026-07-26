/**
 * ルールベースの解析。辞書 + 正規表現だけで完結し、外部通信はしない。
 * 確信度が低い断片が残った場合だけ、呼び出し側が Claude API に回す。
 */

import { segment } from './segment';
import { extractQuantity } from './units';
import { matchKey } from './normalize';
import { categorize, isKnownItem, OTHER_CATEGORY } from '../domain/categories';

export interface ParsedItem {
  /** 妻が書いた原文。UIで併記して「言い換えられた感」を防ぐ。 */
  raw: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  category: string;
  /** 0..1。低いものはUIで「?」を出して確認できるようにする。 */
  confidence: number;
}

export interface RuleParseResult {
  items: ParsedItem[];
  /** 解析対象外として落とした行 (連絡事項など) */
  ignored: string[];
  /** LLMフォールバックを呼ぶ価値があるか */
  needsLlm: boolean;
}

/** これ以下だと「自信なし」。UIで確認マークを出し、LLMがあれば回す。 */
export const LOW_CONFIDENCE = 0.5;

/** 語尾が動詞・形容詞っぽい = 商品名ではなさそう */
const VERBISH_ENDING = /(?:する|した|してる|ある|あった|いる|いた|なる|なった|たい|ない)$/u;

function scoreConfidence(
  name: string,
  quantity: number | null,
  unit: string | null,
  knownKeys: ReadonlySet<string>,
): number {
  const key = matchKey(name);
  if (knownKeys.has(key)) return 0.98; // その世帯で過去に買ったことがある
  if (isKnownItem(name)) return 0.95; // 組み込み辞書にある
  if (quantity !== null && unit !== null) return 0.8; // 「〇〇 2パック」の形
  if (VERBISH_ENDING.test(name)) return 0.25;
  if (name.length <= 12 && !/[。!！]/.test(name)) return 0.55;
  return 0.35;
}

/**
 * @param message  LINEで届いた本文
 * @param knownKeys その世帯の学習済み商品の matchKey 集合 (省略可)
 */
export function parseWithRules(
  message: string,
  knownKeys: ReadonlySet<string> = new Set(),
): RuleParseResult {
  const { fragments, ignored } = segment(message);
  const items: ParsedItem[] = [];

  for (const fragment of fragments) {
    const { quantity, unit, name: extracted } = extractQuantity(fragment.text);
    const name = extracted.trim() || fragment.text;
    if (!name) continue;

    const notes: string[] = [];
    if (fragment.note) notes.push(fragment.note);
    if (fragment.shortage) notes.push('切らしそう');

    items.push({
      raw: fragment.raw,
      name,
      quantity,
      unit,
      note: notes.length ? notes.join(' / ') : null,
      category: categorize(name),
      confidence: scoreConfidence(name, quantity, unit, knownKeys),
    });
  }

  // 同じものを二度書いている場合はまとめる (「卵」「たまご1パック」)
  const merged = dedupe(items);

  const hasLowConfidence = merged.some((item) => item.confidence < LOW_CONFIDENCE);
  const nothingFound = merged.length === 0 && ignored.length > 0;
  const allUncategorized =
    merged.length > 0 && merged.every((item) => item.category === OTHER_CATEGORY);

  return {
    items: merged,
    ignored,
    needsLlm: hasLowConfidence || nothingFound || allUncategorized,
  };
}

/** 同一商品をまとめる。数量は「後勝ち、ただし null は上書きしない」。 */
export function dedupe(items: ParsedItem[]): ParsedItem[] {
  const byKey = new Map<string, ParsedItem>();
  for (const item of items) {
    const key = matchKey(item.name);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item });
      continue;
    }
    if (item.quantity !== null) {
      existing.quantity = item.quantity;
      existing.unit = item.unit ?? existing.unit;
    }
    if (item.note && item.note !== existing.note) {
      existing.note = existing.note ? `${existing.note} / ${item.note}` : item.note;
    }
    existing.confidence = Math.max(existing.confidence, item.confidence);
  }
  return [...byKey.values()];
}
