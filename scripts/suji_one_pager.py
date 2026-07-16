#!/usr/bin/env python3
"""数字1枚HTMLジェネレータ(読み取り専用・レポートツール)。

`templates/根拠整理テンプレ.md` の形式(数字トレース表/ブリッジ表/
食い違い一覧/要確認)で書かれたmdを読み込み、「こことここを見たら
こうなる」印刷対応の1枚もの HTML(A4縦・インラインCSS)を生成する。

使い方:
    python3 suji_one_pager.py 根拠整理.md
    python3 suji_one_pager.py 根拠整理.md --title "深夜便増便コスト影響"
    python3 suji_one_pager.py 根拠整理.md --out 審議回答_数字1枚_260716.html

安全原則(このスクリプトが厳守する範囲):
- 読み取り専用。入力mdファイルには一切書き込まない
- 配布・送信はしない。生成したHTMLの配布前チェックは
  `templates/配布前チェックリスト.md` を人間が通してから
- 🔒私的メモ(人物評・交渉戦術)は入力に混ぜない前提。本ツールは
  与えられたテキストをそのまま転記するのみで、機密判定はしない
- 検算欄が「✅一致」以外(差異あり/〔未検証〕/空欄)の数字は、
  ✅と紛れない目立つ注意表示にする。未検算の数字を綺麗に見せて
  信用させることはしない
- 数字の正本は常にxlsx(運用ルールM-5)。本HTMLはあくまで「転記+可視化」
  であり、食い違えばxlsxが勝つ
- 標準ライブラリのみで動作。表が1つも見つからない場合も含め、
  例外で落ちずに常に終了コード0で終わる(レポートツール)
"""

import argparse
import html
import re
import sys
from datetime import date
from pathlib import Path

SEP_CELL_RE = re.compile(r"^:?-{2,}:?$")
META_LINE_RE = re.compile(r"^[-*]\s*(作成|対象|一次データ|検算方法)\s*[:：]\s*(.+)$")
TITLE_RE = re.compile(r"^#\s+(.+)$")


# ---------------------------------------------------------------------------
# Markdown パース(標準ライブラリのみ)
# ---------------------------------------------------------------------------

def split_all_sections(lines):
    """"## 見出し" 単位でセクション分割する。

    戻り値: [(見出しテキスト, 本文行リスト), ...]
    見出し番号("## 1. ..." のような接頭辞)の有無は問わない。
    """
    sections = []
    current_title = None
    buf = []
    for line in lines:
        if line.startswith("## "):
            if current_title is not None:
                sections.append((current_title, buf))
            current_title = line[3:].strip()
            buf = []
        else:
            if current_title is not None:
                buf.append(line)
    if current_title is not None:
        sections.append((current_title, buf))
    return sections


def pick_section(sections, *keywords):
    """見出しに keywords のいずれかを含む最初のセクションを返す。無ければ (None, [])。"""
    for title, buf in sections:
        if any(kw in title for kw in keywords):
            return title, buf
    return None, []


def parse_md_table(lines):
    """行リストの先頭から連続する `| ... |` 表を1つパースする。

    区切り行(|---|---|)はスキップ。表が見つからなければ (None, [])。
    """
    rows = []
    started = False
    for line in lines:
        s = line.strip()
        if s.startswith("|") and s.endswith("|") and s.count("|") >= 2:
            cells = [c.strip() for c in s.strip("|").split("|")]
            non_empty = [c for c in cells if c != ""]
            if non_empty and all(SEP_CELL_RE.match(c) for c in non_empty):
                started = True
                continue
            rows.append(cells)
            started = True
        elif started:
            # 表の後に表以外の行が来たら終了
            break
    if not rows:
        return None, []
    header = rows[0]
    data = rows[1:]
    return header, data


def find_col(header, *keywords):
    """ヘッダの中から keywords を含む列のインデックスを返す。無ければ None。"""
    if not header:
        return None
    for i, h in enumerate(header):
        if any(kw in h for kw in keywords):
            return i
    return None


def cell(row, idx):
    if idx is None or idx < 0 or idx >= len(row):
        return ""
    return row[idx]


def parse_meta(lines):
    meta = {"作成": "", "対象": "", "一次データ": "", "検算方法": ""}
    for line in lines:
        s = line.strip()
        if s.startswith("## "):
            break
        m = META_LINE_RE.match(s)
        if m:
            meta[m.group(1)] = m.group(2).strip()
    return meta


def parse_title(lines):
    for line in lines:
        m = TITLE_RE.match(line.strip())
        if m:
            return m.group(1).strip()
    return None


def bullet_items(lines):
    items = []
    for line in lines:
        s = line.strip()
        if s.startswith("- ") or s.startswith("* "):
            items.append(s[2:].strip())
    return items


def find_kensan_note(lines):
    """ブリッジ表の下によく書かれる「検算: ...」の行を拾う。"""
    for line in lines:
        s = line.strip()
        if s.startswith("検算") and ("：" in s or ":" in s):
            return s
    return None


def paragraph_text(lines):
    text_lines = [line.strip() for line in lines if line.strip()]
    return text_lines


# ---------------------------------------------------------------------------
# HTML生成
# ---------------------------------------------------------------------------

def e(text):
    return html.escape(text if text else "", quote=True)


def is_verified(check_text):
    return "✅" in (check_text or "")


def render_number_cards(header, rows):
    if not header or not rows:
        return "<p class=\"muted\">(数字トレース表が見つかりませんでした)</p>"

    id_idx = find_col(header, "ID")
    label_idx = find_col(header, "数字")
    value_idx = find_col(header, "値")
    source_idx = find_col(header, "出典")
    formula_idx = find_col(header, "計算式")
    check_idx = find_col(header, "検算")
    note_idx = find_col(header, "備考")

    cards = []
    for row in rows:
        rid = cell(row, id_idx)
        label = cell(row, label_idx)
        value = cell(row, value_idx)
        source = cell(row, source_idx)
        formula = cell(row, formula_idx)
        check_text = cell(row, check_idx)
        note = cell(row, note_idx)

        verified = is_verified(check_text)
        card_class = "card card-ok" if verified else "card card-warn"
        if verified:
            badge = '<span class="badge badge-ok">✅一致</span>'
        else:
            shown = check_text if check_text else "〔未検証〕"
            badge = f'<span class="badge badge-warn">⚠ {e(shown)}</span>'

        parts = [f'<div class="{card_class}">']
        parts.append('<div class="card-head">')
        if rid:
            parts.append(f'<span class="card-id">{e(rid)}</span>')
        parts.append(f'<span class="card-label">{e(label)}</span>')
        parts.append('</div>')
        parts.append(f'<div class="card-value">{e(value)}</div>')
        parts.append(f'<div class="card-badge">{badge}</div>')
        if source:
            parts.append(f'<div class="card-source">出典: {e(source)}</div>')
        if formula:
            parts.append(f'<div class="card-formula">計算式: {e(formula)}</div>')
        if note:
            parts.append(f'<div class="card-note">備考: {e(note)}</div>')
        parts.append('</div>')
        cards.append("\n".join(parts))

    return '<div class="card-grid">\n' + "\n".join(cards) + "\n</div>"


def render_generic_table(header, rows, highlight_col_keywords=None, ok_marks=("✅",), ng_marks=("❌",)):
    """汎用の表HTML化。highlight_col_keywords が指定されていれば、その列の値に
    応じて行に ok/ng の色を付ける(食い違い一覧の「一致?」列など)。"""
    if not header or not rows:
        return None

    highlight_idx = None
    if highlight_col_keywords:
        highlight_idx = find_col(header, *highlight_col_keywords)

    out = ['<table class="datatable">', "<thead><tr>"]
    for h in header:
        out.append(f"<th>{e(h)}</th>")
    out.append("</tr></thead><tbody>")
    for row in rows:
        row_class = ""
        if highlight_idx is not None:
            val = cell(row, highlight_idx)
            if any(m in val for m in ng_marks):
                row_class = ' class="row-ng"'
            elif any(m in val for m in ok_marks):
                row_class = ' class="row-ok"'
        out.append(f"<tr{row_class}>")
        for i in range(len(header)):
            out.append(f"<td>{e(cell(row, i))}</td>")
        out.append("</tr>")
    out.append("</tbody></table>")
    return "\n".join(out)


CSS = """
@page { size: A4 portrait; margin: 14mm; }
* { box-sizing: border-box; }
body {
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
  color: #1a1a1a;
  background: #ffffff;
  margin: 0;
  padding: 18px 22px 40px;
  line-height: 1.5;
  max-width: 900px;
}
h1, h2, h3 { margin: 0.4em 0 0.3em; }
header.doc-header {
  border-bottom: 3px solid #1a1a1a;
  padding-bottom: 10px;
  margin-bottom: 14px;
}
header.doc-header h1 { font-size: 22px; }
.meta-line {
  font-size: 12px;
  color: #444;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  margin-top: 4px;
}
.meta-line span b { color: #111; }
.conclusion {
  background: #eef4ff;
  border-left: 6px solid #2255aa;
  padding: 12px 16px;
  font-size: 18px;
  font-weight: bold;
  margin: 12px 0 18px;
}
.section-title {
  font-size: 15px;
  border-left: 5px solid #555;
  padding-left: 8px;
  margin-top: 22px;
}
.card-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.card {
  border: 1px solid #ccc;
  border-radius: 6px;
  padding: 8px 10px;
  width: 260px;
  background: #fafafa;
}
.card-ok { border-color: #2a8a3e; background: #f2fbf3; }
.card-warn { border-color: #b53a2c; background: #fff2f0; }
.card-head { font-size: 11px; color: #555; display: flex; gap: 6px; }
.card-id { font-weight: bold; color: #333; }
.card-value { font-size: 22px; font-weight: bold; margin: 4px 0 2px; }
.card-badge { margin-bottom: 4px; }
.card-source, .card-formula, .card-note {
  font-size: 10px;
  color: #666;
  word-break: break-all;
}
.badge {
  display: inline-block;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: bold;
}
.badge-ok { background: #2a8a3e; color: #fff; }
.badge-warn { background: #b53a2c; color: #fff; }
table.datatable {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
  margin-top: 8px;
}
table.datatable th, table.datatable td {
  border: 1px solid #999;
  padding: 5px 7px;
  text-align: left;
  vertical-align: top;
}
table.datatable th { background: #e8e8e8; }
tr.row-ok { background: #f2fbf3; }
tr.row-ng { background: #fff0ee; }
tr.row-ng td:first-child::before { content: "⚠ "; color: #b53a2c; font-weight: bold; }
.kensan-note { margin-top: 6px; font-size: 13px; }
.warn-box {
  border: 2px solid #b53a2c;
  background: #fff2f0;
  color: #7a1f14;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  margin-top: 8px;
}
ul.notes { font-size: 12px; padding-left: 20px; }
footer.doc-footer {
  margin-top: 26px;
  border-top: 1px solid #999;
  padding-top: 8px;
  font-size: 11px;
  color: #555;
}
.muted { color: #888; font-size: 12px; }
@media print {
  body { padding: 0; }
  .card { break-inside: avoid; }
  table.datatable { break-inside: avoid; }
}
@media (prefers-color-scheme: dark) {
  body { background: #1e1e1e; color: #eee; }
  header.doc-header { border-bottom-color: #eee; }
  .meta-line { color: #ccc; }
  .meta-line span b { color: #fff; }
  .conclusion { background: #223049; border-left-color: #4c86d6; color: #eef4ff; }
  .card { background: #2a2a2a; border-color: #555; color: #eee; }
  .card-ok { border-color: #3fae57; background: #16321c; }
  .card-warn { border-color: #d6584a; background: #35201d; }
  table.datatable th { background: #333; color: #eee; }
  table.datatable th, table.datatable td { border-color: #666; }
  tr.row-ok { background: #16321c; }
  tr.row-ng { background: #35201d; }
  .warn-box { background: #35201d; border-color: #d6584a; color: #ffd7d0; }
  footer.doc-footer { border-top-color: #666; color: #bbb; }
}
"""


def build_html(title, created, target, primary_data, conclusion_lines,
                num_header, num_rows,
                bridge_header, bridge_rows, kensan_note,
                mismatch_header, mismatch_rows,
                notes_items):
    parts = []
    parts.append("<!doctype html>")
    parts.append('<html lang="ja"><head><meta charset="utf-8">')
    parts.append(f"<title>{e(title)}</title>")
    parts.append(f"<style>{CSS}</style>")
    parts.append("</head><body>")

    # 1. ヘッダ
    parts.append('<header class="doc-header">')
    parts.append(f"<h1>{e(title)}</h1>")
    parts.append('<div class="meta-line">')
    parts.append(f"<span>作成: <b>{e(created)}</b></span>")
    if target:
        parts.append(f"<span>対象: <b>{e(target)}</b></span>")
    if primary_data:
        parts.append(f"<span>一次データ: <b>{e(primary_data)}</b></span>")
    parts.append("</div>")
    parts.append("</header>")

    # 2. 共通結論
    if conclusion_lines:
        parts.append('<div class="conclusion">' + "<br>".join(e(t) for t in conclusion_lines) + "</div>")
    else:
        parts.append('<p class="muted">(共通結論が見つかりませんでした)</p>')

    # 3. 数字カード
    parts.append('<h2 class="section-title">数字トレース</h2>')
    parts.append(render_number_cards(num_header, num_rows))

    # 4. ブリッジ表
    parts.append('<h2 class="section-title">ブリッジ表(変更前→変更後)</h2>')
    bridge_html = render_generic_table(bridge_header, bridge_rows)
    if bridge_html:
        parts.append(bridge_html)
        if kensan_note:
            if is_verified(kensan_note):
                parts.append(f'<div class="kensan-note"><span class="badge badge-ok">✅一致</span> {e(kensan_note)}</div>')
            else:
                parts.append(f'<div class="kensan-note"><span class="badge badge-warn">⚠ 要確認</span> {e(kensan_note)}</div>')
    else:
        parts.append('<p class="muted">(ブリッジ表は見つかりませんでした)</p>')

    # 5. 食い違い・要確認
    parts.append('<h2 class="section-title">食い違い・要確認</h2>')
    mismatch_html = render_generic_table(mismatch_header, mismatch_rows, highlight_col_keywords=("一致",))
    if mismatch_html:
        parts.append(mismatch_html)
    else:
        parts.append('<p class="muted">(食い違い一覧は見つかりませんでした、または該当なし)</p>')

    if notes_items:
        parts.append('<div class="warn-box"><b>要確認・未検証事項</b><ul class="notes">')
        for item in notes_items:
            parts.append(f"<li>{e(item)}</li>")
        parts.append("</ul></div>")

    # 6. フッタ
    parts.append('<footer class="doc-footer">')
    parts.append("全て出典セル付き / 数字の正本はxlsx(運用ルールM-5)。本HTMLは転記+可視化であり、食い違えばxlsxが勝つ。")
    parts.append("</footer>")

    parts.append("</body></html>")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="根拠整理md(templates/根拠整理テンプレ.md 形式)から数字1枚HTMLを生成する(読み取り専用)"
    )
    ap.add_argument("input", help="入力md(根拠整理.md)")
    ap.add_argument("--title", help="HTMLタイトル(省略時は入力mdの見出し/対象から推定)")
    ap.add_argument("--out", help="出力HTMLパス(省略時は入力ファイル名.htmlに保存)")
    args = ap.parse_args()

    in_path = Path(args.input)
    if not in_path.is_file():
        print(f"⚠ 警告: 入力ファイルが見つかりません: {in_path}")
        sys.exit(0)

    text = in_path.read_text(encoding="utf-8")
    lines = text.splitlines()

    meta = parse_meta(lines)
    doc_title = parse_title(lines)
    sections = split_all_sections(lines)

    _, conclusion_lines_raw = pick_section(sections, "共通結論")
    _, numbers_lines = pick_section(sections, "数字トレース", "トレース表")
    _, bridge_lines = pick_section(sections, "ブリッジ")
    _, mismatch_lines = pick_section(sections, "食い違い")
    _, notes_lines = pick_section(sections, "要確認", "未検証")

    num_header, num_rows = parse_md_table(numbers_lines)
    bridge_header, bridge_rows = parse_md_table(bridge_lines)
    mismatch_header, mismatch_rows = parse_md_table(mismatch_lines)

    # 表が1つも見つからない場合は警告して終了(終了コード0。落ちない)
    any_table = any([num_header, bridge_header, mismatch_header])
    if not any_table:
        # 念のため見出し構成に依存しない全文スキャンも試す
        fallback_header, _ = parse_md_table(lines)
        any_table = fallback_header is not None

    if not any_table:
        print("⚠ 警告: 表が1つも見つかりませんでした。数字1枚HTMLは生成しません。")
        print("  入力mdに `| ... |` 形式のMarkdown表(数字トレース表など)があるか確認してください。")
        sys.exit(0)

    conclusion_lines = paragraph_text(conclusion_lines_raw)
    kensan_note = find_kensan_note(bridge_lines)
    notes_items = bullet_items(notes_lines)

    title = args.title or doc_title or meta.get("対象") or in_path.stem
    created = meta.get("作成") or date.today().isoformat()
    target = meta.get("対象")
    primary_data = meta.get("一次データ")

    html_out = build_html(
        title=title,
        created=created,
        target=target,
        primary_data=primary_data,
        conclusion_lines=conclusion_lines,
        num_header=num_header, num_rows=num_rows,
        bridge_header=bridge_header, bridge_rows=bridge_rows, kensan_note=kensan_note,
        mismatch_header=mismatch_header, mismatch_rows=mismatch_rows,
        notes_items=notes_items,
    )

    out_path = Path(args.out) if args.out else in_path.with_suffix(".html")
    out_path.write_text(html_out, encoding="utf-8")

    print(f"✅ 生成しました: {out_path}")
    print(f"  数字カード: {len(num_rows)}件 / ブリッジ行: {len(bridge_rows)}件 / 食い違い行: {len(mismatch_rows)}件 / 要確認: {len(notes_items)}件")
    if any(not is_verified(cell(r, find_col(num_header, '検算'))) for r in num_rows) if num_header else False:
        print("  ⚠ 検算未了(✅一致以外)の数字が含まれています。HTML上で赤系の注意表示になっています。")
    print("  ※本ツールはHTML生成のみ。配布前チェック(templates/配布前チェックリスト.md)は人間が実施してください。")


if __name__ == "__main__":
    main()
