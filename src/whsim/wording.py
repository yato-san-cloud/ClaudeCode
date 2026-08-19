"""提案書の用語ガード (proposal wording guard).

顧客ごとに「使ってよい言葉・使ってはいけない言葉」がある。ある案件では工程名の
言い換えが禁じられ、別の案件では効果を断定する語（削減/目標/ROI…）が禁じられる。
生成した提案書テキストにそれが混じるのは**事故**なので、出す前に機械的に検査して
言い換えを提案する層をここに置く。

規約:

* ルール未設定（``settings.wording == {}``）なら**検査そのものが無効**。既存の
  出力は1バイトも変わらない（additive; "never blocks"）。
* ルールは4つのキーだけを見る::

      {"forbidden": ["…"],          # 禁止語（部分一致）
       "forbidden_regex": "…",      # 追加の正規表現（1本）
       "replacements": {"NG": "OK"},# 言い換え辞書（キーも禁止語として検出する）
       "allow": ["…"]}              # 例外（禁止語を含んでいても通す語句）

  外部のトーンガイド JSON もこの形で読む（``load_rules``）。**未知キーは無視**する
  ので、顧客が独自メタ情報を足したガイドでもそのまま食える。
* 照合は NFKC 畳み込み＋大文字小文字無視（全角ＲＯＩ＝ROI）。**位置は元テキストの
  文字オフセット**で返すので、UI がそのまま反転表示できる。

なぜ ``allow`` が禁止語より強いのか（この層の肝）:
    物理オブジェクトの**正式名称**が禁止語を部分文字列で含むことがある。例えば
    「停止」が禁止語でも「停止線」は床に引かれた線の名前であって、書き換えたら
    設備の話が通じなくなる。禁止語は*言い回し*の規制、``allow`` は*固有名詞*の
    保護で、後者が先に地面を押さえる。だから検査は「まず allow の占める区間を
    確定し、その区間に重なる禁止語ヒットは初めから作らない」順序で行う。
    ``apply`` も同じ区間を触らない。
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

__all__ = [
    "apply",
    "check",
    "enabled",
    "lint_export",
    "load_rules",
    "normalise_rules",
    "proposal_payload",
    "rules_for",
]

# Dict keys whose values are identifiers / paths / colours — never prose a client
# reads. Linting them only invents false positives (a project slug that happens to
# contain a banned word is not a wording problem). Matched case-insensitively as a
# whole key or as a trailing ``_<key>`` segment; extendable via rules["skip_keys"].
_SKIP_KEYS: tuple[str, ...] = (
    "path", "id", "url", "icon", "color", "colour", "sku", "png", "file",
    "severity", "logo_path",
)

# Recursion / result-size guards for lint_export: a proposal payload is assembled
# from run artifacts, so it is shallow in practice — these only stop pathological
# input from turning a check into a hang or a wall of hits.
_MAX_DEPTH = 12
_MAX_HITS = 1000


# --- rule loading -------------------------------------------------------------

def normalise_rules(raw: Any) -> dict:
    """Any tone-guide-shaped object → the canonical rules dict (tolerant).

    Unknown keys are ignored, wrong types are coerced or dropped, and empty
    sections are omitted so ``enabled()`` is a simple truth test. Never raises.
    """
    if not isinstance(raw, dict):
        return {}
    out: dict = {}

    forbidden = _str_list(raw.get("forbidden"))
    if forbidden:
        out["forbidden"] = forbidden

    rx = raw.get("forbidden_regex")
    if isinstance(rx, (list, tuple)):           # tolerant: several patterns → one
        rx = "|".join(str(p) for p in rx if str(p).strip())
    if isinstance(rx, str) and rx.strip():
        out["forbidden_regex"] = rx.strip()

    repl = raw.get("replacements")
    if isinstance(repl, dict):
        pairs = {}
        for k, v in repl.items():
            key = str(k).strip()
            if key:
                pairs[key] = "" if v is None else str(v)
        if pairs:
            out["replacements"] = pairs

    allow = _str_list(raw.get("allow"))
    if allow:
        out["allow"] = allow

    skip = _str_list(raw.get("skip_keys"))
    if skip:
        out["skip_keys"] = [s.lower() for s in skip]
    return out


def _str_list(v: Any) -> list[str]:
    """Tolerant str|list → de-duplicated list of non-empty strings (order kept)."""
    if v is None:
        return []
    items = [v] if isinstance(v, str) else (v if isinstance(v, (list, tuple, set)) else [])
    out: list[str] = []
    seen: set[str] = set()
    for it in items:
        s = ("" if it is None else str(it)).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def load_rules(path_or_dict: Any) -> dict:
    """外部トーンガイド（JSON ファイル / bytes / dict）→ ルール。未知キーは無視。

    ``ValueError`` はファイルが読めない・JSON として壊れている場合のみ（呼び出し
    側がフレンドリーな 400 に変換できるように）。内容の不備は全て寛容に扱う。
    """
    if isinstance(path_or_dict, dict):
        return normalise_rules(path_or_dict)
    data: Any
    if isinstance(path_or_dict, (bytes, bytearray)):
        try:
            data = json.loads(bytes(path_or_dict).decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"用語ルールの JSON を解析できませんでした: {e}") from e
        return normalise_rules(data)
    p = Path(str(path_or_dict))
    try:
        text = p.read_text("utf-8-sig")
    except OSError as e:
        raise ValueError(f"用語ルールを読み込めませんでした: {p} ({e})") from e
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"用語ルールの JSON を解析できませんでした: {p} ({e})") from e
    return normalise_rules(data)


def rules_for(model: Any) -> dict:
    """モデルの ``settings.wording`` からルールを解決（未設定なら ``{}``）。"""
    try:
        raw = getattr(getattr(model, "settings", None), "wording", None)
    except Exception:  # noqa: BLE001 — a foreign model must not break the guard
        raw = None
    if raw is None and isinstance(model, dict):
        raw = (model.get("settings") or {}).get("wording")
    return normalise_rules(raw)


def enabled(rules: dict | None) -> bool:
    """Does this rule set detect anything at all? (``allow`` alone does not.)"""
    r = rules or {}
    return bool(r.get("forbidden") or r.get("forbidden_regex") or r.get("replacements"))


# --- folding (match loosely, report exact offsets) ----------------------------

def _fold_with_map(s: str) -> tuple[str, list[int]]:
    """Fold per character (NFKC + casefold) and keep an index back to the source.

    Whole-string NFKC would change the length (半角カナ+濁点 → 1文字) and destroy
    the offsets we must report, so folding stays per character: 全角英数/全角空白/
    大文字小文字の揺れは吸収しつつ、``span`` は元テキストのまま返せる。
    """
    out: list[str] = []
    idx: list[int] = []
    for i, ch in enumerate(s):
        f = unicodedata.normalize("NFKC", ch).casefold()
        if not f:
            continue
        out.append(f)
        idx.extend([i] * len(f))
    return "".join(out), idx


def _fold(s: str) -> str:
    return _fold_with_map(s)[0]


def _spans(folded: str, imap: list[int], needle: str, n: int) -> list[tuple[int, int]]:
    """All occurrences of a folded needle, mapped back to source offsets."""
    out: list[tuple[int, int]] = []
    if not needle:
        return out
    start = 0
    while True:
        i = folded.find(needle, start)
        if i < 0:
            return out
        j = i + len(needle) - 1
        out.append((imap[i], min(imap[j] + 1, n)))
        start = i + len(needle)


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


# --- checking -----------------------------------------------------------------

def check(text: str, rules: dict | None) -> list[dict]:
    """禁止語の検出。``[{"term", "span", "line", "suggestion", "rule"}, …]``。

    * ``span`` は元テキストの ``[start, end)`` 文字オフセット、``line`` は 1 始まり。
    * ``suggestion`` は ``replacements`` にあれば言い換え候補、無ければ ``""``。
    * ヒットは重ならない（最長一致優先）。「検品レス」と「検品」の両方が禁止なら
      長い方だけを1件返すので、そのまま置換に使える。
    * **``allow`` の語句に重なるヒットは作らない**（モジュール docstring の理屈）。

    ルール未設定なら常に ``[]``（＝検査は完全に無効）。
    """
    if not isinstance(text, str) or not text or not enabled(rules):
        return []
    r = rules or {}
    n = len(text)
    folded, imap = _fold_with_map(text)

    # 1. Freeze the protected ground first: proper names win over word bans.
    protected: list[tuple[int, int]] = []
    for phrase in r.get("allow", []):
        protected.extend(_spans(folded, imap, _fold(phrase), n))

    def _is_protected(a: int, b: int) -> bool:
        return any(a < pb and pa < b for pa, pb in protected)

    repl: dict[str, str] = r.get("replacements") or {}
    repl_by_fold = {_fold(k): v for k, v in repl.items()}

    # 2. Literal terms: 禁止語 ∪ 言い換え辞書のキー (a replacement key is a term the
    #    guide already decided is wrong — detecting it is what makes `apply` honest).
    terms = list(dict.fromkeys(list(r.get("forbidden", [])) + list(repl.keys())))
    hits: list[dict] = []
    for term in terms:
        ft = _fold(term)
        for a, b in _spans(folded, imap, ft, n):
            if _is_protected(a, b):
                continue
            hits.append({"term": text[a:b], "span": [a, b],
                         "line": _line_of(text, a),
                         "suggestion": repl_by_fold.get(ft, ""), "rule": "forbidden"})

    # 3. The optional regex (authored against the real text, so matched raw).
    rx = r.get("forbidden_regex")
    if rx:
        try:
            pat = re.compile(rx, re.IGNORECASE)
        except re.error:  # a broken guide must not block the whole check
            pat = None
        if pat is not None:
            for m in pat.finditer(text):
                a, b = m.start(), m.end()
                if b <= a or _is_protected(a, b):
                    continue
                hits.append({"term": text[a:b], "span": [a, b],
                             "line": _line_of(text, a),
                             # only an EXACT dictionary entry is a safe rewrite
                             "suggestion": repl_by_fold.get(_fold(text[a:b]), ""),
                             "rule": "regex"})

    # 4. Longest match wins; drop anything overlapping an already-kept hit.
    hits.sort(key=lambda h: (h["span"][0], -(h["span"][1] - h["span"][0])))
    kept: list[dict] = []
    last_end = -1
    for h in hits:
        a, b = h["span"]
        if a < last_end:
            continue
        kept.append(h)
        last_end = b
    return kept


def apply(text: str, rules: dict | None) -> tuple[str, list[dict]]:
    """言い換えの適用 → ``(new_text, changes)``。

    安全な置換だけを行う: ``replacements`` に**そのままの語**があるヒットのみ。
    候補の無い禁止語（と正規表現ヒット）は人が直すために残す。``allow`` の語句は
    ``check`` の段階でヒットにならないので、当然ここでも触らない。
    """
    hits = check(text, rules)
    changes = [h for h in hits if h.get("suggestion")]
    if not changes:
        return text, []
    out = text
    for h in sorted(changes, key=lambda x: x["span"][0], reverse=True):
        a, b = h["span"]
        out = out[:a] + h["suggestion"] + out[b:]
    return out, [{"term": h["term"], "to": h["suggestion"],
                  "span": list(h["span"]), "line": h["line"]}
                 for h in sorted(changes, key=lambda x: x["span"][0])]


def _skip_key(key: str, extra: tuple[str, ...] | list[str]) -> bool:
    k = str(key).lower()
    for s in tuple(_SKIP_KEYS) + tuple(extra):
        if k == s or k.endswith("_" + s):
            return True
    return False


def lint_export(payload: Any, rules: dict | None) -> list[dict]:
    """提案書に渡す辞書を再帰的に走査して検査（タイトル/見出し/本文/KPIラベル…）。

    文字列の葉ごとに :func:`check` を掛け、``path``（``insights.0.title`` のような
    ドット表記）と ``context``（その行）を足して返す。識別子・パス・色などの
    キー（``_SKIP_KEYS`` / ``rules["skip_keys"]``）は走査しない — 提案書に出ない値で
    誤検知を作らないため。ルール未設定なら ``[]``。
    """
    if not enabled(rules):
        return []
    skip_extra = tuple((rules or {}).get("skip_keys") or ())
    out: list[dict] = []

    def walk(node: Any, path: str, depth: int) -> None:
        if len(out) >= _MAX_HITS or depth > _MAX_DEPTH:
            return
        if isinstance(node, str):
            lines = node.splitlines()
            for hit in check(node, rules):
                i = hit["line"] - 1
                line = lines[i] if 0 <= i < len(lines) else node
                out.append({**hit, "path": path, "context": line.strip()[:120]})
                if len(out) >= _MAX_HITS:
                    return
        elif isinstance(node, dict):
            for k, v in node.items():
                if _skip_key(k, skip_extra):
                    continue
                walk(v, f"{path}.{k}" if path else str(k), depth + 1)
        elif isinstance(node, (list, tuple)):
            for i, v in enumerate(node):
                walk(v, f"{path}.{i}" if path else str(i), depth + 1)

    walk(payload, "", 0)
    return out


# --- the proposal's own strings ----------------------------------------------

def proposal_payload(proj: Any, extras: dict | None = None) -> dict:
    """提案書に出る文字列だけを集めた辞書（``lint_export`` の入力）。

    最新ランの KPI（判定文・ボトルネック名）＋ブランド（宛先/自社名/フッタ）＋
    直近のシナリオ比較を、**プロジェクトの成果物から**組み立てる（web 依存なし＝
    CLI からも同じものを検査できる）。``extras`` は web 層の ``_proposal_extras``
    をそのまま渡す想定で、示唆(insights)・保管設計など出力に載る材料を上書き/追加
    する。読めないものは黙って飛ばす（never blocks）。
    """
    payload: dict = {}
    try:
        payload["project"] = proj.meta().get("name")
    except Exception:  # noqa: BLE001 — a name is nice to have, never required
        pass
    try:
        rd = proj.latest_run_dir()
        if rd is not None and (rd / "kpis.json").is_file():
            payload["kpis"] = json.loads((rd / "kpis.json").read_text("utf-8"))
    except Exception:  # noqa: BLE001 — no run yet / unreadable artifact
        pass
    try:
        model = proj.load_model()
        brand = getattr(getattr(model, "settings", None), "brand", None)
        if brand is not None:
            payload["brand"] = brand.model_dump()
    except Exception:  # noqa: BLE001
        pass
    try:
        for d in sorted(proj.runs_dir.glob("compare_*"), reverse=True):
            f = d / "compare.json"
            if f.is_file():
                payload["scenarios"] = json.loads(f.read_text("utf-8"))
                break
    except Exception:  # noqa: BLE001
        pass
    for k, v in (extras or {}).items():
        if v:
            payload[k] = v
    return payload
