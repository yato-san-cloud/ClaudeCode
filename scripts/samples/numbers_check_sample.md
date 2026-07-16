# 数字整合監査テスト用サンプル文書(md)

本ファイルは `scripts/numbers_check.py` の動作確認用。実案件の数字ではない。

## 一致するケース(同じ行)

月次コスト: <!-- num:dummy_monthly_cost_jpy -->1,234,567円

## 一致するケース(次の行に数値)

改定後の稼働率は以下の通り。
<!-- num:dummy_u_ratio_after -->
92.5%

## 不一致のケース(意図的にJSONとズレた値)

ラベル枚数/月: <!-- num:dummy_label_count_per_month -->300,000枚

## 全角数字・全角カンマのケース(NFKC正規化の確認)

契約金額: <!-- num:dummy_contract_amount_jpy -->９８，７６５，４３２円

## ▲(マイナス)表記のケース

経費削減額/月: <!-- num:dummy_cost_reduction_jpy -->▲45,000円

## JSONに存在しないキーを参照している例(タイプミスの想定)

投資回収年数: <!-- num:dummy_roi_year -->3.2年
