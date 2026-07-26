/**
 * 表記ゆれを吸収するための正規化。
 *
 * `normalize` は表示に使える形 (全角英数・記号を半角に、空白を潰す)。
 * `matchKey` は照合専用の潰したキー。カタカナ→ひらがな、長音・記号の除去まで
 * やるので「ギュウニュウ」「ぎゅうにゅう」「牛 乳」が同じキーにならない点に注意
 * (漢字は漢字のまま)。あくまで「かな表記のゆれ」を吸収するためのもの。
 */

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '') // ゼロ幅文字
    .replace(/\s+/g, ' ')
    .trim();
}

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = 0x60;

/** カタカナをひらがなに落とす (ヴ・小書き文字も含む範囲) */
export function katakanaToHiragana(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out +=
      code >= KATAKANA_START && code <= KATAKANA_END
        ? String.fromCharCode(code - KANA_OFFSET)
        : ch;
  }
  return out;
}

/**
 * 照合キー。小文字化 + カタカナ→ひらがな + 空白/中黒/長音/句読点の除去。
 * 「トマト・缶」→「とまとかん」、「ﾄﾏﾄ」→「とまと」。
 */
export function matchKey(text: string): string {
  return katakanaToHiragana(normalize(text))
    .toLowerCase()
    .replace(/[\s・･ー―‐\-–—.,。、!！?？'"「」『』()（）]/g, '');
}

// 末尾助詞の除去は「商品名かどうか」の知識が要るため segment.ts にある。
// (長音符「ー」を助詞と並べて一律に削ると「トイレットペーパー」が壊れる)
