/**
 * LINEの1メッセージを「商品らしき断片」に切り分ける。
 *
 * ここが日本語入力のいちばん厄介なところ。「牛乳2本と卵、あと洗剤なくなりそう」
 * のような一文を、区切り記号 → 助詞「と」 の順に、保守的に分解する。
 * 誤って分割するくらいなら1つのまま残す方針 (後段のLLMが拾える)。
 */

import { normalize } from './normalize';
import { isKnownItem } from '../domain/categories';
import { UNITS } from './units';

/** 名詞のあとに付きうる助詞。長音符「ー」は入れない (カタカナ語が壊れる)。 */
const TRAILING_PARTICLE = /[はがをもとやのねよな]$/u;

/**
 * 末尾の助詞を落とす。「牛乳を」→「牛乳」
 *
 * ひらがな書きの商品名を壊さないのが要点。「さかな」の「な」や「もも」の「も」は
 * 助詞ではなく名詞の一部なので、直前がひらがなのときは、残りが辞書にある
 * 商品でない限り触らない。
 */
export function stripParticles(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !TRAILING_PARTICLE.test(trimmed)) return trimmed;

  const candidate = trimmed.slice(0, -1).trim();
  if (!candidate) return trimmed;

  const precedesHiragana = /[ぁ-ん]$/u.test(candidate);
  if (precedesHiragana && !isKnownItem(candidate)) return trimmed;
  return candidate;
}

/** 行頭の箇条書き記号 */
const BULLET = /^\s*(?:[-*+・･•‧]|[0-9]+\s*[.)、]|[（(]?[0-9]+[）)]|[①-⑳]|[□☐■◻◼☑✓✔○●◯])\s*/u;

/** 依頼のことば。商品名ではないので落とす。 */
const REQUEST_NOISE = [
  /(?:を)?(?:お|お)?(?:願|ねが)い(?:します|ね|〜)?[。!！]*$/u,
  /買(?:っ|って)(?:といて|おいて|きて|てきて|て)?(?:ね|下さい|ください|くれる\??)?[。!！]*$/u,
  /よろしく(?:ね|お願いします)?[。!！]*$/u,
  /頼(?:む|みます)(?:ね)?[。!！]*$/u,
  /(?:が)?(?:欲|ほ)しい(?:な|です|の)?[。!！]*$/u,
  /(?:を)?(?:忘|わす)れずに[。!！]*$/u,
];

/** 「在庫が切れた」系。商品自体は必要なので落として note に回す。 */
export const SHORTAGE_NOISE =
  /(?:が)?(?:もう)?(?:な|無)くなり(?:そう|ました)|(?:が)?切れ(?:そう|た)|(?:を)?切らし(?:た|ちゃった)|(?:が)?(?:もう)?ない(?:よ|ね)?$|残り(?:わずか|少ない)/u;

/** 明らかに商品ではない相槌・連絡 */
const CHATTER_PREFIX =
  /^(?:ありがと|あざす|よろしく|おはよう|こんばんは|こんにちは|ごめん|すまん|了解|りょうかい|オッケー|ok|おつかれ|ただいま|いってらっしゃい|気をつけて|愛して)/iu;

/**
 * 会話に出てくる語。既知の商品を含まない断片にこれがあれば連絡事項とみなす。
 * 「牛乳よろしく」は商品を含むので生き残り、「明日買い物よろしく!」は落ちる。
 */
const CHATTER_WORDS =
  /(?:よろしく|ありがと|お願いします|おはよう|ごめん|了解|遅くなる|遅くなり|帰り|夕飯|晩ご飯|昼ご飯|お疲れ|大丈夫|いってきます|ただいま)/u;

/** 文らしさ。長くてこれが出てきたら連絡事項とみなす。 */
const SENTENCE_ENDING =
  /(?:です|ます|でした|ました|だった|だから|けど|かも|と思う|ですね|ますね|しよう|しない\?|ください|下さい|ちょうだい)/u;

/**
 * 行頭の接続詞・つなぎ言葉。「あと洗剤」の「あと」を落とす。
 *
 * 「あとりえ」のような商品名を壊さないよう、区切り記号が続くか、
 * 残りが既知の商品か、残りがひらがな以外で始まるときだけ剥がす。
 */
const LEADING_NOISE =
  /^(?:あとは|あとで|あと|それと|それから|ついでに|とりあえず|できれば|なるべく|あわせて|ちなみに|そういえば)[\s、,]*/u;

export function stripLeadingNoise(fragment: string): string {
  const match = fragment.match(LEADING_NOISE);
  if (!match) return fragment;

  const rest = fragment.slice(match[0].length).trim();
  if (!rest) return fragment;

  const hadSeparator = /[\s、,]$/.test(match[0]);
  const startsWithHiragana = /^[ぁ-ん]/u.test(rest);
  if (hadSeparator || isKnownItem(rest) || !startsWithHiragana) return rest;
  return fragment;
}

const UNIT_ALTERNATION = UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/** 「…2本」のように数量+単位で終わっているか (「と」で切ってよい強い合図) */
const ENDS_WITH_QUANTITY = new RegExp(
  `(?:[0-9]+(?:\\.[0-9]+)?|[〇零一二三四五六七八九十]+)\\s*(?:${UNIT_ALTERNATION})$`,
  'iu',
);

/**
 * 助詞「と」での分割。誤爆 (「たまごとうふ」「とうもろこし」) を避けるため、
 * 次のどちらかを満たすときだけ切る:
 *   1. 「と」の直前が数量+単位で終わっている  … 牛乳2本と卵
 *   2. 「と」の左右がどちらも辞書にある商品   … 豆腐とねぎ
 */
export function splitOnTo(fragment: string, depth = 0): string[] {
  if (depth > 8) return [fragment];
  for (let i = 1; i < fragment.length - 1; i++) {
    if (fragment[i] !== 'と') continue;
    const left = fragment.slice(0, i).trim();
    const right = fragment.slice(i + 1).trim();
    if (!left || !right) continue;

    const byQuantity = ENDS_WITH_QUANTITY.test(left);
    const byDictionary = isKnownItem(left) && isKnownItem(right.split('と')[0] ?? right);
    if (!byQuantity && !byDictionary) continue;

    return [left, ...splitOnTo(right, depth + 1)];
  }
  return [fragment];
}

/** 連絡事項っぽい行か */
export function isLikelyChatter(fragment: string): boolean {
  const text = normalize(fragment);
  if (!text) return true;
  if (/[?？]\s*$/.test(text)) return true;
  if (CHATTER_PREFIX.test(text)) return true;

  // 既知の商品を含んでいれば、多少ことばが付いていても買い物メモとして扱う
  if (isKnownItem(text)) return false;

  if (CHATTER_WORDS.test(text)) return true;
  if (text.length >= 14 && SENTENCE_ENDING.test(text)) return true;
  return false;
}

/** 依頼のことばを剥がす。剥がした結果が空なら元のまま返す。 */
export function stripRequestNoise(fragment: string): string {
  let text = normalize(fragment);
  for (const pattern of REQUEST_NOISE) {
    const next = text.replace(pattern, '').trim();
    if (next) text = next;
  }
  return text.trim();
}

export interface Fragment {
  /** 妻が書いた原文 (行または区切りごと) */
  raw: string;
  /** ノイズを落とした後の本体 */
  text: string;
  /** （）や※で書かれた補足 */
  note: string | null;
  /** 「なくなりそう」等が付いていたか */
  shortage: boolean;
}

const NOTE_PATTERN = /[（(【\[]([^）)】\]]{1,40})[）)】\]]|[※*]\s*([^\s].{0,40})$/u;

/** 補足を抜き出して本体と分ける */
export function extractNote(fragment: string): { text: string; note: string | null } {
  const match = fragment.match(NOTE_PATTERN);
  if (!match) return { text: fragment.trim(), note: null };
  const note = (match[1] ?? match[2] ?? '').trim();
  const start = match.index ?? 0;
  const text = (fragment.slice(0, start) + fragment.slice(start + match[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { text: text || fragment.trim(), note: note || null };
}

/**
 * メッセージ全体を断片に分解する。
 * 返るのは「商品候補」だけ。落とした行は `ignored` に入れて呼び出し側に返す。
 */
export function segment(message: string): { fragments: Fragment[]; ignored: string[] } {
  const fragments: Fragment[] = [];
  const ignored: string[] = [];

  // 改行で割るのが先。normalize() は空白を1つに潰すので、
  // 先に正規化すると複数行のメモが1行に潰れてしまう。
  for (const rawLine of message.split(/\r?\n/)) {
    const line = normalize(rawLine);
    if (!line) continue;

    const hadBullet = BULLET.test(line);
    const deBulleted = line.replace(BULLET, '').trim();
    if (!deBulleted) continue;

    // 区切り記号で分ける。中黒は箇条書き記号と紛らわしいので、
    // 行頭が箇条書きだった場合は区切りとして使わない。
    const separators = hadBullet ? /[、,，/／&＆]+/u : /[、,，/／&＆・･]+/u;

    for (const piece of deBulleted.split(separators)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;

      for (const candidate of splitOnTo(trimmed)) {
        const raw = candidate.trim();
        if (!raw) continue;

        if (isLikelyChatter(raw)) {
          ignored.push(raw);
          continue;
        }

        const shortage = SHORTAGE_NOISE.test(raw);
        const withoutShortage = shortage ? raw.replace(SHORTAGE_NOISE, '').trim() : raw;
        const { text: withoutNote, note } = extractNote(withoutShortage);
        const body = stripParticles(stripLeadingNoise(stripRequestNoise(withoutNote)));

        if (!body) {
          ignored.push(raw);
          continue;
        }
        fragments.push({ raw, text: body, note, shortage });
      }
    }
  }

  return { fragments, ignored };
}
