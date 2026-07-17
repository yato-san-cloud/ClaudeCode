#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""defects_upload.py — CPA-004(不具合票転記)の出力を検証して kintone に反映する。

使い方:
    set KINTONE_DOMAIN=example.cybozu.com
    set KINTONE_APP_ID=123
    set KINTONE_API_TOKEN=(レコード閲覧・追加・編集権限のトークン)
    python defects_upload.py 転記出力.txt [--dry-run]
    python defects_upload.py --report            # 漏れ検知レポートのみ

入力: CPA-004 がチャットに出力した「1票=15行」形式をそのまま貼ったテキスト。
処理:
  1) 機械検証 — JAN チェックデジット(EAN-13) / 選択肢が enum 内 / 日付 / 伝票番号形式 /
     【要確認】の残存。NG は kintone に送らず差し戻し一覧に出す
  2) 票No あり → 該当レコードを更新(状態=転記済み)。票No「なし」→ 新規レコード作成
  3) --report — 状態=発行済みのまま残っているレコード一覧 = 転記漏れ疑い
"""
import argparse, datetime as dt, json, os, re, sys, urllib.parse, urllib.request

ENUM = {
    "発生場所": {"ネオウイング", "ネオロジ"},
    "区分": {"入荷", "出荷"},
    "場所": {"T-sort", "HT検収", "9マルチ"},
    "作業名": {"入荷検収", "格納", "ピック", "検品", "T-sort入荷", "T-sort出荷"},
    "事象": {"過剰入庫", "過少入庫", "入庫漏れ", "格納漏れ", "過剰ピック", "過少ピック",
             "誤ピック", "棚移動ミス", "特典JAN貼りミス", "作業完了エラー", "破損"},
    "発見・破損": {"発見", "破損", "なし"},
    "責任": {"ロジスティード中部", "NW様"},
}
LABELS = ["票No", "発生日", "発生場所", "区分", "場所", "作業者", "作業名", "事象",
          "発見・破損", "詳細", "伝票番号", "注文番号", "JAN", "品目名/数量", "責任"]

# MECE化の変換表(docs/不具合分類_MECE化案.md §3)。現行の事象 → (発生工程, 事象タイプ)
EVENT_MAP = {
    "過剰入庫": ("入荷検収", "数量過剰"), "過少入庫": ("入荷検収", "数量不足"),
    "入庫漏れ": ("入荷検収", "作業漏れ"), "格納漏れ": ("格納", "作業漏れ"),
    "過剰ピック": ("ピック", "数量過剰"), "過少ピック": ("ピック", "数量不足"),
    "誤ピック": ("ピック", "品目相違"), "棚移動ミス": ("保管・棚移動", "位置相違"),
    "特典JAN貼りミス": ("流通加工", "表示・ラベル不良"),
    "作業完了エラー": (None, "システム・データ不整合"),  # 発生工程=発見工程(作業名)を充てる
    "破損": ("不明", "破損"),
}
# 現行様式の作業名 → 発見工程(記入者が実際に作業していた工程)
FOUND_MAP = {"入荷検収": "入荷検収", "格納": "格納", "ピック": "ピック",
             "検品": "検品", "T-sort入荷": "T-sort入荷", "T-sort出荷": "T-sort出荷"}


def derive_axes(events, task_name):
    """チェックされた事象と作業名から (発生工程, 事象タイプ[], 発見工程) を導出する。"""
    found = FOUND_MAP.get(task_name, "不明")
    types, procs = [], []
    for ev in events:
        proc, typ = EVENT_MAP.get(ev, ("不明", "その他"))
        if proc is None:  # 作業完了エラー: 発生=発見工程
            proc = found
        types.append(typ)
        procs.append(proc)
    occur = next((p for p in procs if p != "不明"), "不明")
    return occur, list(dict.fromkeys(types)), found


def jan_ok(jan):
    if not re.fullmatch(r"\d{13}", jan):
        return False
    digits = [int(c) for c in jan]
    check = (10 - (sum(digits[0:12:2]) + 3 * sum(digits[1:12:2])) % 10) % 10
    return check == digits[12]


def parse_sets(text):
    """15行セット×n を辞書のリストにする。ラベル行以外(前後の説明文)は無視。"""
    sets, cur = [], {}
    for line in text.splitlines():
        m = re.match(r"\s*(" + "|".join(map(re.escape, LABELS)) + r")\s*[:：]\s*(.*)", line)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if k == "票No" and cur:
            sets.append(cur); cur = {}
        cur[k] = v
    if cur:
        sets.append(cur)
    return sets


def validate(s, idx):
    errs = []
    joined = " ".join(s.values())
    if "【要確認" in joined:
        errs.append("【要確認】が残っている(原票と照合して確定させる)")
    for k in ("発生場所", "区分", "場所", "作業名", "責任"):
        if s.get(k) and s[k] not in ENUM[k]:
            errs.append(f"{k}「{s[k]}」が選択肢にない")
    for v in [x.strip() for x in s.get("事象", "").replace("、", ",").split(",") if x.strip()]:
        if v not in ENUM["事象"]:
            errs.append(f"事象「{v}」が選択肢にない")
    try:
        dt.datetime.strptime(s.get("発生日", ""), "%Y-%m-%d")
    except ValueError:
        errs.append(f"発生日「{s.get('発生日','')}」が YYYY-MM-DD でない")
    jan = s.get("JAN", "")
    if jan and jan != "なし" and not jan_ok(jan):
        errs.append(f"JAN「{jan}」がチェックデジット不一致(読み誤りの可能性大。原票を再確認)")
    v = s.get("伝票番号", "")
    if v not in ("", "なし") and not re.fullmatch(r"T\d{6}", v):
        errs.append(f"伝票番号「{v}」が T+6桁 でない")
    if s.get("票No", "なし") not in ("なし", "") and not s["票No"].isdigit():
        errs.append(f"票No「{s['票No']}」が数字でない")
    return errs


def to_record(s):
    item, qty = s.get("品目名/数量", ""), ""
    if "/" in item:
        item, qty = [x.strip() for x in item.rsplit("/", 1)]
    qty = re.sub(r"[^0-9.]", "", qty)
    events = [x.strip() for x in s.get("事象", "").replace("、", ",").split(",") if x.strip()]
    occur, types, found = derive_axes(events, s.get("作業名", ""))
    rec = {
        "発生工程": {"value": occur},
        "発見工程": {"value": found},
        "事象タイプ": {"value": types},
        "発生日": {"value": s["発生日"]},
        "発生場所": {"value": s["発生場所"]},
        "区分": {"value": s["区分"]},
        "場所": {"value": s["場所"]},
        "作業者": {"value": s.get("作業者", "")},
        "作業名": {"value": s.get("作業名", "")},
        "事象": {"value": [x.strip() for x in s.get("事象", "").replace("、", ",").split(",") if x.strip()]},
        "発見破損": {"value": [] if s.get("発見・破損", "なし") == "なし"
                    else [x.strip() for x in s["発見・破損"].replace("、", ",").split(",")]},
        "詳細": {"value": s.get("詳細", "")},
        "伝票番号": {"value": "" if s.get("伝票番号") == "なし" else s.get("伝票番号", "")},
        "注文番号": {"value": "" if s.get("注文番号") == "なし" else s.get("注文番号", "")},
        "JAN": {"value": "" if s.get("JAN") == "なし" else s.get("JAN", "")},
        "品目名": {"value": "" if item == "(記載なし)" else item},
        "責任": {"value": s["責任"]},
        "起票元": {"value": "現場連絡票"},
        "状態": {"value": "転記済み"},
    }
    if qty:
        rec["数量"] = {"value": qty}
    return rec


def api(method, path, payload=None, query=None):
    domain = os.environ["KINTONE_DOMAIN"]
    url = f"https://{domain}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    body = json.dumps(payload, ensure_ascii=False).encode() if payload else None
    r = urllib.request.Request(url, data=body, method=method, headers={
        "X-Cybozu-API-Token": os.environ["KINTONE_API_TOKEN"],
        **({"Content-Type": "application/json"} if body else {})})
    with urllib.request.urlopen(r) as res:
        return json.loads(res.read())


def report(app):
    q = f'状態 in ("発行済み") order by $id asc limit 500'
    rs = api("GET", "/k/v1/records.json", query={"app": app, "query": q})["records"]
    print(f"\n== 転記漏れ疑い(発行済みのまま {len(rs)} 件) ==")
    for r in rs:
        print(f"  票No {r['$id']['value']} / 発行 {r.get('作成日時',{}).get('value','')[:10]}")
    if not rs:
        print("  なし(全票が転記済み)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?", help="CPA-004 の出力を貼ったテキストファイル")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", action="store_true", help="漏れ検知レポートのみ")
    a = ap.parse_args()
    app = os.environ.get("KINTONE_APP_ID")
    if a.report:
        report(app); return
    if not a.src:
        sys.exit("入力ファイルを指定するか --report を使う")
    sets = parse_sets(open(a.src, encoding="utf-8-sig").read())
    if not sets:
        sys.exit("15行セットが見つからない(ラベル行ごと貼ること)")
    ok, ng = [], []
    for i, s in enumerate(sets, 1):
        errs = validate(s, i)
        (ng if errs else ok).append((i, s, errs))
    print(f"読み取り: {len(sets)}票 / 検証OK {len(ok)} / 差し戻し {len(ng)}")
    for i, s, errs in ng:
        print(f"\n▼ {i}票目(票No {s.get('票No','?')}) は送信しない:")
        for e in errs:
            print(f"  - {e}")
    if a.dry_run:
        for i, s, _ in ok:
            print(f"\n--- {i}票目 → " + ("更新(票No " + s["票No"] + ")" if s.get("票No", "なし") != "なし" else "新規"))
            print(json.dumps(to_record(s), ensure_ascii=False, indent=1))
        print("\n--dry-run のため未送信")
        return
    for i, s, _ in ok:
        rec = to_record(s)
        if s.get("票No", "なし") != "なし":
            api("PUT", "/k/v1/record.json", {"app": app, "id": int(s["票No"]), "record": rec})
            print(f"{i}票目: 票No {s['票No']} を更新(転記済み)")
        else:
            r = api("POST", "/k/v1/record.json", {"app": app, "record": rec})
            print(f"{i}票目: 新規登録 → レコード番号 {r['id']}(票No なし。原票に追記すること)")
    report(app)


if __name__ == "__main__":
    main()
