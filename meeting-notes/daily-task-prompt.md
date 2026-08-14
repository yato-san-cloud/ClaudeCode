# 毎日の定期実行プロンプト(cron / Routine 用)

スケジュール: `53 21 * * *`(UTC)= 毎朝 6:53 JST。
セッション内cron(CronCreate)はセッション終了または7日で消えるため、新セッションではこのプロンプトで再作成する。恒久Routine(create_trigger)が使える環境なら同内容で作成してよい。

---

PLAUD議事録の毎日整理タスクです。Boxの「議事録」フォルダ(folder_id: 400559758901)の「_運用ルール.md」の手順に従って処理してください。要約: (1) PLAUD MCPのlist_filesで録音一覧を取得し、_processed.json(file_id: 2350978796466)にないIDだけを対象にする、(2) 各録音をget_noteで要約取得し「会議概要/要点サマリ/決定事項/アクションアイテム/議論の詳細/未解決事項」構成のMarkdownに整理、(3) 内容から顧客を推定して該当サブフォルダに保存(新顧客はフォルダ新規作成)、ファイル名YYYYMMDD_会議名.mdと同内容のスタイル付き同名.html、(4) index.html(file_id: 2350976207572)とindex.md(file_id: 2407409730832)を_processed.jsonのtitle/summaryから再生成してupload_file_versionで更新、(5) _processed.jsonに処理済みエントリ(plaud_id/meeting_date/customer/title/summary/md_file_id/html_file_id/processed_at)を追記。内容が実質ない録音はskipped:trueで記録のみ。PLAUD MCPやBoxのツールが見つからない・認証エラーの場合は処理せずユーザーに短く知らせる。新しい録音がなければ静かに終了する。
