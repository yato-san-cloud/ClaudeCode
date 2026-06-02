"""Shelf-to-shelf (location-to-location) distance matrix importer.

External tools (laser scanners, BIM exports, manual surveys) can produce a
measured distance matrix between storage locations. This module imports such an
export tolerantly so that measured real distances can refine whsim's flow-line
study.

Public API:
    import_distance_matrix_bytes(data, filename="") -> dict
    import_distance_matrix(path) -> dict
    lookup(pairs, a_id, b_id) -> float | None

The returned dict is exactly::

    {"pairs": {"<from>|<to>": float_meters, ...},
     "ids": [sorted unique location ids],
     "count": int,
     "symmetric": bool,
     "warnings": [str]}  # Japanese, human-readable

Design notes mirror the rest of whsim: never block on messy data. Bad rows are
skipped with a Japanese warning; only a totally unreadable file raises.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re

# Cap to keep memory/CPU sane on a pathological export.
MAX_PAIRS = 2_000_000

# Max JSON bracket-nesting depth (see importer.MAX_JSON_DEPTH): a recursion-bomb
# document (``[[[[...]]]]`` tens of thousands deep) makes json.loads raise
# RecursionError, which is not a JSONDecodeError and would otherwise leak out as
# a 500/opaque error. A real distance matrix nests at most 2 levels.
MAX_JSON_DEPTH = 200


def _json_too_deep(text: str, limit: int = MAX_JSON_DEPTH) -> bool:
    """True if JSON text nests brackets/braces deeper than ``limit`` (ignoring
    brackets inside string literals). Cheap linear pre-scan run before
    json.loads so a recursion bomb is rejected without ever recursing."""
    depth = 0
    in_str = False
    escape = False
    for ch in text:
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
            if depth > limit:
                return True
        elif ch in "]}":
            if depth > 0:
                depth -= 1
    return False

# Candidate header names (lowercased) for long-form CSV / JSON list, by role.
_FROM_HEADERS = {
    "from", "from_id", "fromid", "src", "source", "source_id", "origin",
    "a", "start", "元", "元id", "起点", "発", "出発",
}
_TO_HEADERS = {
    "to", "to_id", "toid", "dst", "dest", "destination", "destination_id",
    "target", "b", "end", "先", "先id", "終点", "着", "到着",
}
_DIST_HEADERS = {
    "distance", "dist", "dst_m", "meters", "metres", "m", "length", "len",
    "value", "距離", "きょり", "長さ", "距離m", "距離(m)",
}


def lookup(pairs: dict, a_id: str, b_id: str):
    """Return the distance between a_id and b_id (either direction) or None."""
    a = str(a_id)
    b = str(b_id)
    val = pairs.get(f"{a}|{b}")
    if val is not None:
        return val
    return pairs.get(f"{b}|{a}")


def _coerce_distance(raw) -> float | None:
    """Coerce a messy distance cell to a non-negative float, else None.

    Handles: "12.3 m", "12,3" (decimal comma), "1,234.5" (thousands), units,
    surrounding whitespace. Returns None for blank / non-numeric / negative.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        v = float(raw)
        return v if v >= 0 else None

    s = str(raw).strip()
    if not s:
        return None

    # Strip common unit suffixes/labels (m, meter(s), メートル, etc.).
    s = re.sub(r"(?i)\b(meters?|metres?|m|メートル|ｍ)\b", "", s)
    s = s.replace("メートル", "").replace("ｍ", "").replace("m", "").replace("M", "")
    s = s.strip()
    if not s:
        return None

    # Keep only number-relevant characters.
    cleaned = re.sub(r"[^0-9,.\-+]", "", s)
    if not cleaned:
        return None

    # Decide how to interpret , and . (thousands vs decimal separators).
    has_comma = "," in cleaned
    has_dot = "." in cleaned
    if has_comma and has_dot:
        # Whichever comes last is the decimal separator.
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif has_comma:
        # Single comma with <=2 trailing digits -> decimal comma; else thousands.
        parts = cleaned.split(",")
        if len(parts) == 2 and len(parts[1]) != 3:
            cleaned = parts[0] + "." + parts[1]
        else:
            cleaned = cleaned.replace(",", "")
    # else: dot-only or plain integer -> leave as is.

    try:
        v = float(cleaned)
    except ValueError:
        return None
    if v != v or v in (float("inf"), float("-inf")):  # NaN / inf guard
        return None
    return v if v >= 0 else None


def _norm_id(raw) -> str:
    return str(raw).strip()


def _build_result(
    raw_pairs: dict[str, float], warnings: list[str], inferred_reverse: bool
) -> dict:
    ids = sorted({pid for key in raw_pairs for pid in key.split("|", 1)})
    return {
        "pairs": raw_pairs,
        "ids": ids,
        "count": len(raw_pairs),
        "symmetric": inferred_reverse,
        "warnings": warnings,
    }


def _add_pair(
    pairs: dict[str, float],
    warnings: list[str],
    state: dict,
    a: str,
    b: str,
    dist: float,
) -> bool:
    """Insert a forward pair; return False if the cap was hit."""
    if len(pairs) >= MAX_PAIRS:
        if not state.get("truncated"):
            warnings.append(
                f"ペア数が上限（{MAX_PAIRS:,}件）に達したため、以降のデータを切り捨てました。"
            )
            state["truncated"] = True
        return False
    key = f"{a}|{b}"
    pairs[key] = dist
    state.setdefault("explicit", set()).add(key)
    return True


def _infer_reverses(
    pairs: dict[str, float], warnings: list[str], state: dict
) -> bool:
    """Fill missing reverse directions. Returns True if any were inferred."""
    explicit = state.get("explicit", set())
    inferred = False
    # Snapshot keys; we mutate during iteration.
    for key in list(pairs.keys()):
        a, b = key.split("|", 1)
        if a == b:
            continue
        rev = f"{b}|{a}"
        if rev in explicit:
            continue  # both directions explicitly given -> keep both
        if rev not in pairs:
            if len(pairs) >= MAX_PAIRS:
                if not state.get("truncated"):
                    warnings.append(
                        f"ペア数が上限（{MAX_PAIRS:,}件）に達したため、逆方向の補完を打ち切りました。"
                    )
                    state["truncated"] = True
                break
            pairs[rev] = pairs[key]
            inferred = True
    if inferred:
        warnings.append(
            "片方向のみ指定されたペアについて、同じ距離で逆方向を自動補完しました。"
        )
    return inferred


# --------------------------------------------------------------------------- #
# Format-specific parsers
# --------------------------------------------------------------------------- #
def _parse_json(obj, warnings: list[str]) -> dict:
    pairs: dict[str, float] = {}
    state: dict = {}

    if isinstance(obj, dict):
        # Nested: {"L0001": {"L0002": 12.3, ...}, ...}
        for src, inner in obj.items():
            if not isinstance(inner, dict):
                warnings.append(
                    f"行をスキップしました（'{src}' の値が辞書ではありません）。"
                )
                continue
            a = _norm_id(src)
            if not a:
                warnings.append("行をスキップしました（始点IDが空です）。")
                continue
            for dst, raw in inner.items():
                b = _norm_id(dst)
                if not b:
                    warnings.append("行をスキップしました（終点IDが空です）。")
                    continue
                dist = _coerce_distance(raw)
                if dist is None:
                    warnings.append(
                        f"行をスキップしました（{a}→{b} の距離 '{raw}' が無効です）。"
                    )
                    continue
                if not _add_pair(pairs, warnings, state, a, b, dist):
                    break
    elif isinstance(obj, list):
        # List of {"from","to","distance"} records.
        for i, rec in enumerate(obj):
            if not isinstance(rec, dict):
                warnings.append(f"行{i + 1}をスキップしました（レコードが辞書ではありません）。")
                continue
            a = b = None
            draw = None
            for k, v in rec.items():
                kl = str(k).strip().lower()
                if a is None and kl in _FROM_HEADERS:
                    a = _norm_id(v)
                elif b is None and kl in _TO_HEADERS:
                    b = _norm_id(v)
                elif draw is None and kl in _DIST_HEADERS:
                    draw = v
            if not a or not b:
                warnings.append(f"行{i + 1}をスキップしました（始点/終点IDが欠落しています）。")
                continue
            dist = _coerce_distance(draw)
            if dist is None:
                warnings.append(
                    f"行{i + 1}をスキップしました（距離 '{draw}' が無効です）。"
                )
                continue
            if not _add_pair(pairs, warnings, state, a, b, dist):
                break
    else:
        raise ValueError("JSONのトップレベルがオブジェクトでも配列でもありません。")

    inferred = _infer_reverses(pairs, warnings, state)
    return _build_result(pairs, warnings, inferred)


def _sniff_csv_dialect(text: str) -> str:
    """Pick a delimiter by sniffing the first non-empty line."""
    first = ""
    for line in text.splitlines():
        if line.strip():
            first = line
            break
    counts = {d: first.count(d) for d in (",", "\t", ";")}
    delim = max(counts, key=counts.get)
    return delim if counts[delim] > 0 else ","


def _looks_like_long_form(header: list[str]) -> bool:
    lowered = [h.strip().lower() for h in header]
    has_from = any(h in _FROM_HEADERS for h in lowered)
    has_to = any(h in _TO_HEADERS for h in lowered)
    has_dist = any(h in _DIST_HEADERS for h in lowered)
    return has_from and has_to and has_dist


def _parse_csv_long(rows: list[list[str]], header: list[str], warnings: list[str]) -> dict:
    lowered = [h.strip().lower() for h in header]
    from_idx = to_idx = dist_idx = None
    for idx, h in enumerate(lowered):
        if from_idx is None and h in _FROM_HEADERS:
            from_idx = idx
        elif to_idx is None and h in _TO_HEADERS:
            to_idx = idx
        elif dist_idx is None and h in _DIST_HEADERS:
            dist_idx = idx

    pairs: dict[str, float] = {}
    state: dict = {}
    for i, row in enumerate(rows):
        if not any(cell.strip() for cell in row):
            continue  # blank line
        try:
            a = _norm_id(row[from_idx])
            b = _norm_id(row[to_idx])
            draw = row[dist_idx]
        except IndexError:
            warnings.append(f"行{i + 1}をスキップしました（列数が不足しています）。")
            continue
        if not a or not b:
            warnings.append(f"行{i + 1}をスキップしました（始点/終点IDが空です）。")
            continue
        dist = _coerce_distance(draw)
        if dist is None:
            warnings.append(
                f"行{i + 1}をスキップしました（距離 '{draw}' が無効です）。"
            )
            continue
        if not _add_pair(pairs, warnings, state, a, b, dist):
            break

    inferred = _infer_reverses(pairs, warnings, state)
    return _build_result(pairs, warnings, inferred)


def _parse_csv_matrix(rows: list[list[str]], warnings: list[str]) -> dict:
    if not rows:
        raise ValueError("CSVが空です。")
    header = rows[0]
    dest_ids = [_norm_id(c) for c in header[1:]]
    pairs: dict[str, float] = {}
    state: dict = {}

    for i, row in enumerate(rows[1:]):
        if not any(cell.strip() for cell in row):
            continue
        src = _norm_id(row[0]) if row else ""
        if not src:
            warnings.append(f"行{i + 2}をスキップしました（始点IDが空です）。")
            continue
        for j, cell in enumerate(row[1:]):
            if j >= len(dest_ids):
                break
            b = dest_ids[j]
            if not b:
                continue
            if cell is None or not str(cell).strip():
                continue  # empty cell -> no measurement, silently skip
            dist = _coerce_distance(cell)
            if dist is None:
                warnings.append(
                    f"セルをスキップしました（{src}→{b} の距離 '{cell}' が無効です）。"
                )
                continue
            if not _add_pair(pairs, warnings, state, src, b, dist):
                break
        else:
            continue
        break  # cap hit during inner loop

    inferred = _infer_reverses(pairs, warnings, state)
    return _build_result(pairs, warnings, inferred)


def _parse_csv(text: str, warnings: list[str]) -> dict:
    delim = _sniff_csv_dialect(text)
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    rows = [r for r in reader]
    # Drop fully empty leading rows.
    while rows and not any(c.strip() for c in rows[0]):
        rows.pop(0)
    if not rows:
        raise ValueError("CSVに有効な行がありません。")

    header = rows[0]
    if _looks_like_long_form(header):
        return _parse_csv_long(rows[1:], header, warnings)
    # Matrix form: first row = destination ids, first column = source ids.
    return _parse_csv_matrix(rows, warnings)


# --------------------------------------------------------------------------- #
# Public entry points
# --------------------------------------------------------------------------- #
def import_distance_matrix_bytes(data: bytes, filename: str = "") -> dict:
    """Import a distance matrix from raw bytes.

    Auto-detects JSON vs CSV by filename extension and content sniffing.
    Tolerant of messy exports; only raises on a totally unreadable file.
    """
    warnings: list[str] = []

    if data is None:
        raise ValueError("入力データがありません。")

    # Decode bytes -> text, tolerating BOM and a couple of common encodings.
    text = None
    if isinstance(data, (bytes, bytearray)):
        for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis", "latin-1"):
            try:
                text = bytes(data).decode(enc)
                if enc not in ("utf-8-sig", "utf-8"):
                    warnings.append(f"文字コードを {enc} として読み込みました。")
                break
            except (UnicodeDecodeError, LookupError):
                continue
        if text is None:
            raise ValueError("ファイルの文字コードを判別できませんでした。")
    else:
        text = str(data)

    if not text.strip():
        raise ValueError("ファイルが空です。")

    ext = os.path.splitext(filename)[1].lower() if filename else ""
    stripped = text.lstrip()
    looks_json = ext == ".json" or (
        ext not in (".csv", ".tsv", ".txt") and stripped[:1] in ("{", "[")
    )

    if looks_json:
        if _json_too_deep(text):
            warnings.append("JSONのネストが深すぎます。")
            return _build_result({}, warnings, False)
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, RecursionError) as exc:
            # Malformed JSON must not block: try a CSV reading of the same text,
            # and if that also yields nothing usable, return an empty (valid)
            # result with a warning rather than raising. "Never reject data."
            warnings.append(f"JSONとして解析できませんでした（{exc}）。別形式として再解釈します。")
            try:
                res = _parse_csv(text, warnings)
            except ValueError:
                res = _build_result({}, warnings, False)
            if res["count"] == 0:
                warnings.append("有効な距離データが見つかりませんでした。")
            return res
        return _parse_json(obj, warnings)

    # CSV / matrix path. A totally empty/garbage CSV yields zero pairs with a
    # warning rather than an exception.
    try:
        return _parse_csv(text, warnings)
    except ValueError as exc:
        warnings.append(f"距離データを解析できませんでした（{exc}）。")
        return _build_result({}, warnings, False)


def import_distance_matrix(path) -> dict:
    """Import a distance matrix from a file path."""
    path = os.fspath(path)
    with open(path, "rb") as fh:
        data = fh.read()
    return import_distance_matrix_bytes(data, filename=os.path.basename(path))


# --------------------------------------------------------------------------- #
# Self-test
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # CSV long-form: Japanese header variant + arbitrary column order +
    # one malformed row (bad distance) + one with a unit/decimal-comma.
    csv_long = (
        "距離,元,先\n"
        "12.3 m,L0001,L0002\n"
        '"8,5",L0002,L0003\n'    # quoted decimal comma -> 8.5
        "abc,L0003,L0004\n"      # malformed distance -> skipped
        "5.0,L0001,L0001\n"      # self pair, kept, no reverse inference
    ).encode("utf-8")

    res_csv = import_distance_matrix_bytes(csv_long, filename="export.csv")
    print("=== CSV long-form ===")
    print("count:", res_csv["count"])
    print("ids:", res_csv["ids"])
    print("symmetric:", res_csv["symmetric"])
    print("pairs:", res_csv["pairs"])
    print("warnings:")
    for w in res_csv["warnings"]:
        print("  -", w)
    print("lookup L0002<->L0001:", lookup(res_csv["pairs"], "L0002", "L0001"))

    assert "L0003|L0004" not in res_csv["pairs"], "malformed row must be skipped"
    assert res_csv["pairs"]["L0002|L0001"] == 12.3, "reverse must be inferred"
    assert abs(res_csv["pairs"]["L0002|L0003"] - 8.5) < 1e-9, "decimal comma"
    assert res_csv["symmetric"] is True, "reverse inference -> symmetric"

    # JSON nested example.
    json_nested = json.dumps(
        {
            "L0001": {"L0002": 12.3, "L0003": 20.0},
            "L0002": {"L0001": 12.3},  # explicit reverse -> kept, not re-inferred
        }
    ).encode("utf-8")

    res_json = import_distance_matrix_bytes(json_nested, filename="m.json")
    print("\n=== JSON nested ===")
    print("count:", res_json["count"])
    print("ids:", res_json["ids"])
    print("symmetric:", res_json["symmetric"])
    print("pairs:", res_json["pairs"])
    print("warnings:")
    for w in res_json["warnings"]:
        print("  -", w)

    assert res_json["pairs"]["L0001|L0003"] == 20.0
    assert res_json["pairs"]["L0003|L0001"] == 20.0, "reverse inferred for L0003"
    assert lookup(res_json["pairs"], "L0009", "L0010") is None

    print("\nAll self-test assertions passed.")
