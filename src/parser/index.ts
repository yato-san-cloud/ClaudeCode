/**
 * ハイブリッド解析のオーケストレーション。
 *
 * 1. まずルールベース (速い・無料・オフライン)
 * 2. 自信のない断片が残った場合だけ Claude API
 * 3. LLM が使えない / 失敗した場合はルールベースの結果をそのまま採用
 *
 * 「LLM が落ちても買い物リストは機能する」ことを不変条件にしている。
 */

import { parseWithRules, type ParsedItem, type RuleParseResult } from './rules';
import { parseWithLlm } from './llm';
import { matchKey } from './normalize';

export type { ParsedItem, RuleParseResult };
export { parseWithRules, LOW_CONFIDENCE } from './rules';
export { matchKey, normalize } from './normalize';

export interface ParseContext {
  /** その世帯の学習済み商品名 (表示名)。確信度とLLMの手がかりに使う。 */
  knownItems?: string[];
  apiKey?: string;
  model?: string;
}

export interface ParseResult {
  items: ParsedItem[];
  ignored: string[];
  /** 'rules' | 'llm' — 実際に採用した結果の出どころ */
  source: 'rules' | 'llm';
}

export async function parseMessage(
  message: string,
  context: ParseContext = {},
): Promise<ParseResult> {
  const knownItems = context.knownItems ?? [];
  const knownKeys = new Set(knownItems.map(matchKey));

  const ruleResult = parseWithRules(message, knownKeys);

  if (!ruleResult.needsLlm || !context.apiKey) {
    return { items: ruleResult.items, ignored: ruleResult.ignored, source: 'rules' };
  }

  const llmItems = await parseWithLlm(message, {
    apiKey: context.apiKey,
    model: context.model,
    knownItems,
  });

  if (!llmItems) {
    return { items: ruleResult.items, ignored: ruleResult.ignored, source: 'rules' };
  }

  // LLM が「品物なし」と判断し、かつルールベースが自信のあるものを拾っていたら、
  // ルールベースを信じる (LLM の取りこぼしより、確実な一致を優先)。
  if (llmItems.length === 0 && ruleResult.items.some((item) => item.confidence >= 0.9)) {
    return { items: ruleResult.items, ignored: ruleResult.ignored, source: 'rules' };
  }

  return { items: llmItems, ignored: ruleResult.ignored, source: 'llm' };
}
