-- 消し込み順から「この店の順路」を学習するための追加。
--
-- 発想: 妻は思いつき順に書き、夫は売り場順に消し込む。後者はその店を歩いた
-- 順路そのものなので、チェックの時刻順を観測すれば売り場の並びが推定できる。

-- 順路を何回ぶん観測したか。UIの「学習中/学習済み」表示に使う。
ALTER TABLE households ADD COLUMN route_trips INTEGER NOT NULL DEFAULT 0;

-- 売り場どうしの前後関係の観測数。
-- 「精肉のあとに乳製品を通った」を1回として数え、全ペアで積み上げる。
-- 隣接だけでなく全順序ペアを数えるので、売り場が飛び飛びの買い物でも
-- 証拠として効く。
CREATE TABLE category_route_stats (
  household_id  TEXT    NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  before_key    TEXT    NOT NULL,
  after_key     TEXT    NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (household_id, before_key, after_key)
);

-- 品物ごとの順路上の位置 (0=入口側, 1=レジ側) の指数移動平均。
-- 同じ売り場の中での並び替えに使う。
ALTER TABLE catalog_items ADD COLUMN route_position REAL;
ALTER TABLE catalog_items ADD COLUMN route_samples INTEGER NOT NULL DEFAULT 0;

-- 「その他」に落ちた品物の売り場推定。前後に消し込んだ品物の売り場から
-- 多数決で決める。inferred_votes が閾値に達したら category に昇格させる。
ALTER TABLE catalog_items ADD COLUMN inferred_category TEXT;
ALTER TABLE catalog_items ADD COLUMN inferred_votes INTEGER NOT NULL DEFAULT 0;

-- 後から順路を再計算できるよう、購入時の正規化位置も残しておく。
ALTER TABLE purchase_events ADD COLUMN route_position REAL;
