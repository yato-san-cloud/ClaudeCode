-- 買い物をタイムアタックにするための記録。
--
-- created_at は「リストを作った時刻」で、買い物の何日も前のことがある。
-- 計測の起点は「最初の1件を消し込んだ瞬間」= 店に着いて動き出した時刻にする。

-- 最初のチェックが入った時刻。ここからストップウォッチが回る。
ALTER TABLE shopping_lists ADD COLUMN started_at INTEGER;

-- 完了時に確定する記録。自己ベストの照会を1クエリで済ませるため非正規化する。
ALTER TABLE shopping_lists ADD COLUMN duration_ms INTEGER;
ALTER TABLE shopping_lists ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;

-- 自己ベスト・前回記録の取得用
CREATE INDEX idx_lists_records
  ON shopping_lists(household_id, status, completed_at DESC);
