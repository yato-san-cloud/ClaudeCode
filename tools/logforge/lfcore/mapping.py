"""mapping.yaml -- the only place where an input file's shape is described.

No column name, sheet name, code width or timestamp format appears in the code:
a new WMS export is absorbed by writing a new mapping, never by editing Python.
A typo in a mapping key is a hard error (a silently ignored rule would disable a
normalisation rule while still reporting success).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CORE_EVENT_TYPES = (
    "task_assign",
    "move_start",
    "move_end",
    "wait_start",
    "wait_end",
    "pick_start",
    "pick_end",
    "load",
    "unload",
)

_TOP_KEYS = frozenset(
    {"version", "source", "input", "columns", "required", "normalize", "masters",
     "time", "orders", "events", "calibration"}
)
_INPUT_KEYS = frozenset({"sheet", "header_row", "csv"})
_CSV_KEYS = frozenset({"encoding", "delimiter"})
_NORMALIZE_KEYS = frozenset(
    {"trim", "nfkc", "upper", "lower", "remove_chars", "zero_pad", "segment_sep",
     "pad_segments", "prefix", "suffix"}
)
_MASTER_KEYS = frozenset({"file", "key_column", "normalize_key", "on_unknown"})
_TIME_KEYS = frozenset({"formats", "t0", "t0_fixed", "ndigits", "excel_serial_epoch"})
_ORDER_KEYS = frozenset({"order_id", "loc_id", "qty", "ready_t"})
_EVENT_KEYS = frozenset({"actor", "loc_as_node", "meta_fields", "emit"})
_CALIB_KEYS = frozenset({"min_samples", "series"})
_SERIES_KEYS = frozenset({"start", "end", "column", "unit", "candidates", "min_s", "max_s"})

_UNIT_SECONDS = {"s": 1.0, "sec": 1.0, "second": 1.0, "min": 60.0, "minute": 60.0, "h": 3600.0,
                 "hour": 3600.0, "ms": 0.001}


class MappingError(ValueError):
    """mapping.yaml is malformed or internally inconsistent."""


def _reject_unknown(obj: dict, allowed: frozenset[str], where: str) -> None:
    unknown = sorted(set(obj) - allowed)
    if unknown:
        raise MappingError(f"{where}: unknown key(s) {unknown}; allowed {sorted(allowed)}")


@dataclass(frozen=True)
class SeriesSpec:
    name: str
    start: str | None = None
    end: str | None = None
    column: str | None = None
    unit: str = "s"
    candidates: tuple[str, ...] = ("lognorm", "gamma", "expon")
    min_s: float = 0.0
    max_s: float | None = None

    @property
    def unit_factor(self) -> float:
        return _UNIT_SECONDS[self.unit]


@dataclass(frozen=True)
class EmitSpec:
    type: str
    time: str


@dataclass
class Mapping:
    path: Path
    raw: dict[str, Any]
    source: str
    sheet: Any
    header_row: Any
    csv_encoding: str
    csv_delimiter: str
    columns: dict[str, list[str]]
    required: list[str]
    normalize: dict[str, dict[str, Any]]
    masters: dict[str, dict[str, Any]]
    time_formats: list[str]
    t0_mode: str
    t0_fixed: str | None
    ndigits: int
    orders: dict[str, str | None]
    event_actor: str | None
    loc_as_node: bool
    event_meta_fields: list[str]
    emit: list[EmitSpec]
    calib_min_samples: int
    series: list[SeriesSpec] = field(default_factory=list)

    @property
    def base_dir(self) -> Path:
        return self.path.parent

    def resolve(self, relative: str) -> Path:
        p = Path(relative)
        return p if p.is_absolute() else (self.base_dir / p)

    def time_fields(self) -> list[str]:
        """Every column key whose values are wall clocks."""
        out: list[str] = []
        for spec in self.emit:
            out.append(spec.time)
        for s in self.series:
            out.extend(x for x in (s.start, s.end) if x)
        ready = self.orders.get("ready_t")
        if ready:
            out.append(ready)
        seen: dict[str, None] = {}
        for name in out:
            seen.setdefault(name, None)
        return list(seen)


def load_mapping(path: str | Path) -> Mapping:
    path = Path(path)
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise MappingError(f"{path}: top level must be a mapping")
    _reject_unknown(data, _TOP_KEYS, str(path))

    version = data.get("version", 1)
    if version != 1:
        raise MappingError(f"{path}: unsupported mapping version {version!r} (expected 1)")

    inp = data.get("input") or {}
    _reject_unknown(inp, _INPUT_KEYS, "input")
    csv_cfg = inp.get("csv") or {}
    _reject_unknown(csv_cfg, _CSV_KEYS, "input.csv")

    columns_raw = data.get("columns") or {}
    if not isinstance(columns_raw, dict) or not columns_raw:
        raise MappingError("columns: at least one field -> column-name mapping is required")
    columns: dict[str, list[str]] = {}
    for key, value in columns_raw.items():
        names = [value] if isinstance(value, str) else list(value or [])
        if not names:
            raise MappingError(f"columns.{key}: needs at least one source column name")
        columns[str(key)] = [str(n) for n in names]

    normalize = data.get("normalize") or {}
    for fieldname, rule in normalize.items():
        _reject_unknown(rule or {}, _NORMALIZE_KEYS, f"normalize.{fieldname}")

    masters = data.get("masters") or {}
    for fieldname, spec in masters.items():
        spec = spec or {}
        _reject_unknown(spec, _MASTER_KEYS, f"masters.{fieldname}")
        if "file" not in spec:
            raise MappingError(f"masters.{fieldname}: 'file' is required")
        on_unknown = spec.get("on_unknown", "error_table")
        if on_unknown not in ("error_table", "keep", "drop"):
            raise MappingError(
                f"masters.{fieldname}.on_unknown: must be error_table | keep | drop"
            )

    time_cfg = data.get("time") or {}
    _reject_unknown(time_cfg, _TIME_KEYS, "time")
    t0_mode = time_cfg.get("t0", "auto_min")
    if t0_mode not in ("auto_min", "fixed"):
        raise MappingError("time.t0: must be auto_min | fixed")
    if t0_mode == "fixed" and not time_cfg.get("t0_fixed"):
        raise MappingError("time.t0 = fixed requires time.t0_fixed")

    orders_cfg = data.get("orders") or {}
    _reject_unknown(orders_cfg, _ORDER_KEYS, "orders")
    orders = {
        "order_id": orders_cfg.get("order_id", "order_id"),
        "loc_id": orders_cfg.get("loc_id", "loc_id"),
        "qty": orders_cfg.get("qty", "qty"),
        "ready_t": orders_cfg.get("ready_t"),
    }

    events_cfg = data.get("events") or {}
    _reject_unknown(events_cfg, _EVENT_KEYS, "events")
    emit: list[EmitSpec] = []
    for i, item in enumerate(events_cfg.get("emit") or []):
        _reject_unknown(item, frozenset({"type", "time"}), f"events.emit[{i}]")
        etype = item.get("type")
        if etype not in CORE_EVENT_TYPES and not str(etype).startswith("x_"):
            raise MappingError(
                f"events.emit[{i}].type: {etype!r} is neither a contract core type "
                f"{list(CORE_EVENT_TYPES)} nor an x_-prefixed extension"
            )
        if "time" not in item:
            raise MappingError(f"events.emit[{i}]: 'time' (a key of columns:) is required")
        emit.append(EmitSpec(type=str(etype), time=str(item["time"])))

    calib_cfg = data.get("calibration") or {}
    _reject_unknown(calib_cfg, _CALIB_KEYS, "calibration")
    series: list[SeriesSpec] = []
    for name, spec in (calib_cfg.get("series") or {}).items():
        spec = spec or {}
        _reject_unknown(spec, _SERIES_KEYS, f"calibration.series.{name}")
        if not str(name).endswith("_s"):
            raise MappingError(
                f"calibration.series.{name}: contract §8 series names carry their unit "
                f"(e.g. pick_time_s), so the name must end with '_s'"
            )
        has_pair = bool(spec.get("start") and spec.get("end"))
        if not has_pair and not spec.get("column"):
            raise MappingError(
                f"calibration.series.{name}: needs either start+end or a duration column"
            )
        unit = str(spec.get("unit", "s"))
        if unit not in _UNIT_SECONDS:
            raise MappingError(
                f"calibration.series.{name}.unit: {unit!r} not in {sorted(_UNIT_SECONDS)}"
            )
        series.append(
            SeriesSpec(
                name=str(name),
                start=spec.get("start"),
                end=spec.get("end"),
                column=spec.get("column"),
                unit=unit,
                candidates=tuple(spec.get("candidates") or ("lognorm", "gamma", "expon")),
                min_s=float(spec.get("min_s", 0.0)),
                max_s=None if spec.get("max_s") is None else float(spec["max_s"]),
            )
        )

    mapping = Mapping(
        path=path,
        raw=data,
        source=str(data.get("source") or path.stem),
        sheet=inp.get("sheet", 0),
        header_row=inp.get("header_row", "auto"),
        csv_encoding=str(csv_cfg.get("encoding", "utf-8-sig")),
        csv_delimiter=str(csv_cfg.get("delimiter", ",")),
        columns=columns,
        required=[str(x) for x in (data.get("required") or ["order_id", "loc_id", "qty"])],
        normalize={str(k): dict(v or {}) for k, v in normalize.items()},
        masters={str(k): dict(v or {}) for k, v in masters.items()},
        time_formats=[str(f) for f in (time_cfg.get("formats") or [])],
        t0_mode=t0_mode,
        t0_fixed=time_cfg.get("t0_fixed"),
        ndigits=int(time_cfg.get("ndigits", 3)),
        orders=orders,
        event_actor=events_cfg.get("actor"),
        loc_as_node=bool(events_cfg.get("loc_as_node", False)),
        event_meta_fields=[str(x) for x in (events_cfg.get("meta_fields") or [])],
        emit=emit,
        calib_min_samples=int(calib_cfg.get("min_samples", 20)),
        series=series,
    )
    _check_references(mapping)
    return mapping


def _check_references(m: Mapping) -> None:
    """Every field key referenced elsewhere must be declared under columns:."""
    known = set(m.columns)
    problems: list[str] = []

    def need(key: str | None, where: str) -> None:
        if key and key not in known:
            problems.append(f"{where} refers to {key!r} which is not declared under columns:")

    for key in m.required:
        need(key, "required")
    for key in m.normalize:
        need(key, f"normalize.{key}")
    for key in m.masters:
        need(key, f"masters.{key}")
    for role, key in m.orders.items():
        need(key, f"orders.{role}")
    need(m.event_actor, "events.actor")
    for key in m.event_meta_fields:
        need(key, "events.meta_fields")
    for spec in m.emit:
        need(spec.time, f"events.emit[{spec.type}].time")
    for s in m.series:
        need(s.start, f"calibration.series.{s.name}.start")
        need(s.end, f"calibration.series.{s.name}.end")
        need(s.column, f"calibration.series.{s.name}.column")
    if problems:
        raise MappingError("; ".join(problems))
