#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_schedule.py — タスク表(1表)からガント3形態+変更履歴を自動生成する。

使い方:
    python gen_schedule.py tasks.csv [--out 出力フォルダ] [--today YYYY-MM-DD]

入力(タスク表 CSV, UTF-8。xlsx も可・先頭シートを読む):
    ID,大項目,中項目,小項目,担当正,担当副,開始日,終了日,状態,マイルストーン,先行ID,進捗メモ,備考
    - 日付は YYYY-MM-DD または YYYY/MM/DD
    - 状態: 未着手 / 着手 / 完了
    - マイルストーン: 任意の値が入っていればマイルストーン扱い(終了日の週に◆)

出力(--out 配下):
    <名前>_ガント.xlsx      … 現行週報様式の週次ガント(□=予定 ■=実施 ☆=完了 ◆=マイルストーン)
    <名前>_ガント.html      … ブラウザで開くインタラクティブガント(担当フィルタ・今日線・自己完結)
    スケジュール_最新.md     … エージェント用ナレッジ(遅延・今週・直近マイルストーン)
    変更履歴.md             … 前回実行時とのdiffを自動追記(スナップショット .snapshot.json 比較)
"""
import argparse, csv, datetime as dt, html, json, pathlib, sys

STATES = ("未着手", "着手", "完了")


def parse_date(s):
    s = str(s).strip().split(" ")[0]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"日付を解釈できない: {s!r}")


def load_tasks(path):
    path = pathlib.Path(path)
    if path.suffix.lower() == ".xlsx":
        import openpyxl
        ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
        rows = [[c.value for c in row] for row in ws.iter_rows()]
        header = [str(v).strip() if v else "" for v in rows[0]]
        raw = [dict(zip(header, r)) for r in rows[1:] if any(v not in (None, "") for v in r)]
    else:
        with open(path, encoding="utf-8-sig") as f:
            raw = list(csv.DictReader(f))
    tasks, errors = [], []
    for i, r in enumerate(raw, start=2):
        g = lambda k: str(r.get(k) or "").strip()
        if not g("ID"):
            errors.append(f"{i}行目: ID が空"); continue
        try:
            t = {
                "id": g("ID"), "l1": g("大項目"), "l2": g("中項目"), "l3": g("小項目"),
                "own": g("担当正"), "sub": g("担当副"),
                "start": parse_date(g("開始日")), "end": parse_date(g("終了日")),
                "state": g("状態") or "未着手", "ms": bool(g("マイルストーン")),
                "dep": g("先行ID"), "note": g("進捗メモ"), "memo": g("備考"),
            }
        except ValueError as e:
            errors.append(f"{i}行目({g('ID')}): {e}"); continue
        if t["state"] not in STATES:
            errors.append(f"{i}行目({t['id']}): 状態は {'/'.join(STATES)} のみ(現在: {t['state']})"); continue
        if t["end"] < t["start"]:
            errors.append(f"{i}行目({t['id']}): 終了日が開始日より前"); continue
        tasks.append(t)
    if errors:
        sys.exit("入力エラー:\n  " + "\n  ".join(errors))
    return tasks


def monday(d):
    return d - dt.timedelta(days=d.weekday())


def week_axis(tasks):
    lo = monday(min(t["start"] for t in tasks))
    hi = monday(max(t["end"] for t in tasks))
    weeks = []
    w = lo
    while w <= hi:
        weeks.append(w)
        w += dt.timedelta(days=7)
    return weeks


# ---------- 出力1: Excel 週次ガント(現行様式) ----------
def write_xlsx(tasks, weeks, today, out, name):
    import openpyxl
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "ガント"
    thin = Border(*[Side(style="thin", color="BBBBBB")] * 4)
    head_fill = PatternFill("solid", fgColor="DDEBF7")
    month_fill = PatternFill("solid", fgColor="EEEEEE")
    today_fill = PatternFill("solid", fgColor="FFF2CC")
    cols = ["ID", "大項目", "中項目", "小項目", "担当正", "担当副", "開始", "終了", "状態", "進捗メモ"]
    ws.cell(1, 1, f"{name}  (生成: {today}  □=予定 ■=実施 ☆=完了 ◆=ﾏｲﾙｽﾄｰﾝ)").font = Font(bold=True)
    for j, h in enumerate(cols, 1):
        c = ws.cell(3, j, h); c.fill = head_fill; c.border = thin; c.font = Font(bold=True, size=9)
    base = len(cols)
    for k, w in enumerate(weeks):
        c1 = ws.cell(2, base + 1 + k)
        if k == 0 or w.month != weeks[k - 1].month:
            c1.value = f"{w.year}/{w.month}月"; c1.font = Font(bold=True, size=9); c1.fill = month_fill
        c2 = ws.cell(3, base + 1 + k, f"{w.month}/{w.day}")
        c2.font = Font(size=8); c2.fill = head_fill; c2.border = thin
        c2.alignment = Alignment(horizontal="center")
        ws.column_dimensions[c2.column_letter].width = 4.5
    for w in ("A", "B", "C", "D", "E", "F", "I"):
        ws.column_dimensions[w].width = {"A": 5, "B": 11, "C": 11, "D": 30, "E": 8, "F": 8, "I": 6}[w]
    ws.column_dimensions["G"].width = ws.column_dimensions["H"].width = 9
    ws.column_dimensions["J"].width = 24
    prev_l1 = prev_l2 = None
    for i, t in enumerate(tasks, start=4):
        vals = [t["id"], t["l1"] if t["l1"] != prev_l1 else "", t["l2"] if t["l2"] != prev_l2 else "",
                t["l3"], t["own"], t["sub"], t["start"].strftime("%m/%d"), t["end"].strftime("%m/%d"),
                t["state"], t["note"]]
        prev_l1, prev_l2 = t["l1"], t["l2"]
        for j, v in enumerate(vals, 1):
            c = ws.cell(i, j, v); c.border = thin; c.font = Font(size=9)
            c.alignment = Alignment(vertical="center", wrap_text=(j in (4, 10)))
        for k, w in enumerate(weeks):
            c = ws.cell(i, base + 1 + k); c.border = thin
            c.alignment = Alignment(horizontal="center"); c.font = Font(size=9)
            we = w + dt.timedelta(days=6)
            in_span = not (we < t["start"] or w > t["end"])
            mark = ""
            if in_span:
                if t["state"] == "完了":
                    mark = "■"
                elif t["state"] == "着手":
                    mark = "■" if we <= today else "□"
                else:
                    mark = "□"
            if t["ms"] and w <= t["end"] <= we:
                mark = "◆"
            elif t["state"] == "完了" and w <= t["end"] <= we:
                mark = "☆"
            c.value = mark
            if w <= today <= we:
                c.fill = today_fill
    ws.freeze_panes = ws.cell(4, base + 1)
    wb.save(out / f"{name}_ガント.xlsx")


# ---------- 出力2: HTML ガント(自己完結) ----------
def write_html(tasks, weeks, today, out, name):
    day0 = weeks[0]
    days = (weeks[-1] + dt.timedelta(days=7) - day0).days
    px = 4.2  # px/日
    W = int(days * px) + 340
    owners = sorted({t["own"] for t in tasks if t["own"]})
    rows_html, y = [], 0
    prev_l1 = None
    for t in tasks:
        if t["l1"] != prev_l1:
            rows_html.append(f'<div class="grp" style="top:{y}px">{html.escape(t["l1"])}</div>')
            y += 26; prev_l1 = t["l1"]
        x = (t["start"] - day0).days * px + 320
        wpx = max(((t["end"] - t["start"]).days + 1) * px, 6)
        cls = {"未着手": "todo", "着手": "doing", "完了": "done"}[t["state"]]
        late = t["state"] != "完了" and t["end"] < today
        label = html.escape(t["l3"] or t["l2"])
        tip = html.escape(f'{t["id"]} {t["l3"]} / {t["own"]}(副:{t["sub"] or "-"}) '
                          f'{t["start"]}〜{t["end"]} [{t["state"]}]'
                          + (f' 先行:{t["dep"]}' if t["dep"] else "") + (f' | {t["note"]}' if t["note"] else ""))
        bar = (f'<div class="ms" style="left:{x + wpx - 7:.0f}px;top:{y + 4}px" title="{tip}">◆</div>'
               if t["ms"] else
               f'<div class="bar {cls}{" late" if late else ""}" style="left:{x:.0f}px;top:{y + 5}px;width:{wpx:.0f}px" title="{tip}"></div>')
        rows_html.append(
            f'<div class="row" data-own="{html.escape(t["own"])}" style="top:{y}px">'
            f'<div class="nm" title="{tip}">{html.escape(t["id"])} {label}'
            f'<span class="ow">{html.escape(t["own"])}</span></div>{bar}</div>')
        y += 24
    H = y + 60
    grid = []
    for w in weeks:
        gx = (w - day0).days * px + 320
        lab = f"{w.month}/{w.day}" if w.day <= 7 or w == weeks[0] else ""
        grid.append(f'<div class="gl" style="left:{gx:.0f}px;height:{H}px"></div>')
        if w.day <= 7 or w == weeks[0]:
            grid.append(f'<div class="glab" style="left:{gx:.0f}px">{w.year}/{w.month}月</div>')
    tx = (today - day0).days * px + 320
    opts = "".join(f'<option>{html.escape(o)}</option>' for o in owners)
    doc = f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>{html.escape(name)} ガント</title><style>
body{{font-family:"Segoe UI","Yu Gothic UI",sans-serif;margin:12px;color:#1a1a1a}}
h1{{font-size:16px}} .legend span{{margin-right:14px;font-size:12px}}
#wrap{{position:relative;width:{W}px;height:{H}px;border:1px solid #ccc;overflow:hidden;background:#fff}}
.row{{position:absolute;left:0;width:100%;height:24px}}
.nm{{position:absolute;left:0;width:312px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:4px 4px 0 12px;background:#fff;z-index:2}}
.ow{{color:#888;margin-left:6px;font-size:10px}}
.grp{{position:absolute;left:0;width:100%;height:26px;background:#eef4fb;font-weight:bold;font-size:12px;padding:4px 0 0 4px;z-index:3}}
.bar{{position:absolute;height:12px;border-radius:3px;z-index:1}}
.bar.todo{{background:#c7d8ee}} .bar.doing{{background:#2f7bd0}} .bar.done{{background:#9fc99f}}
.bar.late{{outline:2px solid #d03020}}
.ms{{position:absolute;color:#d08000;font-size:13px;z-index:2}}
.gl{{position:absolute;top:0;width:1px;background:#eee}}
.glab{{position:absolute;top:2px;font-size:10px;color:#666}}
#today{{position:absolute;top:0;width:2px;background:#d03020;height:{H}px;z-index:4}}
select{{font-size:12px}}
</style></head><body>
<h1>{html.escape(name)} <small>(生成: {today})</small></h1>
<p class="legend"><span style="color:#c7d8ee">■</span>未着手 <span style="color:#2f7bd0">■</span>着手
<span style="color:#9fc99f">■</span>完了 <span style="color:#d03020">□</span>遅延(赤枠) <span style="color:#d08000">◆</span>ﾏｲﾙｽﾄｰﾝ
　担当フィルタ: <select id="f" onchange="flt()"><option>全員</option>{opts}</select></p>
<div id="wrap">{"".join(grid)}<div id="today" style="left:{tx:.0f}px"></div>{"".join(rows_html)}</div>
<script>
function flt(){{const v=document.getElementById('f').value;
document.querySelectorAll('.row').forEach(r=>{{r.style.opacity=(v==='全員'||r.dataset.own===v)?1:0.12;}});}}
</script></body></html>"""
    (out / f"{name}_ガント.html").write_text(doc, encoding="utf-8")


# ---------- 出力3: エージェント用 md ----------
def write_md(tasks, today, out, name):
    wk_s = monday(today); wk_e = wk_s + dt.timedelta(days=6)
    late = [t for t in tasks if t["state"] != "完了" and t["end"] < today]
    this_wk = [t for t in tasks if t["state"] != "完了" and not (t["end"] < wk_s or t["start"] > wk_e)]
    ms = [t for t in tasks if t["ms"] and today <= t["end"] <= today + dt.timedelta(days=30)]
    done = sum(1 for t in tasks if t["state"] == "完了")

    def line(t, with_days=False):
        d = f"(期限超過 {(today - t['end']).days}日)" if with_days else f"({t['start'].strftime('%m/%d')}〜{t['end'].strftime('%m/%d')})"
        return f"- {t['id']} {t['l3'] or t['l2']} / 担当: {t['own']} {d} 状態: {t['state']}" + (f" — {t['note']}" if t["note"] else "")

    md = [f"# {name} スケジュール(最新スナップショット)",
          f"生成: {today} / 出典: タスク表(このファイルは自動生成。直接編集しない)",
          f"進捗: 全{len(tasks)}件中 完了{done}件 / 遅延{len(late)}件", ""]
    md += ["## 遅延タスク(期限超過・未完了)"] + ([line(t, True) for t in late] or ["- なし"]) + [""]
    md += [f"## 今週のタスク({wk_s.strftime('%m/%d')}〜{wk_e.strftime('%m/%d')})"] + ([line(t) for t in this_wk] or ["- なし"]) + [""]
    md += ["## 直近30日のマイルストーン"] + ([f"- {t['end'].strftime('%m/%d')} ◆ {t['l3'] or t['l2']} ({t['id']})" for t in ms] or ["- なし"]) + [""]
    (out / "スケジュール_最新.md").write_text("\n".join(md), encoding="utf-8")


# ---------- 出力4: 変更履歴の自動追記 ----------
def write_changelog(tasks, today, out):
    snap_p = out / ".snapshot.json"
    log_p = out / "変更履歴.md"
    cur = {t["id"]: {"l3": t["l3"], "start": str(t["start"]), "end": str(t["end"]), "state": t["state"]} for t in tasks}
    if snap_p.exists():
        prev = json.loads(snap_p.read_text(encoding="utf-8"))
        lines = []
        for i in sorted(set(cur) - set(prev)):
            lines.append(f"- 追加: {i} {cur[i]['l3']} ({cur[i]['start']}〜{cur[i]['end']})")
        for i in sorted(set(prev) - set(cur)):
            lines.append(f"- 削除: {i} {prev[i]['l3']}")
        for i in sorted(set(cur) & set(prev)):
            a, b = prev[i], cur[i]
            if (a["start"], a["end"]) != (b["start"], b["end"]):
                lines.append(f"- 日程変更: {i} {b['l3']} {a['start']}〜{a['end']} → {b['start']}〜{b['end']}")
            if a["state"] != b["state"]:
                lines.append(f"- 状態変更: {i} {b['l3']} {a['state']} → {b['state']}")
        if lines:
            old = log_p.read_text(encoding="utf-8") if log_p.exists() else "# 変更履歴(自動生成)\n"
            log_p.write_text(old + f"\n## {today}\n" + "\n".join(lines) + "\n", encoding="utf-8")
            print(f"変更履歴: {len(lines)}件追記")
        else:
            print("変更履歴: 変更なし")
    else:
        log_p.write_text(f"# 変更履歴(自動生成)\n\n## {today}\n- 初回登録: {len(cur)}件\n", encoding="utf-8")
    snap_p.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks", help="タスク表(.csv/.xlsx)")
    ap.add_argument("--out", default=None, help="出力フォルダ(既定: タスク表と同じ場所)")
    ap.add_argument("--today", default=None, help="今日扱いにする日付(テスト用)")
    a = ap.parse_args()
    src = pathlib.Path(a.tasks)
    out = pathlib.Path(a.out) if a.out else src.parent
    out.mkdir(parents=True, exist_ok=True)
    today = parse_date(a.today) if a.today else dt.date.today()
    name = src.stem.replace("_tasks", "").replace("tasks_", "")
    tasks = load_tasks(src)
    weeks = week_axis(tasks)
    write_xlsx(tasks, weeks, today, out, name)
    write_html(tasks, weeks, today, out, name)
    write_md(tasks, today, out, name)
    write_changelog(tasks, today, out)
    print(f"OK: {len(tasks)}タスク → {out}/")


if __name__ == "__main__":
    main()
