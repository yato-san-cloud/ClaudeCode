/**
 * LINEに返すメッセージの組み立て。
 *
 * 方針: トークを埋め尽くさない。Botの返信は「受け取ったよ」の1通に集約し、
 * 細かい操作はLIFF側でやってもらう。チェックリストの全文をトークに流すと
 * 元の「読みにくい」問題に戻ってしまう。
 */

import { categoryLabel } from '../domain/categories';
import { groupByCategory } from '../domain/lists';
import type { ListItemRow } from '../types';
import type { Suggestion } from '../domain/suggest';
import type { LineMessage } from './client';

export function liffUrl(liffId: string): string {
  return `https://liff.line.me/${liffId}`;
}

export function text(body: string): LineMessage {
  return { type: 'text', text: body };
}

/** 数量と単位を「2本」「300g」の形に */
export function formatQuantity(item: Pick<ListItemRow, 'quantity' | 'unit'>): string {
  if (item.quantity === null) return item.unit ?? '';
  const quantity = Number.isInteger(item.quantity)
    ? String(item.quantity)
    : String(item.quantity);
  return item.unit ? `${quantity}${item.unit}` : quantity;
}

export function formatItemLine(item: ListItemRow): string {
  const quantity = formatQuantity(item);
  const note = item.note ? `（${item.note}）` : '';
  const uncertain = item.confidence < 0.5 ? ' ⚠️' : '';
  return `${item.name}${quantity ? ` ${quantity}` : ''}${note}${uncertain}`;
}

/**
 * リストの要約カード。売り場ごとに最大 MAX_LINES 行まで出し、
 * 残りは「ほか n 件」に丸めてLIFFへ誘導する。
 */
const MAX_LINES = 12;

export function listCard(
  items: readonly ListItemRow[],
  liffId: string,
  heading = '買い物リスト',
): LineMessage {
  const remaining = items.filter((item) => item.checked === 0);
  const done = items.length - remaining.length;

  if (items.length === 0) {
    return {
      type: 'text',
      text: 'いまリストは空です。ほしいものを送ってくれれば追加します。',
    };
  }

  const contents: unknown[] = [];
  let printed = 0;
  let omitted = 0;

  for (const group of groupByCategory(remaining)) {
    if (printed >= MAX_LINES) {
      omitted += group.items.length;
      continue;
    }
    contents.push({
      type: 'text',
      text: categoryLabel(group.category),
      size: 'xs',
      color: '#8a8f98',
      margin: 'md',
      weight: 'bold',
    });
    for (const item of group.items) {
      if (printed >= MAX_LINES) {
        omitted += 1;
        continue;
      }
      contents.push({
        type: 'text',
        text: `・${formatItemLine(item)}`,
        size: 'sm',
        color: '#1f2328',
        wrap: true,
      });
      printed += 1;
    }
  }

  if (omitted > 0) {
    contents.push({
      type: 'text',
      text: `…ほか ${omitted} 件`,
      size: 'xs',
      color: '#8a8f98',
      margin: 'sm',
    });
  }

  return {
    type: 'flex',
    altText: `${heading}（残り${remaining.length}件）`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        backgroundColor: '#06c755',
        contents: [
          { type: 'text', text: heading, color: '#ffffff', weight: 'bold', size: 'md' },
          {
            type: 'text',
            text: done > 0 ? `残り ${remaining.length} 件 / 済 ${done} 件` : `${remaining.length} 件`,
            color: '#e8fff1',
            size: 'xs',
            margin: 'xs',
          },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '16px', contents },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#06c755',
            height: 'sm',
            action: { type: 'uri', label: 'チェックリストを開く', uri: liffUrl(liffId) },
          },
        ],
      },
    },
  };
}

/** 追加したことの短い確認。トークを汚さないよう1行に収める。 */
export function addedSummary(
  added: readonly ListItemRow[],
  updated: readonly ListItemRow[],
  ignoredCount: number,
): string {
  const parts: string[] = [];
  if (added.length > 0) {
    const names = added.map((item) => formatItemLine(item)).join('、');
    parts.push(`追加しました: ${names}`);
  }
  if (updated.length > 0) {
    parts.push(`更新: ${updated.map((item) => formatItemLine(item)).join('、')}`);
  }
  if (parts.length === 0) {
    return ignoredCount > 0
      ? '買うものは見つかりませんでした。品名だけ送ってもらえると確実です。'
      : '買うものは見つかりませんでした。';
  }
  return parts.join('\n');
}

/** 提案カード。ワンタップで追加できるようポストバックを付ける。 */
export function suggestionCard(
  suggestions: readonly Suggestion[],
  liffId: string,
): LineMessage {
  if (suggestions.length === 0) {
    return text('いまのところ提案はありません。買い物の履歴がたまると精度が上がります。');
  }

  const rows = suggestions.slice(0, 6).map((suggestion) => ({
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    spacing: 'xs',
    contents: [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: `＋ ${suggestion.item.canonical_name}`.slice(0, 20),
          data: `add:${suggestion.item.id}`,
          displayText: `${suggestion.item.canonical_name} を追加`,
        },
      },
      { type: 'text', text: suggestion.reason, size: 'xxs', color: '#8a8f98', wrap: true },
    ],
  }));

  return {
    type: 'flex',
    altText: 'そろそろ切れそうなもの',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        backgroundColor: '#f2a71b',
        contents: [
          { type: 'text', text: 'そろそろ切れそう', color: '#ffffff', weight: 'bold' },
          {
            type: 'text',
            text: '買い物の周期から予想しています',
            color: '#fff6e5',
            size: 'xs',
            margin: 'xs',
          },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: rows },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: { type: 'uri', label: 'まとめて選ぶ', uri: liffUrl(liffId) },
          },
        ],
      },
    },
  };
}

export const HELP_TEXT = `【使い方】
ふつうに買うものを送るだけでリストに入ります。
例）牛乳2本と卵、あと洗剤なくなりそう

■ Botへの合図
・リスト … いまのリストを表示
・完了 … 買い物を終える（履歴に記録して学習）
・いつもの … 定番をまとめて追加
・提案 … そろそろ切れそうなものを出す
・削除 牛乳 … 1つ取り消す
・全部消す … リストを空にする
・ヘルプ … これ

■ チェックは画面で
リストのボタンから開くと、売り場ごとに並んだ
チェックリストになります。二人同時に開いてもOK。`;

export const WELCOME_TEXT = `買い物リストBotです。
このトークに買うものを書くと、自動でチェックリストになります。

例）牛乳2本と卵、あと洗剤なくなりそう

「ヘルプ」と送ると使い方が出ます。`;
