"""Canonical warehouse-model schema (the single source of truth / the contract).

Every component in the system -- templates, the ZIP importer, the SimPy engine,
the KPI layer and the 2D/3D renderers -- reads and writes this one structure.
Because every field has a default, a model assembled from a template alone is
always valid and always runnable: the "never blocks on missing data" rule is
enforced here, by construction.
"""

from __future__ import annotations

import math
import re as _re
from typing import Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "0.1"


# --- tolerant coercion helpers ---------------------------------------------
# Customer exports are messy: numbers arrive as strings ("12", "3.5 m",
# "1,234"), counts arrive negative, ratios out of range. The load-bearing rule
# is "never reject imported data" -- so the IMPORT path (and only the import
# path) coerces such values to sane numbers via WarehouseModel.coerce_messy().
#
# These are deliberately NOT pydantic field validators: keeping the schema
# strict by default means the interactive editor (web /apply, /headline) still
# gets a clean validation error for a genuinely bad hand-typed value, instead
# of silently swallowing it. Coercion is a property of importing a file, not of
# the type itself.
def _to_float(v, default: float = 0.0) -> float:
    """Coerce a messy scalar to float; fall back to `default` (never raise)."""
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else default
    if isinstance(v, str):
        s = v.strip().replace(",", "").replace("　", "")
        m = _re.match(r"[-+]?[0-9]*\.?[0-9]+", s)
        if m:
            try:
                f = float(m.group(0))
                return f if math.isfinite(f) else default
            except ValueError:
                return default
    return default


def _to_int(v, default: int = 0) -> int:
    return int(round(_to_float(v, float(default))))

ABCClass = Literal["A", "B", "C"]
ZoneType = Literal[
    "receiving", "storage", "picking", "packing", "shipping", "staging"
]
PickStrategy = Literal["discrete", "batch", "zone", "wave"]
RoutingPolicy = Literal["s_shape", "return", "nearest"]


class Units(BaseModel):
    length: str = "m"
    time: str = "s"
    weight: str = "kg"


class Meta(BaseModel):
    schema_version: str = SCHEMA_VERSION
    project_id: str = ""
    name: str = "untitled"
    units: Units = Field(default_factory=Units)


class Bounds(BaseModel):
    width: float = 80.0  # meters (x)
    depth: float = 40.0  # meters (y)


class RackFill(BaseModel):
    """Parametric rack layout for a storage zone: the editor sets spacing, and
    `design.materialize_racks` regenerates the locations grid to fill the zone."""

    col_spacing: float = 4.0   # meters between rack columns (aisles)
    row_spacing: float = 3.0   # meters between slots along a column
    margin: float = 2.0        # inset from the zone edge


class ShelfArea(BaseModel):
    """An authored SHELF block (MapMaker-style): a rectangle the user draws (or
    imports) inside a storage zone, subdivided into rack cells. Locations are
    generated *inside* shelf areas, so a storage zone with no shelves (and no
    `rack`) has no locations until one is drawn — racks come from the layout,
    not from thin air."""

    id: str = "s"
    x: float = 0.0
    y: float = 0.0
    w: float = 2.0
    h: float = 10.0
    rack_type: str = "medium"  # storage-equipment preset (whsim.racktypes)
    cell_w: float | None = None  # override bay pitch (m); None => from rack_type
    cell_d: float | None = None  # override depth pitch (m); None => from rack_type


class Zone(BaseModel):
    id: str = "zone"
    type: ZoneType = "storage"
    x: float = 0.0
    y: float = 0.0
    w: float = 10.0
    h: float = 10.0
    color: str | None = None
    rack: RackFill | None = None  # storage zones only; None => not auto-racked
    shelves: list[ShelfArea] = Field(default_factory=list)  # authored SHELF blocks


class Wall(BaseModel):
    """A building wall segment (躯体). Points are a polyline in meters."""

    id: str = "w"
    points: list[list[float]] = Field(default_factory=list)  # [[x,y], ...]
    thickness: float = 0.2


class Door(BaseModel):
    """A door / dock opening on the building shell."""

    id: str = "d"
    type: Literal["dock", "personnel", "shutter"] = "dock"
    x: float = 0.0
    y: float = 0.0
    w: float = 3.0


class Layout(BaseModel):
    bounds: Bounds = Field(default_factory=Bounds)
    zones: list[Zone] = Field(default_factory=list)
    walls: list[Wall] = Field(default_factory=list)
    doors: list[Door] = Field(default_factory=list)


class Location(BaseModel):
    id: str = "loc"
    zone: str = "storage"
    x: float = 0.0
    y: float = 0.0
    type: Literal["pallet", "shelf", "bin", "floor"] = "shelf"
    rack_type: str = "medium"  # storage-equipment preset (whsim.racktypes)
    capacity: int = 100
    sku: str | None = None
    qty: int = 0


class Item(BaseModel):
    sku: str = ""
    name: str = ""
    abc_class: ABCClass = "C"
    pick_freq: float = 0.0  # relative pick frequency weight (demand share)
    ts_per_unit: float = 1.5  # handling seconds per unit
    case_qty: int = 1
    stock: int = 0            # on-hand inventory (units) from loaded data, for slotting
    default_location: str | None = None


StageMethod = Literal["manual", "agv", "conveyor", "asrs"]

# --- Work-method design, generalized to 5 orthogonal axes -------------------
# The dozen named picking "methods" (single / batch / multi-order / zone / wave
# / total-sort / goods-to-person ...) are not distinct things: they are
# combinations of a few orthogonal axes (cf. de Koster et al.'s order-picking
# taxonomy). whsim configures the axes and reverse-derives the familiar name,
# so a non-expert turns intuitive knobs while an expert still recognises the
# result. See docs/WORK_METHOD_DESIGN.md.
Transport = Literal["manual", "agv", "conveyor", "asrs"]  # A: who moves
Zoning = Literal["none", "sequential", "parallel"]         # C: area split
Consolidation = Literal["pick", "sort"]                    # D: 摘み取り / 種まき
Release = Literal["continuous", "wave"]                    # E: when released


class WorkMethod(BaseModel):
    """The 5-axis generalization of a picking/work method (the minimal common
    parameter set). Every axis has a default, so it is always runnable."""

    transport: Transport = "manual"        # A 誰が運ぶ: 人が歩く / 物が来る
    orders_per_trip: int = 1               # B まとめ度: 1トリップに集約するオーダー数
    zoning: Zoning = "none"                # C ゾーン分担: 全域 / 逐次 / 並列
    consolidation: Consolidation = "pick"  # D 採り方: 摘み取り / 種まき(後仕分け)
    release: Release = "continuous"        # E 投入: 連続 / ウェーブ
    wave_interval_s: float = 1800.0        # ウェーブ締め間隔 (release == "wave")


class Stage(BaseModel):
    """One step of the operation flow, shown in the editor's workflow strip and
    pinned to a zone on the floor plan (`zone`) so flow can be drawn spatially."""

    id: str = "stage"
    label: str = ""
    method: StageMethod = "manual"          # legacy per-stage transport (kept)
    zone: str | None = None                 # geographic binding (zone id) for spatial flow
    work: WorkMethod | None = None          # 5-axis work design (pick stage; optional)


def _default_stages() -> list["Stage"]:
    return [
        Stage(id="receive", label="入荷", method="manual", zone="receiving"),
        Stage(id="putaway", label="格納", method="manual", zone="storage"),
        Stage(id="pick", label="ピッキング", method="manual", zone="picking"),
        Stage(id="pack", label="梱包", method="manual", zone="packing"),
        Stage(id="ship", label="出荷", method="manual", zone="shipping"),
    ]


class Process(BaseModel):
    flow: list[str] = Field(
        default_factory=lambda: ["receive", "putaway", "pick", "pack", "ship"]
    )
    stages: list[Stage] = Field(default_factory=_default_stages)
    pick_strategy: PickStrategy = "discrete"
    routing_policy: RoutingPolicy = "nearest"
    batch_size: int = 1
    walk_speed_mps: float = 1.2
    pack_time_s: float = 40.0  # mean packing seconds per order
    sort_time_s: float = 6.0   # 種まき(consolidation=="sort"): seconds to put one line at the wall

    def pick_stage(self) -> "Stage | None":
        for s in self.stages:
            if s.id == "pick":
                return s
        return None

    def pick_method(self) -> str:
        s = self.pick_stage()
        if s is not None and s.work is not None:
            return s.work.transport
        return s.method if s is not None else "manual"

    def effective_work(self) -> "WorkMethod":
        """The pick stage's 5-axis work design. If it isn't set explicitly,
        derive it from the legacy pick_strategy/batch_size/method so old models
        (and the engine) keep working unchanged."""
        s = self.pick_stage()
        if s is not None and s.work is not None:
            return s.work
        transport = s.method if s is not None else "manual"
        strat = self.pick_strategy
        return WorkMethod(
            transport=transport,
            orders_per_trip=max(1, self.batch_size) if strat != "discrete" else 1,
            zoning="sequential" if strat == "zone" else "none",
            consolidation="pick",
            release="wave" if strat == "wave" else "continuous",
        )


class WorkerGroup(BaseModel):
    id: str = "pickers"
    role: Literal["picker", "packer"] = "picker"
    count: int = 6
    speed_mps: float = 1.2
    labour_rate_per_hr: float = 2200.0  # ¥/person-hour (JP warehouse default)


class Equipment(BaseModel):
    id: str = "equip"
    type: Literal["agv", "forklift", "asrs", "robot_arm", "crane"] = "agv"
    count: int = 0
    speed_mps: float = 1.6
    capacity: int = 1
    x: float = 0.0  # home / dock position (for placement on the layout)
    y: float = 0.0
    capex_each: float = 4000000.0  # ¥ per unit (AGV default ~4M JPY)
    opex_per_hr: float = 150.0     # ¥/hr per unit (power, maintenance)


class Conveyor(BaseModel):
    id: str = "conveyor"
    points: list[list[float]] = Field(default_factory=list)  # [[x,y], ...]
    speed_mps: float = 0.5


class Station(BaseModel):
    id: str = "pack"
    zone: str = "packing"
    x: float = 5.0
    y: float = 5.0
    count: int = 3


class Resources(BaseModel):
    workers: list[WorkerGroup] = Field(default_factory=lambda: [WorkerGroup()])
    equipment: list[Equipment] = Field(default_factory=list)
    conveyors: list[Conveyor] = Field(default_factory=list)
    stations: list[Station] = Field(default_factory=lambda: [Station()])


class OrderLine(BaseModel):
    sku: str = ""
    qty: int = 1


class Order(BaseModel):
    order_id: str = ""
    arrival_s: float = 0.0
    due_s: float | None = None
    lines: list[OrderLine] = Field(default_factory=list)


class OrderProfile(BaseModel):
    """Fallback demand generator used when explicit outbound orders are absent."""

    arrival: Literal["poisson"] = "poisson"
    rate_per_hr: float = 120.0
    lines_per_order_mean: float = 3.0
    peak_factor: float = 1.0  # demand multiplier for peak-day scenarios (e.g. sale)


class Orders(BaseModel):
    outbound: list[Order] = Field(default_factory=list)
    inbound: list[Order] = Field(default_factory=list)
    profile: OrderProfile = Field(default_factory=OrderProfile)


class Simulation(BaseModel):
    duration_s: float = 28800.0  # 8h shift
    warmup_s: float = 0.0
    random_seed: int = 42
    replications: int = 1
    heatmap_grid_m: float = 1.0
    currency: str = "¥"
    amortize_capex_months: int = 36  # spread equipment capex over N months
    work_days_per_month: int = 25    # to scale a one-shift run to a monthly cost
    shift_hours_per_day: float = 8.0  # a work-day's length; makes cost robust to duration


class Settings(BaseModel):
    """First-class cost / operations settings.

    The backend and frontend code against these exact field names. Every field
    is defaulted with sensible Japanese-market values, so a model assembled from
    a template alone is always valid and always costable ("never blocks on
    missing data"). The KPI layer reads cost inputs from here (see kpis.py).
    """

    currency: str = "¥"
    labor_cost_per_hour: float = 2000.0   # ¥/person-hour (JP warehouse default)
    working_hours_per_day: float = 8.0    # a work-day's length (one shift)
    working_days_per_month: float = 22.0  # operating days per month
    agv_cost_per_month: float = 80000.0   # ¥/month per AGV (lease + power + maint.)


class Scenario(BaseModel):
    """A named what-if: dotted-path edits applied over the base model."""

    name: str = ""
    description: str = ""
    edits: dict = Field(default_factory=dict)  # {"orders.profile.peak_factor": 3.0, ...}


class Route(BaseModel):
    """A manually-drawn flow line for distance/time study (Logi3D-style 動線)."""

    id: str = "r"
    name: str = ""
    mover: Literal["person", "forklift"] = "person"
    speed_mps: float = 1.2
    points: list[list[float]] = Field(default_factory=list)  # [[x,y], ...]


class WarehouseModel(BaseModel):
    """The whole world, in one document."""

    meta: Meta = Field(default_factory=Meta)
    layout: Layout = Field(default_factory=Layout)
    locations: list[Location] = Field(default_factory=list)
    items: list[Item] = Field(default_factory=list)
    process: Process = Field(default_factory=Process)
    resources: Resources = Field(default_factory=Resources)
    orders: Orders = Field(default_factory=Orders)
    simulation: Simulation = Field(default_factory=Simulation)
    settings: Settings = Field(default_factory=Settings)  # first-class cost/ops settings
    routes: list[Route] = Field(default_factory=list)  # manual flow-line studies
    # measured shelf-to-shelf distances (sparse), keyed "fromLocId|toLocId" -> metres
    distance_overrides: dict[str, float] = Field(default_factory=dict)

    def item_by_sku(self) -> dict[str, Item]:
        return {it.sku: it for it in self.items}

    def location_by_id(self) -> dict[str, Location]:
        return {loc.id: loc for loc in self.locations}

    def coerce_messy(self) -> list[str]:
        """Clamp/repair messy numeric fields that survived validation.

        Applied on the IMPORT path only (see module note). pydantic already
        parsed numeric strings like "12" into ints/floats; this pass fixes the
        values it cannot reason about: negative counts/dimensions, zero or
        negative speeds/durations that would divide-by-zero or silence the sim,
        and out-of-range ratios. It never raises and never drops data; it
        returns Japanese warnings describing every clamp.
        """
        w: list[str] = []

        def clamp_f(obj, attr, lo, label, hint=""):
            cur = getattr(obj, attr)
            new = _to_float(cur, lo)
            if new < lo:
                new = lo
            if new != cur:
                setattr(obj, attr, new)
                w.append(f"{label}を {cur} から {new} に補正しました{hint}。")

        def clamp_i(obj, attr, lo, label):
            cur = getattr(obj, attr)
            new = _to_int(cur, lo)
            if new < lo:
                new = lo
            if new != cur:
                setattr(obj, attr, new)
                w.append(f"{label}を {cur} から {new} に補正しました。")

        clamp_f(self.layout.bounds, "width", 0.0, "建屋幅")
        clamp_f(self.layout.bounds, "depth", 0.0, "建屋奥行")

        for it in self.items:
            clamp_f(it, "pick_freq", 0.0, f"商品{it.sku}のピック頻度")
            clamp_f(it, "ts_per_unit", 0.0, f"商品{it.sku}の処理時間")
            clamp_i(it, "case_qty", 1, f"商品{it.sku}のケース入数")
            clamp_i(it, "stock", 0, f"商品{it.sku}の在庫")

        for lc in self.locations:
            clamp_i(lc, "capacity", 0, f"ロケーション{lc.id}の収容数")
            clamp_i(lc, "qty", 0, f"ロケーション{lc.id}の在庫数")

        for grp in self.resources.workers:
            clamp_i(grp, "count", 0, "作業者数")
            clamp_f(grp, "speed_mps", 0.1, "作業者の歩行速度", "（0以下は不可）")
            clamp_f(grp, "labour_rate_per_hr", 0.0, "人件費単価")
        for eq in self.resources.equipment:
            clamp_i(eq, "count", 0, "設備台数")
            clamp_i(eq, "capacity", 0, "設備の積載数")
            clamp_f(eq, "speed_mps", 0.1, "設備の速度", "（0以下は不可）")
        for st in self.resources.stations:
            clamp_i(st, "count", 1, "ステーション数")

        clamp_i(self.process, "batch_size", 1, "バッチサイズ")
        clamp_f(self.process, "walk_speed_mps", 0.1, "歩行速度", "（0以下は不可）")
        clamp_f(self.process, "pack_time_s", 0.0, "梱包時間")
        clamp_f(self.process, "sort_time_s", 0.0, "仕分け時間")

        prof = self.orders.profile
        clamp_f(prof, "rate_per_hr", 0.0, "オーダー到着率")
        clamp_f(prof, "lines_per_order_mean", 0.0, "平均オーダー行数")
        clamp_f(prof, "peak_factor", 0.0, "ピーク係数")

        sim = self.simulation
        clamp_f(sim, "duration_s", 1.0, "シミュレーション時間", "（最低1秒）")
        clamp_f(sim, "warmup_s", 0.0, "ウォームアップ時間")
        clamp_f(sim, "heatmap_grid_m", 0.1, "ヒートマップ格子")
        clamp_f(sim, "shift_hours_per_day", 0.1, "1日の稼働時間")
        clamp_i(sim, "replications", 1, "反復回数")
        clamp_i(sim, "amortize_capex_months", 1, "償却月数")
        clamp_i(sim, "work_days_per_month", 1, "月間稼働日数")

        for o in self.orders.outbound + self.orders.inbound:
            clamp_f(o, "arrival_s", 0.0, f"オーダー{o.order_id}の到着時刻")
            for ln in o.lines:
                clamp_i(ln, "qty", 1, f"オーダー{o.order_id}の数量")

        return w

    def normalize_ids(self) -> list[str]:
        """Auto-assign stable unique identifiers for blank/duplicate keys.

        KNOWN DEFECT this fixes: downstream code builds dict maps keyed by
        ``Zone.id`` / ``Location.id`` / ``Item.sku`` / ``Order.order_id``. When
        those keys are blank or duplicated, later entries silently overwrite
        earlier ones, so whole zones/SKUs/orders vanish from the simulation.

        Rather than dropping data we make every key present and unique here, at
        the data layer: blanks get a stable synthetic id (``zone-1``,
        ``loc-000007``, ``sku-000012`` ...), and collisions get a ``-2`` suffix.
        Cross-references are repaired so nothing is orphaned:

        * ``Location.sku`` -> renamed ``Item.sku`` (only when an item carried the
          old sku; an unknown sku reference is left untouched).
        * ``Item.default_location`` -> renamed ``Location.id``.
        * ``OrderLine.sku`` -> renamed ``Item.sku``.

        Returns a list of human-readable (Japanese) warnings describing every
        rename, intended to be surfaced as import warnings -- never a silent
        mutation.
        """
        warnings: list[str] = []

        def _unique(items, get, set_, prefix: str, label: str, width: int = 0):
            seen: set[str] = set()
            remap: dict[int, tuple[str, str]] = {}  # index -> (old, new)
            for i, it in enumerate(items):
                raw = get(it)
                old = raw.strip() if isinstance(raw, str) else (raw or "")
                if not old:
                    n = i + 1
                    new = f"{prefix}{n:0{width}d}" if width else f"{prefix}{n}"
                else:
                    new = old
                if new in seen:
                    base = new
                    k = 2
                    while f"{base}-{k}" in seen:
                        k += 1
                    new = f"{base}-{k}"
                if new != old:
                    if not old:
                        warnings.append(
                            f"{label}のIDが空欄だったため '{new}' を自動採番しました。"
                        )
                    else:
                        warnings.append(
                            f"{label}のID '{old}' が重複していたため '{new}' に変更しました。"
                        )
                    remap[i] = (old, new)
                seen.add(new)
                set_(it, new)
            return remap

        _unique(
            self.layout.zones,
            lambda z: z.id, lambda z, v: setattr(z, "id", v),
            "zone-", "ゾーン",
        )

        loc_remap = _unique(
            self.locations,
            lambda lc: lc.id, lambda lc, v: setattr(lc, "id", v),
            "loc-", "ロケーション", width=6,
        )
        final_loc_ids = {lc.id for lc in self.locations}

        sku_remap = _unique(
            self.items,
            lambda it: it.sku, lambda it, v: setattr(it, "sku", v),
            "sku-", "商品", width=6,
        )
        final_skus = {it.sku for it in self.items}

        # Only remap a reference when its old key no longer resolves to a real
        # entry. For duplicate ids the FIRST holder keeps the original key, so a
        # reference to that key is still valid and must NOT be redirected to the
        # renamed duplicate. (Blank-origin renames have old == "" and never
        # match a reference.)
        loc_old_to_new = {
            old: new for old, new in loc_remap.values()
            if old and old not in final_loc_ids
        }
        sku_old_to_new = {
            old: new for old, new in sku_remap.values()
            if old and old not in final_skus
        }

        _unique(
            self.orders.outbound,
            lambda o: o.order_id, lambda o, v: setattr(o, "order_id", v),
            "out-", "出荷オーダー", width=6,
        )
        _unique(
            self.orders.inbound,
            lambda o: o.order_id, lambda o, v: setattr(o, "order_id", v),
            "in-", "入荷オーダー", width=6,
        )

        # Repair cross-references broken by the renames above.
        if loc_old_to_new:
            for it in self.items:
                if it.default_location in loc_old_to_new:
                    it.default_location = loc_old_to_new[it.default_location]
        if sku_old_to_new:
            for lc in self.locations:
                if lc.sku in sku_old_to_new:
                    lc.sku = sku_old_to_new[lc.sku]
            for o in self.orders.outbound + self.orders.inbound:
                for ln in o.lines:
                    if ln.sku in sku_old_to_new:
                        ln.sku = sku_old_to_new[ln.sku]

        return warnings


# Subtrees the importer recognises from dropped files (filename hints below).
MERGEABLE_SUBTREES: tuple[str, ...] = (
    "meta",
    "layout",
    "locations",
    "items",
    "process",
    "resources",
    "orders",
    "simulation",
)
