/**
 * Botへの「合図」の判定。純粋関数なのでテストしやすい。
 *
 * 合図に当たらないメッセージはすべて買い物メモとして解析に回る。
 * 妻の入力習慣を変えないことが目的なので、合図はできるだけ短く、
 * かつ普通の買い物メモと衝突しない語だけを選んでいる。
 */

import { normalize } from '../parser/normalize';

export type Command =
  | { kind: 'show' }
  | { kind: 'complete' }
  | { kind: 'usual' }
  | { kind: 'suggest' }
  | { kind: 'clear' }
  | { kind: 'help' }
  | { kind: 'remove'; name: string }
  | { kind: 'items' };

const EXACT: ReadonlyArray<[RegExp, Command['kind']]> = [
  [/^(?:リスト|りすと|一覧|いちらん|list)$/iu, 'show'],
  [/^(?:完了|かんりょう|おわり|終わり|done|買い物完了|かいものかんりょう)$/iu, 'complete'],
  [/^(?:いつもの|いつものやつ|定番|ていばん)$/u, 'usual'],
  [/^(?:提案|ていあん|そろそろ|おすすめ|オススメ)$/u, 'suggest'],
  [/^(?:全部消す|ぜんぶけす|クリア|くりあ|リセット|clear|reset)$/iu, 'clear'],
  [/^(?:ヘルプ|へるぷ|使い方|つかいかた|help|\?|？)$/iu, 'help'],
];

const REMOVE = /^(?:削除|さくじょ|消して|けして|取り消し|とりけし|remove|delete)\s*[:：]?\s*(.+)$/iu;

export function parseCommand(message: string): Command {
  const text = normalize(message);

  for (const [pattern, kind] of EXACT) {
    if (pattern.test(text)) return { kind } as Command;
  }

  const removeMatch = text.match(REMOVE);
  if (removeMatch?.[1]) {
    const name = removeMatch[1].trim();
    if (name) return { kind: 'remove', name };
  }

  return { kind: 'items' };
}
