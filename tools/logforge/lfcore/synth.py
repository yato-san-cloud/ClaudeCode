"""Synthetic WMS pick-log generator -- the tool's own test fixture.

No real site, person or SKU ever enters the repository: the sample is drawn from
*known* true parameters (default lognorm s=0.4, scale=12.0 seconds of pick time)
so the fit can be graded against the truth instead of against a vibe.

The generated file deliberately carries the defects that make real exports
painful:

* two junk lines above the header (a title and an export banner);
* half-width kana in header names (商品ｺｰﾄﾞ / 出荷ﾊﾞﾗ数);
* location codes written WITHOUT zero padding while the master has them WITH it;
* a site code that Excel stored as a number, eating its leading zeros;
* in the --dirty variant: an empty required cell, a non-numeric quantity, an
  unparseable timestamp, a code missing from the master, and an end-before-start
  pair.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

SHEET_NAME = "実績"
TITLE_LINES = ("出荷実績（合成データ）", "作成: log-forge synth（実データではありません）")

HEADER = [
    "伝票番号",
    "拠点コード",
    "ロケーション",
    "商品ｺｰﾄﾞ",
    "出荷ﾊﾞﾗ数",
    "作業者コード",
    "指示日時",
    "作業開始日時",
    "作業終了日時",
]

TRUE_PICK_TIME = {"dist": "lognorm", "s": 0.4, "scale": 12.0}
_AREAS = ("A", "B", "C")
_SHIFT_START = datetime(2025, 7, 1, 8, 0, 0)


@dataclass
class Truth:
    """What the generator actually drew from (written next to the sample)."""

    rows: int
    seed: int
    pick_time_s: dict
    walk_time_s: dict
    t0_hint: str

    def as_dict(self) -> dict:
        return {
            "note": "合成データの真値。フィット結果はこの値に回帰するはず。",
            "rows": self.rows,
            "seed": self.seed,
            "pick_time_s": self.pick_time_s,
            "walk_time_s": self.walk_time_s,
            "t0_hint": self.t0_hint,
        }


def _loc_codes(rng: np.random.Generator, count: int) -> list[tuple[str, str]]:
    """(master form, history form) - the master zero-pads, the history does not."""
    codes: list[tuple[str, str]] = []
    for area in _AREAS:
        for aisle in range(1, 9):
            for bay in range(1, 13):
                codes.append((f"{area}-{aisle:02d}-{bay:02d}", f"{area}-{aisle}-{bay}"))
    rng.shuffle(codes)
    return codes[:count]


def generate(
    outdir: str | Path,
    rows: int = 1200,
    seed: int = 20250701,
    dirty: bool = False,
    write_csv: bool = True,
) -> dict[str, Path]:
    """Write a synthetic sample set; returns {name: path}."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)

    locations = _loc_codes(rng, 180)
    actors = [f"W{i:02d}" for i in range(1, 7)]

    records: list[list] = []
    order_seq = 0
    for actor_index, actor in enumerate(actors):
        clock = _SHIFT_START + timedelta(seconds=float(rng.integers(0, 600)))
        lines_for_actor = rows // len(actors) + (1 if actor_index < rows % len(actors) else 0)
        lines_left_in_order = 0
        order_id = ""
        for _ in range(lines_for_actor):
            if lines_left_in_order == 0:
                order_seq += 1
                order_id = f"SO-20250701-{order_seq:05d}"
                lines_left_in_order = int(rng.integers(1, 5))
                assign_gap = float(rng.uniform(30.0, 300.0))
                assigned_at = clock - timedelta(seconds=assign_gap)
            lines_left_in_order -= 1

            walk = float(rng.gamma(shape=2.0, scale=4.0))
            pick = float(rng.lognormal(mean=np.log(TRUE_PICK_TIME["scale"]),
                                       sigma=TRUE_PICK_TIME["s"]))
            start = clock + timedelta(seconds=walk)
            end = start + timedelta(seconds=pick)
            clock = end

            master_code, history_code = locations[int(rng.integers(0, len(locations)))]
            records.append(
                [
                    order_id,
                    int(rng.integers(1, 13)),  # 拠点コード: a number, leading zeros gone
                    history_code,
                    f"SKU{int(rng.integers(1, 4000)):06d}",
                    int(rng.integers(1, 25)),
                    actor,
                    assigned_at,
                    start,
                    end,
                ]
            )
            _ = master_code

    records.sort(key=lambda row: (row[7], row[0]))

    if dirty:
        records = _inject_defects(records)

    files: dict[str, Path] = {}
    files["xlsx"] = _write_xlsx(
        outdir / ("wms_picklog_dirty.xlsx" if dirty else "wms_picklog.xlsx"), records
    )
    if write_csv:
        files["csv"] = _write_csv(
            outdir / ("wms_picklog_dirty.csv" if dirty else "wms_picklog.csv"), records
        )
    files["master"] = _write_master(outdir / "loc_master.csv", locations)

    truth = Truth(
        rows=len(records),
        seed=seed,
        pick_time_s=dict(TRUE_PICK_TIME),
        walk_time_s={"dist": "gamma", "a": 2.0, "scale": 4.0},
        t0_hint=_SHIFT_START.isoformat(sep=" "),
    )
    truth_path = outdir / ("truth_dirty.json" if dirty else "truth.json")
    truth_path.write_text(
        json.dumps(truth.as_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    files["truth"] = truth_path
    return files


def _inject_defects(records: list[list]) -> list[list]:
    """Insert the five failure modes the error table exists for."""
    records = [list(row) for row in records]
    if len(records) < 10:
        return records
    records[2][0] = ""  # required 伝票番号 empty
    records[4][4] = "－"  # quantity not numeric
    records[6][8] = "2025/13/32 99:99"  # unparseable timestamp
    records[8][2] = "Z-9-9"  # location absent from the master
    records[10][7], records[10][8] = records[10][8], records[10][7]  # end before start
    return records


def _write_xlsx(path: Path, records: list[list]) -> Path:
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = SHEET_NAME
    for line in TITLE_LINES:
        sheet.append([line])
    sheet.append(HEADER)
    for row in records:
        sheet.append(row)
    for column, width in zip("ABCDEFGHI", (18, 10, 14, 12, 10, 12, 21, 21, 21)):
        sheet.column_dimensions[column].width = width
    # Pin the document properties: otherwise openpyxl stamps "now" into
    # docProps/core.xml. (The zip container still carries member mtimes, so the
    # sample's *content* is reproducible from the seed while its bytes are not;
    # conversion outputs are byte-reproducible, which is what the DoD is about.)
    fixed = datetime(2000, 1, 1)
    workbook.properties.created = fixed
    workbook.properties.modified = fixed
    workbook.properties.creator = "log-forge synth"
    workbook.properties.lastModifiedBy = "log-forge synth"
    workbook.save(path)
    return path


def _fmt(value) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    return str(value)


def _write_csv(path: Path, records: list[list]) -> Path:
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        for line in TITLE_LINES:
            writer.writerow([line])
        writer.writerow(HEADER)
        for row in records:
            writer.writerow([_fmt(cell) for cell in row])
    return path


def _write_master(path: Path, locations: list[tuple[str, str]]) -> Path:
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["ロケーション", "エリア", "什器種別"])
        for master_code, _ in sorted(locations):
            writer.writerow([master_code, master_code.split("-")[0], "中量棚"])
    return path
