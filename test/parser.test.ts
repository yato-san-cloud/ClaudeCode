import { describe, expect, it } from 'vitest';
import { matchKey, normalize, katakanaToHiragana } from '../src/parser/normalize';
import { extractQuantity, parseKanjiNumber, canonicalUnit } from '../src/parser/units';
import {
  segment,
  splitOnTo,
  isLikelyChatter,
  extractNote,
  stripParticles,
  stripLeadingNoise,
} from '../src/parser/segment';
import { parseWithRules } from '../src/parser/rules';

describe('normalize', () => {
  it('全角英数を半角に、空白を1つに潰す', () => {
    expect(normalize('ＴＯＭＡＴＯ　　１２３')).toBe('TOMATO 123');
  });

  it('カタカナをひらがなに落とす', () => {
    expect(katakanaToHiragana('ギュウニュウ')).toBe('ぎゅうにゅう');
  });

  it('照合キーで表記ゆれが吸収される', () => {
    expect(matchKey('ギュウニュウ')).toBe(matchKey('ぎゅうにゅう'));
    expect(matchKey('トイレットペーパー')).toBe(matchKey('といれっとぺーぱー'));
    // 半角カナも NFKC で全角化されてから比較される
    expect(matchKey('ﾄﾏﾄ')).toBe(matchKey('トマト'));
  });

});

describe('stripParticles', () => {
  it('漢字・カタカナのあとの助詞を落とす', () => {
    expect(stripParticles('牛乳を')).toBe('牛乳');
    expect(stripParticles('パンや')).toBe('パン');
  });

  it('助詞が無ければそのまま', () => {
    expect(stripParticles('卵')).toBe('卵');
  });

  it('カタカナ語の長音符を削らない', () => {
    // 「ー」を助詞と一緒に削ると商品名が壊れる (実際に踏んだバグ)
    expect(stripParticles('トイレットペーパー')).toBe('トイレットペーパー');
    expect(stripParticles('コーヒー')).toBe('コーヒー');
    expect(stripParticles('バター')).toBe('バター');
  });

  it('ひらがな名詞の末尾を助詞と誤認しない', () => {
    expect(stripParticles('さかな')).toBe('さかな');
    expect(stripParticles('もも')).toBe('もも');
  });

  it('ひらがなでも辞書にある商品なら助詞を落とす', () => {
    expect(stripParticles('たまごを')).toBe('たまご');
  });

  it('助詞1文字だけの入力を空にしない', () => {
    expect(stripParticles('と')).toBe('と');
  });
});

describe('stripLeadingNoise', () => {
  it('つなぎ言葉を落とす', () => {
    expect(stripLeadingNoise('あと洗剤')).toBe('洗剤');
    expect(stripLeadingNoise('あとトイレットペーパー')).toBe('トイレットペーパー');
    expect(stripLeadingNoise('それと牛乳')).toBe('牛乳');
    expect(stripLeadingNoise('あと 卵')).toBe('卵');
  });

  it('「あと」で始まるひらがな語を壊さない', () => {
    expect(stripLeadingNoise('あとりえ')).toBe('あとりえ');
  });
});

describe('parseKanjiNumber', () => {
  it.each([
    ['一', 1],
    ['三', 3],
    ['十', 10],
    ['十五', 15],
    ['二十', 20],
    ['三十二', 32],
  ])('%s → %i', (input, expected) => {
    expect(parseKanjiNumber(input)).toBe(expected);
  });

  it('漢数字以外は null', () => {
    expect(parseKanjiNumber('牛乳')).toBeNull();
    expect(parseKanjiNumber('')).toBeNull();
  });
});

describe('extractQuantity', () => {
  it('数値+単位を末尾から取る', () => {
    expect(extractQuantity('牛乳2本')).toMatchObject({ quantity: 2, unit: '本', name: '牛乳' });
    expect(extractQuantity('卵 1パック')).toMatchObject({ quantity: 1, unit: 'パック', name: '卵' });
    expect(extractQuantity('豚こま300g')).toMatchObject({ quantity: 300, unit: 'g', name: '豚こま' });
  });

  it('全角数字も NFKC で拾える', () => {
    expect(extractQuantity('牛乳２本')).toMatchObject({ quantity: 2, unit: '本' });
  });

  it('漢数字も拾える', () => {
    expect(extractQuantity('にんじん二本')).toMatchObject({ quantity: 2, unit: '本', name: 'にんじん' });
  });

  it('×N 表記', () => {
    expect(extractQuantity('トイレットペーパー×2')).toMatchObject({
      quantity: 2,
      unit: null,
      name: 'トイレットペーパー',
    });
  });

  it('「3つ」を数量として扱う', () => {
    expect(extractQuantity('たまねぎ3つ')).toMatchObject({ quantity: 3, unit: 'つ' });
  });

  it('和語の数詞', () => {
    expect(extractQuantity('レモンふたつ')).toMatchObject({ quantity: 2, name: 'レモン' });
  });

  it('数量が無ければ null のまま', () => {
    const result = extractQuantity('醤油');
    expect(result.quantity).toBeNull();
    expect(result.unit).toBeNull();
    expect(result.name).toBe('醤油');
  });

  it('商品名の中の数字を数量と誤認しない', () => {
    // 「三ツ矢サイダー」の「三」は単位が続かないので数量にならない
    const result = extractQuantity('三ツ矢サイダー');
    expect(result.name).toBe('三ツ矢サイダー');
    expect(result.quantity).toBeNull();
  });

  it('単位表記を代表形に寄せる', () => {
    expect(canonicalUnit('グラム')).toBe('g');
    expect(canonicalUnit('cc')).toBe('ml');
    expect(canonicalUnit('コ')).toBe('個');
  });
});

describe('splitOnTo', () => {
  it('数量+単位のあとの「と」で切る', () => {
    expect(splitOnTo('牛乳2本と卵')).toEqual(['牛乳2本', '卵']);
  });

  it('左右がどちらも既知の商品なら切る', () => {
    expect(splitOnTo('豆腐とねぎ')).toEqual(['豆腐', 'ねぎ']);
  });

  it('商品名に含まれる「と」では切らない', () => {
    // 「とうもろこし」は先頭が「と」。切ってはいけない。
    expect(splitOnTo('とうもろこし')).toEqual(['とうもろこし']);
  });

  it('未知語どうしは切らない（誤爆より取りこぼしを選ぶ）', () => {
    expect(splitOnTo('ほげとふが')).toEqual(['ほげとふが']);
  });

  it('3つ以上でも連鎖して切れる', () => {
    expect(splitOnTo('パンと牛乳とバナナ')).toEqual(['パン', '牛乳', 'バナナ']);
  });
});

describe('isLikelyChatter', () => {
  it.each([
    '明日の夕飯なにがいい?',
    'ありがとう!',
    '今日は帰りが遅くなりそうなので先に食べてください',
  ])('連絡事項として落とす: %s', (input) => {
    expect(isLikelyChatter(input)).toBe(true);
  });

  it.each(['牛乳', 'トイレットペーパー', '豚こま300g'])(
    '品物は落とさない: %s',
    (input) => {
      expect(isLikelyChatter(input)).toBe(false);
    },
  );
});

describe('extractNote', () => {
  it('括弧書きを補足として切り出す', () => {
    expect(extractNote('トマト缶(安いやつ)')).toEqual({ text: 'トマト缶', note: '安いやつ' });
  });

  it('※以降を補足にする', () => {
    expect(extractNote('牛乳 ※特売なら2本')).toEqual({ text: '牛乳', note: '特売なら2本' });
  });

  it('補足が無ければ null', () => {
    expect(extractNote('牛乳')).toEqual({ text: '牛乳', note: null });
  });
});

describe('segment', () => {
  it('読点・改行・箇条書きで分ける', () => {
    const { fragments } = segment('・牛乳\n・卵、パン');
    expect(fragments.map((f) => f.text)).toEqual(['牛乳', '卵', 'パン']);
  });

  it('番号付きリストの番号を落とす', () => {
    const { fragments } = segment('1. 牛乳\n2) 卵');
    expect(fragments.map((f) => f.text)).toEqual(['牛乳', '卵']);
  });

  it('依頼のことばを剥がす', () => {
    const { fragments } = segment('牛乳買っといて');
    expect(fragments[0]?.text).toBe('牛乳');
  });

  it('在庫切れの合図を検出して本体から外す', () => {
    const { fragments } = segment('洗剤なくなりそう');
    expect(fragments[0]?.text).toBe('洗剤');
    expect(fragments[0]?.shortage).toBe(true);
  });

  it('原文を保持する', () => {
    const { fragments } = segment('牛乳買っといて');
    expect(fragments[0]?.raw).toBe('牛乳買っといて');
  });
});

describe('parseWithRules', () => {
  it('ユーザーの元の例を正しく3件に割る', () => {
    const result = parseWithRules('牛乳2本と卵、あと洗剤なくなりそう');
    expect(result.items).toHaveLength(3);

    expect(result.items[0]).toMatchObject({
      name: '牛乳',
      quantity: 2,
      unit: '本',
      category: 'dairy',
    });
    expect(result.items[1]).toMatchObject({ name: '卵', quantity: null, category: 'dairy' });
    expect(result.items[2]).toMatchObject({ name: '洗剤', note: '切らしそう', category: 'cleaning' });
  });

  it('既知の商品には高い確信度を付ける', () => {
    const result = parseWithRules('牛乳');
    expect(result.items[0]!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.needsLlm).toBe(false);
  });

  it('世帯の学習済み商品はさらに強い確信度になる', () => {
    const known = new Set([matchKey('ばんそうこう')]);
    const result = parseWithRules('ばんそうこう', known);
    expect(result.items[0]!.confidence).toBeGreaterThan(0.95);
  });

  it('自信のない断片が残ったら LLM を要求する', () => {
    const result = parseWithRules('例のあれ、頼んだやつ');
    expect(result.needsLlm).toBe(true);
  });

  it('連絡事項だけのメッセージからは何も抽出しない', () => {
    const result = parseWithRules('今日は帰りが遅くなりそうです');
    expect(result.items).toHaveLength(0);
    expect(result.ignored.length).toBeGreaterThan(0);
  });

  it('同じ商品が二度書かれたらまとめる', () => {
    const result = parseWithRules('卵\nたまご1パック');
    // 「卵」と「たまご」は照合キーが違うので別物として残る（漢字とかなは別）
    // 同一表記の重複だけをまとめることを確認する
    const same = parseWithRules('牛乳\n牛乳2本');
    expect(same.items).toHaveLength(1);
    expect(same.items[0]).toMatchObject({ quantity: 2, unit: '本' });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('売り場を割り当てる', () => {
    const result = parseWithRules('豚こま300g\nトイレットペーパー\nキャベツ');
    expect(result.items.map((item) => item.category)).toEqual(['meat', 'household', 'produce']);
  });

  it('複数行の実際の買い物メモを処理できる', () => {
    const message = [
      '明日買い物よろしく!',
      '・食パン',
      '・豚こま 300g',
      '・ヨーグルト2個',
      '・トマト缶（安いやつ）',
      'あとトイレットペーパー切れそう',
    ].join('\n');

    const result = parseWithRules(message);
    const names = result.items.map((item) => item.name);

    expect(names).toContain('食パン');
    expect(names).toContain('豚こま');
    expect(names).toContain('ヨーグルト');
    expect(names).toContain('トマト缶');
    expect(names).toContain('トイレットペーパー');
    expect(names).not.toContain('明日買い物よろしく!');

    const tomato = result.items.find((item) => item.name === 'トマト缶');
    expect(tomato?.note).toBe('安いやつ');
  });
});
