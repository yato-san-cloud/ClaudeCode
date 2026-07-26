/**
 * Claude API による解析フォールバック。
 *
 * ルールベースで拾いきれなかったときだけ呼ぶ。1メッセージあたり入力〜1.5k
 * (うち大半はキャッシュ済みシステムプロンプト) / 出力〜300トークン程度。
 *
 * 設計上の判断:
 *  - `effort: 'low'` … 買い物メモの抽出に深い推論は要らない。速度と費用を優先。
 *  - thinking は既定 (adaptive) のまま … Opus 5 で thinking を明示的に切ると
 *    出力に内部タグが漏れる既知の失敗モードがある。low effort で十分安い。
 *  - `output_config.format` … JSONスキーマで出力を拘束するので、パース失敗や
 *    前置き文 ("以下が結果です:") が原理的に起きない。
 *  - システムプロンプトの静的部分に `cache_control` … 全世帯で共有され、
 *    2回目以降の入力コストが約1/10になる。
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ParsedItem } from './rules';
import { CATEGORIES, OTHER_CATEGORY, categorize } from '../domain/categories';

export const DEFAULT_MODEL = 'claude-opus-5';

const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: '買い物リストに載せるべき品物。連絡事項や雑談は含めない。',
      items: {
        type: 'object',
        properties: {
          raw: {
            type: 'string',
            description: 'この品物に対応する原文の断片。書かれたままの文字列。',
          },
          name: {
            type: 'string',
            description: '品物の名前。数量・単位・依頼のことばを除いたもの。',
          },
          quantity: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: '数量。明示されていなければ null。推測で埋めない。',
          },
          unit: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: '単位 (本/個/パック/g など)。無ければ null。',
          },
          note: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: '「安いやつ」「特売なら」などの補足。無ければ null。',
          },
          category: {
            type: 'string',
            enum: CATEGORY_KEYS,
            description: '売り場。判断できなければ "other"。',
          },
        },
        required: ['raw', 'name', 'quantity', 'unit', 'note', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

const SYSTEM_INSTRUCTIONS = `あなたは日本語の家庭内チャットから買い物リストを抽出する専門のパーサです。
夫婦のLINEトークに流れるメッセージを受け取り、買ってくるべき品物だけを構造化して返します。

# 抽出の方針

1. 品物だけを取り出す。連絡事項・雑談・感謝・スケジュールの話は無視する。
   - 「今日は帰り遅くなる」「ありがとう!」「駅前のスーパーが安いらしいよ」→ 抽出しない
   - 「牛乳」「トイレットペーパー」→ 抽出する
2. 数量は書かれているときだけ埋める。書かれていなければ null。勝手に 1 を入れない。
   - 「卵」→ quantity: null
   - 「卵1パック」→ quantity: 1, unit: "パック"
   - 「牛乳2本」→ quantity: 2, unit: "本"
3. 「なくなりそう」「切らした」「もうない」は在庫切れの合図。品物として抽出し、
   note に「切らしそう」と入れる。
4. 括弧書きや「※」以降は note に入れる。品物名には含めない。
   - 「トマト缶(安いやつ)」→ name: "トマト缶", note: "安いやつ"
5. name は妻が書いた表記を尊重する。正式名称に言い換えない。
   - 「ぎゅうにゅう」→ name: "ぎゅうにゅう" (「牛乳」に直さない)
   - ただし依頼のことば (「買っといて」「お願い」) と助詞は落とす。
6. raw には、その品物に対応する原文の断片をそのまま入れる。
7. 一つのメッセージに複数の品物があれば全部拾う。「と」「、」「改行」で区切られる。
   - 「牛乳2本と卵、あと洗剤なくなりそう」→ 3件
8. 曖昧で品物か判断がつかない断片は、抽出しない方を選ぶ。
   誤って余計なものをリストに載せるより、取りこぼす方がましです。

# 売り場 (category)

品物をスーパーの売り場に分類してください。買い物中に売り場を行き来せずに
済ませるための情報です。判断できないものは "other" にしてください。

${CATEGORIES.filter((c) => c.key !== OTHER_CATEGORY)
  .map((c) => `- ${c.key}: ${c.label} (例: ${c.keywords.slice(0, 8).join('、')})`)
  .join('\n')}
- other: その他

# 例

入力: 「牛乳2本と卵、あと洗剤なくなりそう」
出力: 3件
  - raw:"牛乳2本" name:"牛乳" quantity:2 unit:"本" note:null category:"dairy"
  - raw:"卵" name:"卵" quantity:null unit:null note:null category:"dairy"
  - raw:"洗剤なくなりそう" name:"洗剤" quantity:null unit:null note:"切らしそう" category:"cleaning"

入力: 「今日遅くなる! ごめん。ついでにトマト缶(安いやつ)3つお願い」
出力: 1件
  - raw:"トマト缶(安いやつ)3つ" name:"トマト缶" quantity:3 unit:null note:"安いやつ" category:"packaged"

入力: 「明日の夕飯なにがいい?」
出力: 0件`;

export interface LlmParseOptions {
  apiKey: string;
  model?: string;
  /** その世帯でよく買うものの一覧。表記ゆれの手がかりとして渡す。 */
  knownItems?: string[];
  /** テスト用の差し替え */
  client?: Anthropic;
}

interface LlmItem {
  raw: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  category: string;
}

/**
 * 失敗しても投げない。null を返すので、呼び出し側はルールベースの結果を使う。
 * ネットワーク断・レート制限・拒否のいずれでも買い物リストが壊れないことを優先する。
 */
export async function parseWithLlm(
  message: string,
  options: LlmParseOptions,
): Promise<ParsedItem[] | null> {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const model = options.model || DEFAULT_MODEL;

  const householdContext = options.knownItems?.length
    ? `この家庭が過去に買ったもの (表記ゆれの手がかり):\n${options.knownItems.slice(0, 120).join('、')}`
    : 'この家庭の購入履歴はまだありません。';

  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      // 安全性分類器に弾かれた場合、同じ呼び出しの中で別モデルに回してもらう。
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        {
          type: 'text',
          text: SYSTEM_INSTRUCTIONS,
          // 全世帯で共通の接頭辞。ここまでをキャッシュする。
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: householdContext },
      ],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: 'user', content: message }],
    });

    // content を読む前に stop_reason を必ず確認する。
    if (response.stop_reason === 'refusal') {
      console.warn('[llm] refused', response.stop_details);
      return null;
    }
    if (response.stop_reason === 'max_tokens') {
      console.warn('[llm] truncated before producing complete JSON');
      return null;
    }

    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as { items?: LlmItem[] };
    if (!Array.isArray(parsed.items)) return null;

    return parsed.items.filter(isUsable).map(toParsedItem);
  } catch (error) {
    console.error('[llm] parse failed, falling back to rules:', error);
    return null;
  }
}

function isUsable(item: LlmItem): boolean {
  return typeof item?.name === 'string' && item.name.trim().length > 0;
}

function toParsedItem(item: LlmItem): ParsedItem {
  const name = item.name.trim();
  const category =
    typeof item.category === 'string' && CATEGORY_KEYS.includes(item.category)
      ? item.category
      : categorize(name);

  return {
    raw: (item.raw || name).trim(),
    name,
    quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity)
      ? item.quantity
      : null,
    unit: item.unit?.trim() || null,
    note: item.note?.trim() || null,
    category,
    // LLM が返したものは高信頼として扱う (スキーマで拘束済み)。
    confidence: 0.9,
  };
}
