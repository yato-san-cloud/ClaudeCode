-- 世帯 = Botが参加している1つのトークルーム (グループ / 複数人トーク / 1:1)
CREATE TABLE households (
  id                TEXT    PRIMARY KEY,
  line_source_type  TEXT    NOT NULL,          -- 'group' | 'room' | 'user'
  line_source_id    TEXT    NOT NULL UNIQUE,   -- groupId / roomId / userId
  display_name      TEXT,
  -- 学習した「いつもの買い物曜日」 (0=日 .. 6=土)。購入履歴から更新する。
  shopping_dow      INTEGER,
  -- Cron が同じ日に二重で下書きを作らないようにするための番兵 (JSTのYYYY-MM-DD)
  last_draft_on     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE members (
  id            TEXT    PRIMARY KEY,
  household_id  TEXT    NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  line_user_id  TEXT    NOT NULL,
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (household_id, line_user_id)
);
CREATE INDEX idx_members_line_user ON members(line_user_id);

-- 学習された商品マスタ。世帯ごとに育つ。
CREATE TABLE catalog_items (
  id                 TEXT    PRIMARY KEY,
  household_id       TEXT    NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  canonical_name     TEXT    NOT NULL,   -- 表示名 (例: 牛乳)
  match_key          TEXT    NOT NULL,   -- 照合用の正規化キー (例: ぎゅうにゅう)
  category           TEXT    NOT NULL,   -- 売り場キー (categories.ts と対応)
  default_unit       TEXT,
  default_quantity   REAL,
  purchase_count     INTEGER NOT NULL DEFAULT 0,
  last_purchased_at  INTEGER,
  -- 購入間隔(日)の指数移動平均。周期予測に使う。
  mean_interval_days REAL,
  interval_samples   INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (household_id, match_key)
);
CREATE INDEX idx_catalog_household ON catalog_items(household_id, purchase_count DESC);

-- 表記ゆれ学習 ("ぎゅーにゅー" -> 牛乳)
CREATE TABLE item_aliases (
  id               TEXT    PRIMARY KEY,
  household_id     TEXT    NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  alias_key        TEXT    NOT NULL,
  catalog_item_id  TEXT    NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  hits             INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  UNIQUE (household_id, alias_key)
);

-- 1回の買い物 = 1リスト
CREATE TABLE shopping_lists (
  id            TEXT    PRIMARY KEY,
  household_id  TEXT    NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title         TEXT,
  status        TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'done'
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX idx_lists_household_status ON shopping_lists(household_id, status, created_at DESC);

CREATE TABLE list_items (
  id               TEXT    PRIMARY KEY,
  list_id          TEXT    NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  catalog_item_id  TEXT    REFERENCES catalog_items(id) ON DELETE SET NULL,
  raw_text         TEXT,               -- 妻が実際に書いた文字列 (原文尊重)
  name             TEXT    NOT NULL,
  quantity         REAL,
  unit             TEXT,
  note             TEXT,               -- 「安いやつ」「特売なら」など
  category         TEXT    NOT NULL DEFAULT 'other',
  checked          INTEGER NOT NULL DEFAULT 0,
  checked_at       INTEGER,
  checked_by       TEXT,
  source           TEXT    NOT NULL DEFAULT 'line',  -- 'line' | 'liff' | 'suggestion'
  confidence       REAL    NOT NULL DEFAULT 1.0,
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_list_items_list ON list_items(list_id, position);

-- 買い物完了時のスナップショット。周期学習の元データ。
CREATE TABLE purchase_events (
  id               TEXT    PRIMARY KEY,
  household_id     TEXT    NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  catalog_item_id  TEXT    NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  list_id          TEXT,
  quantity         REAL,
  unit             TEXT,
  purchased_at     INTEGER NOT NULL,
  dow              INTEGER NOT NULL     -- JSTでの曜日 0=日 .. 6=土
);
CREATE INDEX idx_purchase_household_time ON purchase_events(household_id, purchased_at DESC);
CREATE INDEX idx_purchase_item ON purchase_events(catalog_item_id, purchased_at DESC);

-- LINE の webhook 再送に対する冪等性ガード
CREATE TABLE processed_events (
  event_id    TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
