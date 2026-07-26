/**
 * 売り場 (category) の定義と、商品名からの分類。
 *
 * `order` はスーパーを回る順路。チェックリストはこの順で並ぶので、
 * 売り場を行ったり来たりせずに済む。店のレイアウトに合わせて並び替えてよい。
 *
 * keywords はパーサの「既知の商品か?」判定も兼ねている。ここに載っている語は
 * 数量が付いていなくても確信度が上がるので、辞書を育てるほど誤検出が減る。
 */

import { matchKey } from '../parser/normalize';

export interface Category {
  key: string;
  label: string;
  order: number;
  keywords: string[];
}

export const CATEGORIES: Category[] = [
  {
    key: 'produce',
    label: '野菜・果物',
    order: 10,
    keywords: [
      'キャベツ', 'レタス', '白菜', 'ほうれん草', '小松菜', 'ねぎ', '長ねぎ', '玉ねぎ',
      'たまねぎ', 'にんじん', 'じゃがいも', 'さつまいも', '大根', 'かぼちゃ', 'なす',
      'きゅうり', 'トマト', 'ミニトマト', 'ピーマン', 'パプリカ', 'ブロッコリー',
      'アスパラ', 'もやし', 'えのき', 'しめじ', 'まいたけ', 'しいたけ', 'エリンギ',
      'にんにく', 'しょうが', '生姜', 'ごぼう', 'れんこん', 'かいわれ', '水菜',
      '春菊', 'にら', 'オクラ', 'ズッキーニ', 'セロリ', 'とうもろこし', '枝豆',
      'アボカド', 'レモン', 'りんご', 'みかん', 'バナナ', 'いちご', 'ぶどう',
      'キウイ', 'メロン', 'すいか', '桃', '梨', '柿', 'グレープフルーツ', 'パイナップル',
      'カット野菜', 'サラダ',
    ],
  },
  {
    key: 'meat',
    label: '精肉',
    order: 20,
    keywords: [
      '豚肉', '豚こま', '豚バラ', '豚ロース', '豚ひき肉', '牛肉', '牛こま', '牛バラ',
      '鶏肉', '鶏むね', '鶏もも', '手羽先', '手羽元', 'ささみ', 'ひき肉', '挽肉',
      '合いびき', 'ベーコン', 'ウインナー', 'ソーセージ', 'ハム', '肉',
    ],
  },
  {
    key: 'seafood',
    label: '鮮魚',
    order: 30,
    keywords: [
      '鮭', 'さけ', 'サーモン', 'さば', '鯖', 'ぶり', '鰤', 'たら', '鱈', 'あじ',
      'いわし', 'さんま', 'まぐろ', 'かつお', 'ホタテ', 'えび', '海老', 'いか',
      'たこ', 'あさり', 'しじみ', 'かに', '刺身', '魚', 'しらす', 'ちりめん',
    ],
  },
  {
    key: 'deli',
    label: '惣菜・弁当',
    order: 40,
    keywords: ['惣菜', '弁当', '唐揚げ', 'コロッケ', '天ぷら', '寿司', 'おにぎり', 'サラダチキン'],
  },
  {
    key: 'dairy',
    label: '乳製品・卵',
    order: 50,
    keywords: [
      '牛乳', 'ぎゅうにゅう', '低脂肪乳', '豆乳', 'ヨーグルト', 'チーズ', 'スライスチーズ',
      'ピザ用チーズ', 'クリームチーズ', 'バター', 'マーガリン', '生クリーム', '卵',
      'たまご', '玉子', 'ヤクルト', '飲むヨーグルト',
    ],
  },
  {
    key: 'bakery',
    label: 'パン',
    order: 60,
    keywords: ['食パン', 'パン', 'ロールパン', 'クロワッサン', 'バゲット', '菓子パン', 'ベーグル'],
  },
  {
    key: 'staples',
    label: '米・麺・乾物',
    order: 70,
    keywords: [
      '米', 'お米', 'パスタ', 'スパゲッティ', 'そうめん', 'うどん', 'そば', '中華麺',
      'ラーメン', '焼きそば', '小麦粉', '薄力粉', '強力粉', '片栗粉', 'パン粉',
      'ホットケーキミックス', '海苔', 'のり', 'わかめ', 'ひじき', '昆布', 'かつお節',
      '乾燥わかめ', '春雨', '麩', '切り餅', 'シリアル', 'オートミール',
    ],
  },
  {
    key: 'seasoning',
    label: '調味料',
    order: 80,
    keywords: [
      '醤油', 'しょうゆ', '味噌', 'みそ', '塩', '砂糖', '酢', 'みりん', '料理酒',
      'だし', '和風だし', 'コンソメ', '鶏がらスープ', '油', 'サラダ油', 'オリーブオイル',
      'ごま油', 'ケチャップ', 'マヨネーズ', 'ソース', 'ウスターソース', 'ポン酢',
      'めんつゆ', 'ドレッシング', 'カレールー', 'シチュールー', '胡椒', 'こしょう',
      '七味', '一味', 'わさび', 'からし', 'マスタード', 'はちみつ', 'ジャム',
      '焼肉のたれ', 'オイスターソース', '豆板醤', 'コチュジャン', 'ラー油',
    ],
  },
  {
    key: 'packaged',
    label: '加工食品・缶詰',
    order: 90,
    keywords: [
      '豆腐', '納豆', '油揚げ', '厚揚げ', 'こんにゃく', 'しらたき', 'ちくわ', 'はんぺん',
      'かまぼこ', 'ツナ缶', 'サバ缶', 'トマト缶', 'コーン缶', '缶詰', 'レトルト',
      'カップ麺', 'インスタント', 'お茶漬け', 'ふりかけ', '味付けのり', '梅干し',
      '漬物', 'キムチ', 'ジップロック',
    ],
  },
  {
    key: 'frozen',
    label: '冷凍食品',
    order: 100,
    keywords: ['冷凍', '冷食', 'アイス', 'アイスクリーム', '氷', '冷凍餃子', '冷凍うどん', '冷凍野菜'],
  },
  {
    key: 'snacks',
    label: 'お菓子',
    order: 110,
    keywords: [
      'お菓子', 'おかし', 'チョコ', 'クッキー', 'ビスケット', 'ポテチ', 'ポテトチップス',
      'スナック', 'せんべい', 'あめ', 'グミ', 'ガム', 'プリン', 'ゼリー', 'ケーキ',
    ],
  },
  {
    key: 'drinks',
    label: '飲料',
    order: 120,
    keywords: [
      'お茶', '緑茶', '麦茶', '烏龍茶', 'コーヒー', '紅茶', 'ジュース', 'オレンジジュース',
      'りんごジュース', 'water', '水', 'ミネラルウォーター', '炭酸水', 'コーラ',
      'スポーツドリンク', 'ポカリ', 'アクエリアス', '野菜ジュース',
    ],
  },
  {
    key: 'alcohol',
    label: 'お酒',
    order: 130,
    keywords: ['ビール', '発泡酒', 'チューハイ', 'ハイボール', 'ワイン', '日本酒', '焼酎', 'ウイスキー', '梅酒'],
  },
  {
    key: 'household',
    label: '日用品',
    order: 140,
    keywords: [
      'トイレットペーパー', 'ティッシュ', 'ボックスティッシュ', 'キッチンペーパー',
      'ラップ', 'アルミホイル', 'クッキングシート', 'ゴミ袋', 'ごみ袋', '割り箸',
      '爪楊枝', '乾電池', '電池', '電球', 'マスク', '絆創膏', '歯ブラシ', '歯磨き粉',
      'シャンプー', 'リンス', 'コンディショナー', 'ボディソープ', '石鹸', 'せっけん',
      'ハンドソープ', 'カミソリ', '化粧水', '日焼け止め', '生理用品', 'コンタクト',
    ],
  },
  {
    key: 'cleaning',
    label: '洗剤・掃除',
    order: 150,
    keywords: [
      '洗剤', '食器用洗剤', '洗濯洗剤', '柔軟剤', '漂白剤', 'ハイター', '重曹',
      'クエン酸', 'カビキラー', 'スポンジ', '掃除', 'ウェットシート', 'クイックル',
      '消臭剤', '芳香剤', '虫除け', '殺虫剤',
    ],
  },
  {
    key: 'baby',
    label: 'ベビー',
    order: 160,
    keywords: ['おむつ', 'オムツ', 'おしりふき', '粉ミルク', '離乳食', 'ベビーフード'],
  },
  {
    key: 'pet',
    label: 'ペット',
    order: 170,
    keywords: ['ペットフード', 'キャットフード', 'ドッグフード', '猫砂', 'ペットシーツ'],
  },
  {
    key: 'medicine',
    label: '医薬品',
    order: 180,
    keywords: ['風邪薬', '頭痛薬', '胃薬', '目薬', '湿布', '体温計', 'サプリ', 'ビタミン'],
  },
  { key: 'other', label: 'その他', order: 999, keywords: [] },
];

export const OTHER_CATEGORY = 'other';

/** キーワードの照合キー -> カテゴリキー。長いキーワードを優先するため長さ降順で保持。 */
const KEYWORD_INDEX: ReadonlyArray<{ key: string; category: string }> = CATEGORIES.flatMap((c) =>
  c.keywords.map((word) => ({ key: matchKey(word), category: c.key })),
)
  .filter((entry) => entry.key.length > 0)
  .sort((a, b) => b.key.length - a.key.length);

const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** 商品名から売り場を推定する。該当なしは 'other'。 */
export function categorize(name: string): string {
  const key = matchKey(name);
  if (!key) return OTHER_CATEGORY;
  for (const entry of KEYWORD_INDEX) {
    if (key.includes(entry.key)) return entry.category;
  }
  return OTHER_CATEGORY;
}

/** 辞書に載っている商品か。パーサの確信度に使う。 */
export function isKnownItem(name: string): boolean {
  return categorize(name) !== OTHER_CATEGORY;
}

export function categoryLabel(key: string): string {
  return CATEGORY_BY_KEY.get(key)?.label ?? 'その他';
}

export function categoryOrder(key: string): number {
  return CATEGORY_BY_KEY.get(key)?.order ?? 999;
}

/** 売り場順に並べ替えるための比較関数 */
export function compareByCategory(a: string, b: string): number {
  return categoryOrder(a) - categoryOrder(b);
}
