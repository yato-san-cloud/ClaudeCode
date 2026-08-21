"""The conversion itself: WMS table -> orders.json / events.jsonl / calibration.json.

Two rules shape the whole file:

1. **Never invent.** An event type is emitted only when a timestamp column in the
   input actually carries it; a code that is not in the master is quarantined in
   error_table.csv instead of being guessed; a distribution is never reported
   without n and a GOF score.
2. **Never stop.** A broken row is isolated, the run continues, and the damage
   is written down. Only an unreadable file or a malformed mapping is fatal.

Everything except meta.json's ``created_at`` is a pure function of
(input bytes, mapping bytes), so two runs are byte-identical.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import fitting
from .mapping import CORE_EVENT_TYPES, Mapping, load_mapping
from .normalize import MasterIndex, NormalizeRule, cell_to_text, load_master, parse_number
from .tables import Row, Table, read_table
from .timeconv import iso, parse_wallclock, to_elapsed

GENERATOR = "log-forge/0.1.0"
SCHEMA_VERSION = "1.0"

_TYPE_RANK = {name: index for index, name in enumerate(CORE_EVENT_TYPES)}

_DETAIL = {
    "required_column_missing": "必須列が入力に見つからない（mapping.yaml の columns: を確認）",
    "required_value_empty": "必須項目が空",
    "qty_not_numeric": "数量が数値として読めない",
    "unparseable_timestamp": "時刻として解釈できない値",
    "unknown_code": "マスタに無いコード（隔離して処理は継続）",
    "negative_duration": "終了が開始より前",
    "duration_out_of_range": "作業時間が設定レンジ外",
    "t_before_t0": "t0 より前の時刻（経過秒が負）",
    "insufficient_samples": "件数が min_samples 未満のため分布フィットを行わない",
    "fit_failed": "分布フィットに失敗",
    "no_timestamps": "時刻列が1件も解釈できなかった",
}


@dataclass
class ErrorRow:
    row: int
    stage: str
    field: str
    column: str
    value: str
    reason: str
    action: str

    def as_list(self) -> list[str]:
        value = self.value if len(self.value) <= 200 else self.value[:197] + "..."
        return [
            str(self.row),
            self.stage,
            self.field,
            self.column,
            value,
            self.reason,
            self.action,
            _DETAIL.get(self.reason, ""),
        ]


@dataclass
class ConvertResult:
    orders: list[dict]
    events: list[dict]
    calibration: dict
    meta: dict
    errors: list[ErrorRow]
    notes: list[str] = field(default_factory=list)

    @property
    def files(self) -> dict[str, str]:
        return {
            "orders.json": _dump_json(self.orders),
            "events.jsonl": _dump_jsonl(self.events),
            "calibration.json": _dump_json(self.calibration),
            "error_table.csv": _dump_errors(self.errors),
            "meta.json": _dump_json(self.meta),
        }


# --------------------------------------------------------------------------- #
# serialisation (byte-stable)
# --------------------------------------------------------------------------- #
def _dump_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def _dump_jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


def _dump_errors(errors: list[ErrorRow]) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["row", "stage", "field", "column", "value", "reason", "action", "detail"])
    for error in errors:
        writer.writerow(error.as_list())
    return buffer.getvalue()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------- #
# per-row intermediate
# --------------------------------------------------------------------------- #
@dataclass
class Record:
    row: Row
    values: dict[str, str]
    qty: float | None
    times: dict[str, datetime]


def _prepare_masters(m: Mapping) -> dict[str, MasterIndex]:
    masters: dict[str, MasterIndex] = {}
    for fieldkey, spec in m.masters.items():
        rule = (
            NormalizeRule.from_dict(m.normalize.get(fieldkey))
            if spec.get("normalize_key", True)
            else None
        )
        masters[fieldkey] = load_master(
            m.resolve(str(spec["file"])),
            str(spec.get("key_column", fieldkey)),
            rule,
            str(spec.get("on_unknown", "error_table")),
        )
    return masters


def _scan_rows(
    table: Table, m: Mapping, masters: dict[str, MasterIndex], errors: list[ErrorRow]
) -> list[Record]:
    rules = {key: NormalizeRule.from_dict(rule) for key, rule in m.normalize.items()}
    time_fields = m.time_fields()
    records: list[Record] = []

    for row in table.rows:
        values: dict[str, str] = {}
        for key in m.columns:
            raw = row.cells.get(key)
            rule = rules.get(key)
            values[key] = rule.apply(raw) if rule else cell_to_text(raw).strip()

        blocked = False
        for key in m.required:
            if key in table.missing_fields:
                errors.append(
                    ErrorRow(row.number, "schema", key, "", "", "required_column_missing",
                             "row_quarantined")
                )
                blocked = True
                break
            if not values.get(key):
                errors.append(
                    ErrorRow(row.number, "value", key, table.column_of.get(key, ""), "",
                             "required_value_empty", "row_quarantined")
                )
                blocked = True
                break
        if blocked:
            continue

        qty_key = m.orders["qty"]
        qty = parse_number(row.cells.get(qty_key)) if qty_key not in table.missing_fields else None
        if qty_key in m.required and qty is None:
            errors.append(
                ErrorRow(row.number, "value", qty_key, table.column_of.get(qty_key, ""),
                         cell_to_text(row.cells.get(qty_key)), "qty_not_numeric",
                         "row_quarantined")
            )
            continue

        for key, master in masters.items():
            code = values.get(key, "")
            if code and code not in master:
                if master.on_unknown == "keep":
                    continue
                if master.on_unknown == "error_table":
                    errors.append(
                        ErrorRow(row.number, "master", key, table.column_of.get(key, ""), code,
                                 "unknown_code", "row_quarantined")
                    )
                blocked = True
                break
        if blocked:
            continue

        times: dict[str, datetime] = {}
        for key in time_fields:
            if key in table.missing_fields:
                continue
            raw = row.cells.get(key)
            when = parse_wallclock(raw, m.time_formats)
            if when is not None:
                times[key] = when
            elif cell_to_text(raw).strip():
                errors.append(
                    ErrorRow(row.number, "time", key, table.column_of.get(key, ""),
                             cell_to_text(raw), "unparseable_timestamp", "field_dropped")
                )

        records.append(Record(row=row, values=values, qty=qty, times=times))
    return records


def _resolve_t0(records: list[Record], m: Mapping) -> datetime | None:
    if m.t0_mode == "fixed":
        fixed = parse_wallclock(m.t0_fixed, m.time_formats)
        if fixed is None:
            raise ValueError(f"time.t0_fixed={m.t0_fixed!r} is not a parseable timestamp")
        return fixed
    stamps = [when for record in records for when in record.times.values()]
    return min(stamps) if stamps else None


def _build_orders(
    records: list[Record], m: Mapping, t0: datetime | None, errors: list[ErrorRow]
) -> list[dict]:
    ready_key = m.orders.get("ready_t")
    orders: list[dict] = []
    for record in records:
        order = {
            "order_id": record.values[m.orders["order_id"]],
            "loc_id": record.values[m.orders["loc_id"]],
            "qty": record.qty if record.qty is not None else 0.0,
        }
        if order["qty"] == int(order["qty"]):
            order["qty"] = int(order["qty"])
        if ready_key and t0 is not None and ready_key in record.times:
            elapsed = to_elapsed(record.times[ready_key], t0, m.ndigits)
            if elapsed < 0:
                errors.append(
                    ErrorRow(record.row.number, "time", ready_key, "", iso(record.times[ready_key])
                             or "", "t_before_t0", "field_dropped")
                )
            else:
                order["ready_t"] = elapsed
        orders.append(order)
    return orders


def _build_events(
    records: list[Record],
    m: Mapping,
    table: Table,
    t0: datetime | None,
    errors: list[ErrorRow],
) -> tuple[list[dict], dict[str, int], list[str]]:
    emitted: dict[str, int] = {}
    omitted: list[str] = []
    if t0 is None:
        return [], emitted, [spec.type for spec in m.emit]

    staged: list[tuple[float, int, str, str, int, dict]] = []
    for spec in m.emit:
        if spec.time in table.missing_fields:
            omitted.append(spec.type)
            continue
        for sequence, record in enumerate(records):
            when = record.times.get(spec.time)
            if when is None:
                continue
            elapsed = to_elapsed(when, t0, m.ndigits)
            if elapsed < 0:
                errors.append(
                    ErrorRow(record.row.number, "time", spec.time, "", iso(when) or "",
                             "t_before_t0", "field_dropped")
                )
                continue
            event: dict[str, Any] = {"t": elapsed, "type": spec.type}
            actor = record.values.get(m.event_actor or "", "")
            if actor:
                event["actorId"] = actor
            if m.loc_as_node:
                loc = record.values.get(m.orders["loc_id"], "")
                if loc:
                    event["to"] = loc
            meta = {
                key: record.values[key]
                for key in m.event_meta_fields
                if record.values.get(key)
            }
            if meta:
                event["meta"] = meta
            staged.append(
                (elapsed, _TYPE_RANK.get(spec.type, 99), event.get("actorId", ""),
                 record.values.get(m.orders["order_id"], ""), sequence, event)
            )
            emitted[spec.type] = emitted.get(spec.type, 0) + 1

    staged.sort(key=lambda item: item[:5])
    return [item[5] for item in staged], emitted, omitted


def _build_calibration(
    records: list[Record], m: Mapping, table: Table, errors: list[ErrorRow]
) -> tuple[dict[str, dict], list[str]]:
    series_out: dict[str, dict] = {}
    notes: list[str] = []

    for spec in m.series:
        needed = [key for key in (spec.start, spec.end, spec.column) if key]
        missing = [key for key in needed if key in table.missing_fields]
        if missing:
            notes.append(f"{spec.name}: 列 {missing} が入力に無いため較正を出力しない")
            errors.append(
                ErrorRow(table.header_row_number, "calibration", spec.name, ",".join(missing), "",
                         "required_column_missing", "series_omitted")
            )
            continue

        values: list[float] = []
        excluded = 0
        for record in records:
            if spec.column:
                raw = record.row.cells.get(spec.column)
                number = parse_number(raw)
                seconds = None if number is None else number * spec.unit_factor
            else:
                start = record.times.get(spec.start or "")
                end = record.times.get(spec.end or "")
                seconds = None if (start is None or end is None) else (end - start).total_seconds()
            if seconds is None:
                continue
            if seconds < 0:
                errors.append(
                    ErrorRow(record.row.number, "calibration", spec.name, "", f"{seconds:.3f}",
                             "negative_duration", "sample_dropped")
                )
                excluded += 1
                continue
            if seconds < spec.min_s or (spec.max_s is not None and seconds > spec.max_s):
                errors.append(
                    ErrorRow(record.row.number, "calibration", spec.name, "", f"{seconds:.3f}",
                             "duration_out_of_range", "sample_dropped")
                )
                excluded += 1
                continue
            values.append(seconds)

        if len(values) < m.calib_min_samples:
            notes.append(
                f"{spec.name}: 有効 {len(values)} 件 < min_samples {m.calib_min_samples} "
                f"のため分布フィットを行わない（出所の無い数字を作らない）"
            )
            errors.append(
                ErrorRow(0, "calibration", spec.name, "", str(len(values)),
                         "insufficient_samples", "series_omitted")
            )
            continue

        try:
            series_out[spec.name] = fitting.fit_series(values, spec.candidates, excluded=excluded)
        except fitting.FitError as exc:
            notes.append(f"{spec.name}: フィット失敗（{exc}）")
            errors.append(
                ErrorRow(0, "calibration", spec.name, "", str(exc), "fit_failed", "series_omitted")
            )
    return series_out, notes


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #
def convert(
    input_path: str | Path,
    mapping_path: str | Path,
    created_at: str | None = None,
) -> ConvertResult:
    input_path = Path(input_path)
    mapping_path = Path(mapping_path)
    m = load_mapping(mapping_path)
    table = read_table(input_path, m)

    errors: list[ErrorRow] = []
    notes: list[str] = []
    for fieldkey in table.missing_fields:
        errors.append(
            ErrorRow(table.header_row_number, "schema", fieldkey, ",".join(m.columns[fieldkey]),
                     "", "required_column_missing",
                     "row_quarantined" if fieldkey in m.required else "field_dropped")
        )
        notes.append(
            f"列 {fieldkey} ({'/'.join(m.columns[fieldkey])}) が入力に無い"
            + ("（必須のため全行を隔離）" if fieldkey in m.required else "（その項目のみ欠落）")
        )

    masters = _prepare_masters(m)
    records = _scan_rows(table, m, masters, errors)
    t0 = _resolve_t0(records, m)
    if t0 is None:
        notes.append("時刻列が1件も解釈できなかったため events.jsonl は空・ready_t も出力しない")
        errors.append(ErrorRow(0, "time", "", "", "", "no_timestamps", "events_omitted"))

    orders = _build_orders(records, m, t0, errors)
    events, emitted_types, omitted_types = _build_events(records, m, table, t0, errors)
    series, calib_notes = _build_calibration(records, m, table, errors)
    notes.extend(calib_notes)

    latest = max(
        (when for record in records for when in record.times.values()), default=None
    )
    calibration = {
        "schema_version": SCHEMA_VERSION,
        **series,
        "source": m.source,
        # Deterministic on purpose: the end of the data window the fit came from,
        # NOT the wall clock of the conversion (see README "決定性").
        "fitted_at": iso(latest) or iso(t0) or "unknown",
    }

    errors.sort(key=lambda e: (e.row, e.stage, e.field, e.reason))
    run_id = "lf-" + hashlib.sha256(
        (_sha256(input_path) + _sha256(mapping_path)).encode("ascii")
    ).hexdigest()[:12]

    meta = {
        "run_id": run_id,
        "schema_version": SCHEMA_VERSION,
        "seed": None,
        "scenario_hash": None,
        "t0": iso(t0),
        "created_at": created_at
        or datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "generator": GENERATOR,
        "source": m.source,
        "inputs": {
            "input_file": input_path.name,
            "input_sha256": _sha256(input_path),
            "mapping_file": mapping_path.name,
            "mapping_sha256": _sha256(mapping_path),
            "sheet": m.sheet if isinstance(m.sheet, (str, int)) else str(m.sheet),
            "header_row": table.header_row_number,
        },
        "counts": {
            "rows_read": len(table.rows),
            "rows_accepted": len(records),
            "orders": len(orders),
            "events": len(events),
            "error_rows": len(errors),
        },
        "events": {
            "emitted_types": dict(sorted(emitted_types.items())),
            "omitted_types": sorted(set(omitted_types)),
            "not_restorable": sorted(
                set(CORE_EVENT_TYPES) - set(emitted_types) - set(omitted_types)
            ),
        },
        "notes": notes,
    }

    return ConvertResult(
        orders=orders, events=events, calibration=calibration, meta=meta, errors=errors,
        notes=notes,
    )


def write_outputs(result: ConvertResult, outdir: str | Path) -> dict[str, Path]:
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}
    for name, text in result.files.items():
        path = outdir / name
        encoding = "utf-8-sig" if name.endswith(".csv") else "utf-8"
        path.write_text(text, encoding=encoding, newline="")
        written[name] = path
    return written


def convert_to_dir(
    input_path: str | Path,
    mapping_path: str | Path,
    outdir: str | Path,
    created_at: str | None = None,
) -> tuple[ConvertResult, dict[str, Path]]:
    result = convert(input_path, mapping_path, created_at=created_at)
    return result, write_outputs(result, outdir)


__all__ = [
    "ConvertResult",
    "ErrorRow",
    "convert",
    "convert_to_dir",
    "load_mapping",
    "write_outputs",
]
