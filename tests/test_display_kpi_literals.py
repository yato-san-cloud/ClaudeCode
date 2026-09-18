"""受け入れ基準3の機械監査: 表示コードにハードコードされたKPI数値が無いこと。

画面に出る全KPIはイベントログ集計（`kpis.compute`）の出力であるべきで、表示側
（web/static の JS）に「912件/時」のような**数字つきKPI文字列リテラル**が存在
したら、それはログ由来ではない飾りの数字。ここではソースを走査し、数字＋KPI
単位が1つの文字列リテラル内に同居する行を違反として数える。

許容（KPIではないもの）:
- コメント行（`//` / `*` 始まり）— 例示のための文字列はコードに乗らない。
- `placeholder` 属性・「例）」の記入例 — ユーザー自身のメモ欄の書き方見本で、
  画面に KPI として出る値ではない。
- `%` 単独は監査対象にしない: 正当な用法が多すぎる（95%CI の統計表記、ABC 区分の
  定義「A=〜70%」、CSS の keyframes/transform）。代わりに **率系のKPIラベル
  （稼働率・完了率・ブロック率）に数字が続く**パターンだけを違反とする — それが
  「表示用ハードコードKPI」の実際の形。
"""
from __future__ import annotations

import re
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "src" / "whsim" / "web" / "static"

# 数字が直前に付いた KPI 単位が、引用符の内側に現れるパターン。
_KPI_UNIT = re.compile(
    r"""['"`][^'"`]*\d[\d,.]*\s*(件/時|件/h|人時|m/件|円/件|¥/件|行/h|km|坪)[^'"`]*['"`]"""
)
_RATE_LABEL = re.compile(r"(稼働率|完了率|ブロック率|充足率)\s*[:：]?\s*\d[\d.]*\s*%")
_COMMENT = re.compile(r"^\s*(//|\*|/\*)")


def _violations() -> list[str]:
    out: list[str] = []
    for path in sorted(STATIC.rglob("*.js")):
        if "vendor" in path.parts:
            continue  # three.js / echarts は表示部品であって表示コードではない
        for i, line in enumerate(path.read_text("utf-8").splitlines(), 1):
            if _COMMENT.match(line):
                continue
            if "placeholder" in line or "例）" in line:
                continue
            if _KPI_UNIT.search(line) or _RATE_LABEL.search(line):
                out.append(f"{path.relative_to(STATIC)}:{i}: {line.strip()[:100]}")
    return out


def test_no_hardcoded_kpi_numbers_in_display_code():
    vio = _violations()
    assert vio == [], "表示コードに数値リテラルのKPIらしき文字列:\n" + "\n".join(vio)


def test_the_audit_itself_catches_a_planted_literal(tmp_path, monkeypatch):
    """監査が空振りしていないことの対照実験: 仕込んだ違反を必ず検出する。"""
    fake = tmp_path / "static"
    (fake / "js").mkdir(parents=True)
    (fake / "js" / "bad.js").write_text(
        "el.textContent = '912件/時';\n", "utf-8")
    import tests.test_display_kpi_literals as mod
    monkeypatch.setattr(mod, "STATIC", fake)
    assert len(mod._violations()) == 1
