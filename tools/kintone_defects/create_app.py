#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""create_app.py — kintone「不具合連絡票」アプリを API で作成する。

アプリ作成系 API は API トークン不可・パスワード認証が必要。
    set KINTONE_DOMAIN=example.cybozu.com
    set KINTONE_USER=ログイン名
    set KINTONE_PASS=パスワード
    python create_app.py [--space スペースID] [--dry-run]

--dry-run で送信ペイロードの確認だけ行う(通信なし)。
作成後に表示される appId を defects_upload.py の KINTONE_APP_ID に使う。
"""
import argparse, base64, json, os, sys, urllib.request

FIELDS = {
    "発生日":   {"type": "DATE", "code": "発生日", "label": "発生日", "required": True},
    "発生場所": {"type": "RADIO_BUTTON", "code": "発生場所", "label": "発生場所",
                 "options": {"ネオウイング": {"label": "ネオウイング", "index": "0"},
                             "ネオロジ": {"label": "ネオロジ", "index": "1"}},
                 "defaultValue": "ネオウイング"},
    "区分":     {"type": "RADIO_BUTTON", "code": "区分", "label": "区分",
                 "options": {"入荷": {"label": "入荷", "index": "0"},
                             "出荷": {"label": "出荷", "index": "1"}},
                 "defaultValue": "出荷"},
    "場所":     {"type": "RADIO_BUTTON", "code": "場所", "label": "場所",
                 "options": {"T-sort": {"label": "T-sort", "index": "0"},
                             "HT検収": {"label": "HT検収", "index": "1"},
                             "9マルチ": {"label": "9マルチ", "index": "2"}},
                 "defaultValue": "T-sort"},
    "作業者":   {"type": "SINGLE_LINE_TEXT", "code": "作業者", "label": "作業者"},
    "作業名":   {"type": "DROP_DOWN", "code": "作業名", "label": "作業名",
                 "options": {k: {"label": k, "index": str(i)} for i, k in enumerate(
                     ["入荷検収", "格納", "ピック", "検品", "T-sort入荷", "T-sort出荷"])}},
    "事象":     {"type": "CHECK_BOX", "code": "事象", "label": "事象",
                 "options": {k: {"label": k, "index": str(i)} for i, k in enumerate(
                     ["過剰入庫", "過少入庫", "入庫漏れ", "格納漏れ",
                      "過剰ピック", "過少ピック", "誤ピック", "棚移動ミス",
                      "特典JAN貼りミス", "作業完了エラー", "破損"])}},
    "発見破損": {"type": "CHECK_BOX", "code": "発見破損", "label": "発見・破損",
                 "options": {"発見": {"label": "発見", "index": "0"},
                             "破損": {"label": "破損", "index": "1"}}},
    "詳細":     {"type": "MULTI_LINE_TEXT", "code": "詳細", "label": "詳細"},
    "伝票番号": {"type": "SINGLE_LINE_TEXT", "code": "伝票番号", "label": "伝票番号"},
    "注文番号": {"type": "SINGLE_LINE_TEXT", "code": "注文番号", "label": "注文番号"},
    "ロケーション": {"type": "SINGLE_LINE_TEXT", "code": "ロケーション", "label": "ロケーション"},
    "JAN":      {"type": "SINGLE_LINE_TEXT", "code": "JAN", "label": "JANコード"},
    "品目名":   {"type": "SINGLE_LINE_TEXT", "code": "品目名", "label": "品目名"},
    "数量":     {"type": "NUMBER", "code": "数量", "label": "数量"},
    "責任":     {"type": "RADIO_BUTTON", "code": "責任", "label": "本事象の責任",
                 "options": {"ロジスティード中部": {"label": "ロジスティード中部", "index": "0"},
                             "NW様": {"label": "NW様", "index": "1"}},
                 "defaultValue": "ロジスティード中部"},
    "状態":     {"type": "DROP_DOWN", "code": "状態", "label": "状態",
                 "options": {"発行済み": {"label": "発行済み", "index": "0"},
                             "転記済み": {"label": "転記済み", "index": "1"},
                             "確認済み": {"label": "確認済み", "index": "2"}},
                 "defaultValue": "発行済み", "required": True},
    "原票画像": {"type": "FILE", "code": "原票画像", "label": "原票画像"},
}

LAYOUT = [
    {"type": "ROW", "fields": [{"type": "DATE", "code": "発生日", "size": {"width": "160"}},
                               {"type": "DROP_DOWN", "code": "状態", "size": {"width": "160"}}]},
    {"type": "ROW", "fields": [{"type": "RADIO_BUTTON", "code": "発生場所"},
                               {"type": "RADIO_BUTTON", "code": "区分"},
                               {"type": "RADIO_BUTTON", "code": "場所"}]},
    {"type": "ROW", "fields": [{"type": "SINGLE_LINE_TEXT", "code": "作業者", "size": {"width": "200"}},
                               {"type": "DROP_DOWN", "code": "作業名", "size": {"width": "200"}}]},
    {"type": "ROW", "fields": [{"type": "CHECK_BOX", "code": "事象"}]},
    {"type": "ROW", "fields": [{"type": "CHECK_BOX", "code": "発見破損"}]},
    {"type": "ROW", "fields": [{"type": "MULTI_LINE_TEXT", "code": "詳細", "size": {"width": "500"}}]},
    {"type": "ROW", "fields": [{"type": "SINGLE_LINE_TEXT", "code": "伝票番号", "size": {"width": "160"}},
                               {"type": "SINGLE_LINE_TEXT", "code": "注文番号", "size": {"width": "160"}},
                               {"type": "SINGLE_LINE_TEXT", "code": "ロケーション", "size": {"width": "160"}}]},
    {"type": "ROW", "fields": [{"type": "SINGLE_LINE_TEXT", "code": "JAN", "size": {"width": "200"}},
                               {"type": "SINGLE_LINE_TEXT", "code": "品目名", "size": {"width": "260"}},
                               {"type": "NUMBER", "code": "数量", "size": {"width": "100"}}]},
    {"type": "ROW", "fields": [{"type": "RADIO_BUTTON", "code": "責任"}]},
    {"type": "ROW", "fields": [{"type": "FILE", "code": "原票画像"}]},
]


def req(domain, auth, method, path, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(
        f"https://{domain}{path}", data=body, method=method,
        headers={"X-Cybozu-Authorization": auth, "Content-Type": "application/json"})
    with urllib.request.urlopen(r) as res:
        return json.loads(res.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--space", default=None, help="スペース内に作る場合のスペースID")
    ap.add_argument("--name", default="不具合連絡票(ネオウィング)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.dry_run:
        print(json.dumps({"name": a.name, "fields": FIELDS, "layout": LAYOUT},
                         ensure_ascii=False, indent=1)[:2000] + "\n...(省略)")
        print(f"\nフィールド{len(FIELDS)}個・レイアウト{len(LAYOUT)}行。--dry-run のため未送信")
        return
    domain = os.environ.get("KINTONE_DOMAIN")
    user, pw = os.environ.get("KINTONE_USER"), os.environ.get("KINTONE_PASS")
    if not (domain and user and pw):
        sys.exit("環境変数 KINTONE_DOMAIN / KINTONE_USER / KINTONE_PASS を設定すること")
    auth = base64.b64encode(f"{user}:{pw}".encode()).decode()
    payload = {"name": a.name}
    if a.space:
        payload["space"] = int(a.space)
        payload["thread"] = int(a.space)
    app = req(domain, auth, "POST", "/k/v1/preview/app.json", payload)
    app_id = app["app"]
    print(f"アプリ作成(未運用): appId={app_id}")
    req(domain, auth, "POST", "/k/v1/preview/app/form/fields.json",
        {"app": app_id, "properties": FIELDS})
    req(domain, auth, "PUT", "/k/v1/preview/app/form/layout.json",
        {"app": app_id, "layout": LAYOUT})
    req(domain, auth, "POST", "/k/v1/preview/app/deploy.json", {"apps": [{"app": app_id}]})
    print(f"運用環境へ反映(デプロイ)を開始した。数十秒後にアプリ一覧に出る。appId={app_id}")
    print("次: アプリ設定→API トークン(レコード閲覧・追加・編集)を発行し、defects_upload.py に使う")


if __name__ == "__main__":
    main()
