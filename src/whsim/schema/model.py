"""Canonical warehouse-model schema (the single source of truth / the contract).

Every component in the system -- templates, the ZIP importer, the SimPy engine,
the KPI layer and the 2D/3D renderers -- reads and writes this one structure.
Because every field has a default, a model assembled from a template alone is
always valid and always runnable: the "never blocks on missing data" rule is
enforced here, by construction.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "0.1"

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


class Zone(BaseModel):
    id: str = "zone"
    type: ZoneType = "storage"
    x: float = 0.0
    y: float = 0.0
    w: float = 10.0
    h: float = 10.0
    color: str | None = None
    rack: RackFill | None = None  # storage zones only; None => not auto-racked


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
    routes: list[Route] = Field(default_factory=list)  # manual flow-line studies
    # measured shelf-to-shelf distances (sparse), keyed "fromLocId|toLocId" -> metres
    distance_overrides: dict[str, float] = Field(default_factory=dict)

    def item_by_sku(self) -> dict[str, Item]:
        return {it.sku: it for it in self.items}

    def location_by_id(self) -> dict[str, Location]:
        return {loc.id: loc for loc in self.locations}


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
