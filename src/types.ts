export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  /** LINE Messaging API チャネル */
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;

  /** LIFF (チェックリスト画面) */
  LIFF_ID: string;
  /** IDトークン検証に使う LINE Login チャネルの Channel ID */
  LIFF_CHANNEL_ID: string;

  /** 未設定ならルールベースのみで動作する */
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;

  /** ローカル開発でLIFFを迂回するための逃げ道。本番では未設定にする。 */
  DEV_USER_ID?: string;
}

export interface HouseholdRow {
  id: string;
  line_source_type: 'group' | 'room' | 'user';
  line_source_id: string;
  display_name: string | null;
  shopping_dow: number | null;
  last_draft_on: string | null;
  /** 順路を観測した買い物回数 */
  route_trips: number;
  created_at: number;
  updated_at: number;
}

export interface CatalogRow {
  id: string;
  household_id: string;
  canonical_name: string;
  match_key: string;
  category: string;
  default_unit: string | null;
  default_quantity: number | null;
  purchase_count: number;
  last_purchased_at: number | null;
  mean_interval_days: number | null;
  interval_samples: number;
  /** 順路上の位置 (0=入口側, 1=レジ側) のEMA。同じ売り場の中での並びに使う。 */
  route_position: number | null;
  route_samples: number;
  /** 「その他」の品物について、消し込み位置から推定中の売り場 */
  inferred_category: string | null;
  inferred_votes: number;
  created_at: number;
  updated_at: number;
}

export interface ListRow {
  id: string;
  household_id: string;
  title: string | null;
  status: 'active' | 'done';
  created_by: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface ListItemRow {
  id: string;
  list_id: string;
  catalog_item_id: string | null;
  raw_text: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  category: string;
  checked: number;
  checked_at: number | null;
  checked_by: string | null;
  source: 'line' | 'liff' | 'suggestion';
  confidence: number;
  position: number;
  created_at: number;
  updated_at: number;
}

/** list_items に catalog_items の学習済み順路位置を結合したもの */
export interface ListItemWithRoute extends ListItemRow {
  /** 未学習なら null */
  route_position: number | null;
}
