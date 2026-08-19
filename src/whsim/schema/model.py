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
RoutingPolicy = Literal["s_shape", "return", "largest_gap", "nearest", "optimized"]


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
    name: str = ""            # human shelf/run name (MapMaker "100-01-09"); seeds location names
    x: float = 0.0
    y: float = 0.0
    w: float = 2.0
    h: float = 10.0
    rack_type: str = "medium"  # storage-equipment preset (whsim.racktypes)
    facing: Literal["up", "down", "left", "right"] = "down"  # 間口 (pick face) direction
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
    name: str = ""            # addressable location name (from the shelf/run it sits in)
    # Structured human 棚番号 (location address). Generated deterministically by
    # design.materialize_racks of the form 通路-連-段 (aisle-bay-level), e.g.
    # "A03-12-2". Stable across a re-materialize so slotting / pick-sequence can
    # rely on it as a sort key. Empty only for legacy/hand-authored locations.
    address: str = ""
    # 段 (rack level), 1 = bottom shelf. A pallet bay (rack_type.levels == 4)
    # materialises 4 stacked locations sharing one (x,y) at level 1..4, with the
    # bay capacity divided across levels. Default 1 keeps single-level models valid.
    level: int = 1
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


#: How goods move along a flow edge. A SUPERSET of ``StageMethod``: the DES
#: currently changes its behaviour for ``conveyor`` and ``agv`` only, while
#: ``forklift``/``asrs`` are recorded, drawn and diagnosed but leave the run
#: unchanged (an explicit extension point, not a silent no-op).
TransportMeans = Literal["manual", "conveyor", "agv", "forklift", "asrs"]


class WorkProcess(BaseModel):
    """An editable work-process row driving the 人員タイムチャート / 原価 / 生産性 stack.

    Empty `Process.work_processes` ⇒ the engine's default 6-process 3PL flow
    (see staffing.GENERIC_PROCESSES). A project can add / rename / reorder / delete
    these to model its real operation. `driver` names the volume source
    (in_lines / in_qty / out_lines / out_orders); `prod` is the engine-default
    productivity (units/person/hour, the 3rd tier under 実測>想定); `depends` lists
    upstream process ids (the precedence DAG). Every field defaulted → never blocks."""

    id: str = "工程"
    section: str = "出荷"                 # band grouping (入荷 / 出荷 / …); colours the gantt
    driver: str = "out_lines"            # volume source: in_lines/in_qty/out_lines/out_orders
    prod: float = 60.0                   # engine-default productivity (units/person/hour)
    unit: str = "行/h"
    depends: list[str] = Field(default_factory=list)  # upstream process ids
    # --- bindings that let this master be the ONE flow graph ------------------
    # `role` maps a (freely named) business process onto the engine's simulated
    # behaviour; "" = infer from the id, "none" = staffing/cost only, never
    # simulated. `zone` pins it to the floor, mirroring Stage.zone.
    role: str = ""
    zone: str = ""


class LoadUnit(BaseModel):
    """One 荷姿 — a container or a carrier goods ride in on their way through.

    The thing SLC makes you fill in a giant materials table for, before anything
    runs. Here the catalogue ships with sane defaults (see ``loadunit.py``) so a
    project that never opens it behaves exactly as it did, and a salesperson
    edits an 入数 in place on the flow edge that uses it.

    ``capacity`` is a CHAIN, keyed by the id of what it holds::

        オリコン  capacity={"piece": 30}          # 30 points fit in one 折コン
        カゴ台車  capacity={"orikon": 14, "case": 14}
        パレット  capacity={"case": 40}

    A carrier that accepts several kinds is filled by OCCUPANCY (Σ count/cap),
    so a mixed load of 折コン and cases lands on the same number of cages the
    old flat 「(OC+ケース)÷14」 approximation gave — that formula is this one
    with both capacities equal.

    ``footprint_m2`` is the floor a single unit occupies while it waits; it is
    what turns a 滞留 count into 仮置き坪数.
    """

    id: str = "unit"
    name: str = ""                       # 表示名 ("" ⇒ fall back to id)
    kind: Literal["container", "carrier", "pallet", "base"] = "container"
    capacity: dict[str, float] = Field(default_factory=dict)
    footprint_m2: float = 0.0
    #: Editable 入数 are assumptions, not measurements — surfaced as 仮値 in the UI.
    provisional: bool = True


class FlowEdge(BaseModel):
    """ONE 物の流れ between two work processes — the connection layer.

    whsim used to describe the same warehouse three times over: the process DAG
    (``WorkProcess.depends``, ②マテリアルフロー), the spatial stage list
    (``Process.stages``, ③フロー) and the physical objects (``Resources``), with
    NO shared identity between them. So "this packing step is fed by THAT belt"
    had nowhere to live, and the engine fell back to picking the geometrically
    nearest conveyor — which is why switching a stage to 人手 did not stop the
    belt from being used.

    An edge is where that decision now lives:

    * ``transport``     — how goods move on this leg (人手/コンベア/AGV/…).
    * ``equipment_ref`` — WHICH physical instance carries it (a ``Conveyor.id``
      or ``Equipment.id``). Empty = "any of that type", the pre-edge behaviour.
    * ``share``         — split ratio when a step feeds several downstreams.

    Every field defaulted, and an empty ``Process.flow_edges`` resolves to the
    graph implied by the existing ``depends`` — so a project that never touches
    this is unchanged (never-blocks).
    """

    id: str = "edge"
    src: str = ""            # upstream work-process id ("" = 外部からの入荷)
    dst: str = ""            # downstream work-process id ("" = 外部への出荷)
    transport: TransportMeans = "manual"
    equipment_ref: str = ""  # Conveyor.id / Equipment.id ("" = unbound)
    share: float = 1.0       # 分岐率 (volume/staffing apportioning; not DES routing)
    # --- 荷姿: what goods are IN, and what they ride ON, over this leg --------
    # Both name a LoadUnit.id ("" = unspecified, which keeps the historical
    # project-wide 仮値 behaviour). A 人手 leg typically carries a carrier
    # (カゴ台車 / 6輪カート); a conveyor leg usually has a container only.
    container_ref: str = ""
    carrier_ref: str = ""


class Process(BaseModel):
    flow: list[str] = Field(
        default_factory=lambda: ["receive", "putaway", "pick", "pack", "ship"]
    )
    stages: list[Stage] = Field(default_factory=_default_stages)
    # Editable work-process master for staffing/cost/productivity. Empty = engine
    # default (staffing.GENERIC_PROCESSES); resolve via staffing.process_master(model).
    work_processes: list[WorkProcess] = Field(default_factory=list)
    # The connection layer between work processes (see FlowEdge). Empty ⇒ derived
    # from `work_processes[].depends`; resolve via `flowgraph.resolve(model)`.
    flow_edges: list[FlowEdge] = Field(default_factory=list)
    pick_strategy: PickStrategy = "discrete"
    routing_policy: RoutingPolicy = "nearest"
    batch_size: int = 1
    walk_speed_mps: float = 1.2
    pack_time_s: float = 40.0  # mean packing seconds per order
    sort_time_s: float = 6.0   # 種まき(consolidation=="sort"): seconds to put one line at the wall
    # 仮置き(staging) buffer between pick and pack. 0 = disabled (legacy: the picker
    # doubles as packer inline). >0 = decouple: pickers drop totes into a finite
    # staging buffer (back-pressure when full) and dedicated packer agents pull from
    # it. Makes pack-stage WIP / blocking explicit (本格DES).
    staging_capacity: int = 0
    # 入荷検品(inbound inspection). 0 = disabled (legacy: receipts go straight to
    # putaway). >0 = dedicated inspector agents inspect each receipt at the dock
    # before forklift putaway (an explicit upstream stage with its own WIP).
    inspector_count: int = 0
    inbound_inspection_time_s: float = 8.0   # seconds to inspect one inbound receipt
    # 在庫補充連鎖 (DES-internal inventory & replenishment). False = disabled
    # (legacy: pick faces have infinite stock, never deplete). When True the
    # engine tracks each slotted pick face's on-hand qty: every pick DECREMENTS
    # it, a face at/below capacity×trigger_frac generates ONE replenishment task
    # (a forklift/replenisher tops it up to capacity×qty_frac), and an EMPTY face
    # BLOCKS the picker until replenished (真の欠品挙動). Off ⇒ byte-identical.
    replenishment_enabled: bool = False
    replenish_trigger_frac: float = 0.3   # face qty ≤ capacity×this ⇒ enqueue a task
    replenish_qty_frac: float = 1.0       # refill the face up to capacity×this
    replenish_place_s: float = 12.0       # seconds to place/top-up a face
    replenishers: int = 0                 # dedicated replenishers (0 = forklifts do it)
    # AGV通路相互排他・簡易干渉モデル. False = disabled (legacy: AGVs never contend for
    # aisle space — byte-identical). When True AND the wall-aware graph is active AND
    # there is more than one AGV, each AGV travel leg seizes a coarse aisle-segment
    # mutex (one AGV per ~3 m stretch), so extra AGVs queue in shared corridors and
    # throughput saturates. Deadlock is DETECTED (a lock wait past ~120 sim-seconds
    # emits a one-shot warning) and escaped by force-proceeding — detection+warning
    # only, no resolution/replanning. Opt-in ⇒ off is byte-identical.
    agv_interference: bool = False
    # 容器の有限循環 (finite container pool). ``None`` (default) = 容器は無限に湧く
    # ＝ the historical behaviour, byte-identical. A dict so a hand-authored model
    # can state it without a nested schema:
    #   ``{"count": 300, "return_belt": "trunk_up", "return_time_s": 60.0}``
    # 折りたたみ容器は無限に湧かない: a load can only be put ON the line inside a
    # container, so an empty pool STOPS 投入 (the picker stands there holding the
    # goods) and the shortage backs up into picking. 確保するのは**コンベアへ投入する
    # 時**だけ — a 人手/AGV leg carries its own containers and is not gated by this
    # pool (it is the LINE's circulating stock that is finite). 梱包完了 empties it,
    # which then rides ``return_belt`` (上段の還流ベルト — geometry only: transit
    # time and the replay track; empty containers do not contend for slots) and is
    # back in the pool ``return_time_s`` later. ``count`` ≤ 0 ⇒ pool disabled.
    # The KPI that pays for this is ``containers_in_use_peak`` (+ its time): the
    # LOWER BOUND on how many containers the operation has to own or rent.
    container_pool: dict | None = None
    # 引き込み方式 (how goods leave the 本線 into a 引き込み/spur).
    #   "auto" (default) — 貪欲ディバート: a load turns into any spur with room,
    #     and stalls on the 本線 when none has (the historical behaviour).
    #   "pull"           — 作業者が引く: nothing diverts by itself. A load is taken
    #     into a spur only where a 梱包台 is FREE as it arrives; otherwise it rides
    #     on (past the pull-in, to the 停止線/末端). So an unmanned 引き込み takes
    #     nothing and the 本線 accumulates — which is what the line really does.
    divert_policy: Literal["auto", "pull"] = "auto"
    # 段(level)からのピック垂直アクセス時間: picking an upper 段 costs vertical time on
    # top of the handle. lift_speed_mps = forklift/order-picker hoist speed (m/s,
    # up+down); manual_reach_s_per_m = the ergonomic reach/ladder penalty per metre
    # of height for hand picking. Rack pitch + who picks come from racktypes.
    lift_speed_mps: float = 0.4
    manual_reach_s_per_m: float = 2.0

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
    type: Literal["agv", "forklift", "asrs", "robot_arm", "crane", "sorter"] = "agv"
    count: int = 0
    speed_mps: float = 1.6
    capacity: int = 1
    x: float = 0.0  # home / dock position (for placement on the layout)
    y: float = 0.0
    capex_each: float = 4000000.0  # ¥ per unit (AGV default ~4M JPY)
    opex_per_hr: float = 150.0     # ¥/hr per unit (power, maintenance)
    # --- Sorter params (type=="sorter"): the トータルピッキング＆店舗別仕分け core.
    # All defaulted (never blocks); ignored for other equipment types. When a
    # sorter is placed and consolidation=="sort", the sort phase becomes an
    # AUTOMATIC piece sorter instead of the manual put-wall (see engine).
    sorter_rate_per_hr: float = 3600.0   # induction+sort capacity (pieces/h per channel)
    chutes: int = 40                      # 出荷先シュート数 (destination chutes)
    chute_capacity: int = 50              # lines a chute holds before it back-pressures
    induction_workers: int = 2            # concurrent induction channels (投入口)
    chute_release_s: float = 30.0         # a sorted line dwells here before the carton is pulled


class Conveyor(BaseModel):
    id: str = "conveyor"
    points: list[list[float]] = Field(default_factory=list)  # [[x,y], ...]
    speed_mps: float = 0.5
    # トレッド高さ (m). ``None`` ⇒ the viewers' historical 0.21 m deck, so every
    # model written before this field renders byte-identically. A **2段駆動コンベア**
    # is two decks over ONE footprint (下段=検品済みの搬送 / 上段=空容器の還流): the
    # replay contract already carries ``conveyors[].elevation_m`` for exactly that
    # (see docs/ARCHITECTURE.md §3), but a saved model had no way to say it, so the
    # upper deck's totes rendered inside the lower belt.
    elevation_m: float | None = None
    # トート間ピッチ (m) — how much belt ONE tote occupies, i.e. the belt's slot
    # count is ``length / tote_pitch_m``. ``None`` ⇒ the engine's historical
    # 1 slot per metre, so every model written before this field accumulates
    # exactly as it did. A pitch is a property of what rides the belt (オリコン
    # なら ~0.45 m, パレットなら ~1.3 m), and it is the ONLY thing that decides how
    # many totes a full line holds — which is what a 引き込み(spur) jam backing up
    # into the 本線 is measured in. Non-positive values fall back to 1 個/m too
    # (never blocks, never divides by zero).
    tote_pitch_m: float | None = None
    # 荷の種別 (load kind) this belt STAMPS on what boards it. One belt can only be
    # fed by one kind of goods (a 検品ライン feeds 検品済み容器, the outfeed of a
    # packing bench feeds 梱包済み completed cartons), so "which belt put it on the
    # line" is what the goods' state actually is. The kind travels WITH the load
    # over every hand-over, and a :attr:`stop_gate` downstream sorts on it.
    # ``""`` (default) = one single kind, i.e. the historical behaviour.
    load_kind: str = ""
    # 選択停止ゲート (停止線): ``None`` (default) = no gate, byte-identical.
    # A dict so a hand-authored model can state it without a nested schema:
    #   ``{"at_m": 24.5, "stop_states": ["inspected"], "pass_states": ["packed"]}``
    # ``at_m`` is the arc length from THIS belt's infeed (clamped to its length).
    # 同じベルトの上を2種類の荷が流れる — 検品済み(梱包前)の容器は停止線で止まって
    # 引き込みを待ち、梱包済みの完成品はそのまま通過してカーブ→積み付けへ行く。The
    # gate is the only thing that can tell them apart, because they are physically
    # on the same belt at the same time. A stopped load holds its slot until someone
    # takes it off the line, so 滞留 propagates upstream exactly like a full 引き込み.
    # Selection is never-blocks: ``stop_states`` names what stops (everything else
    # passes); with only ``pass_states``, everything NOT named stops; a gate that
    # names neither stops nothing.
    stop_gate: dict | None = None


class Station(BaseModel):
    id: str = "pack"
    zone: str = "packing"
    x: float = 5.0
    y: float = 5.0
    count: int = 3
    # 作業台の平面外寸 (m). ``None`` ⇒ the viewers' historical fixed 2.0×0.9 bench,
    # so an unstated station is unchanged. A bench's footprint is not decoration:
    # its LONG side decides where the people stand, so a line of 縦長 benches
    # flanking an 引き込みコンベア cannot be drawn without it (the 3D already reads
    # ``stations[].w`` / ``[].d``; the 2D canvas and the proposal PNG draw a bench
    # as a point and ignore both).
    w: float | None = None   # 幅 (x方向, m)
    d: float | None = None   # 奥行 (y方向, m)
    # 作業台の役割 (`pack` / `inspect` / `bench` / `infeed`, …). ``""`` (default) =
    # 「ただの作業台」＝従来どおり。取込は図面の名前から役割を読めるのに、置き場が
    # 無いと保存時に落ちる — そして後から「梱包台なのか、P2 時代の検品台なのか、
    # ラインへ載せる投入口なのか」を id の文字列で当てにいく羽目になる。
    # エンジンは今のところ役割を見ない（台数は今までどおり全ステーションの合計）ので、
    # これを足しても挙動は 1 バイトも変わらない。
    role: str = ""


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
    # 通路干渉: agents contend for aisle cells (one per direction per cell) and
    # WAIT when another agent is crossing — measured as `aisle_wait` events and
    # congestion KPIs. False (default) = legacy free passage, byte-identical
    # runs; turn on per-scenario. See engine/processes.py for the model and the
    # timeout escape that makes gridlock structurally impossible.
    aisle_interference: bool = False
    currency: str = "¥"
    amortize_capex_months: int = 36  # spread equipment capex over N months
    work_days_per_month: int = 25    # to scale a one-shift run to a monthly cost
    shift_hours_per_day: float = 8.0  # a work-day's length; makes cost robust to duration


class Brand(BaseModel):
    """提案書ブランドテーマ (proposal brand theme).

    Lets the salesperson swap the exported PPTX/PDF proposal's brand so it is
    client-ready ("そのまま出せる"): 宛先/自社名/アクセントカラー/ロゴ. Every field
    defaults, so an unbranded model exports exactly as before ("never blocks on
    missing data"); the default ``accent_color`` matches the built-in accent so a
    default brand re-draws identical colours.
    """

    company_name: str = ""            # 自社名 (提案元) — shown as 提案元 on the cover
    client_name: str = ""             # 宛先/顧客名 — shown as 「〇〇御中」 on the cover
    accent_color: str = "#2383E2"     # hex accent; defaults to the built-in Notion-blue
    logo_path: str = ""               # project-relative or absolute image path; "" = no logo
    footer_note: str = ""             # optional cover footer line (会社情報/連絡先など)


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
    # --- 原価積み上げ (LOGISTEED 試算フロー 6費目) unit prices. All defaulted so a
    # template is always costable; the speculative categories default to 0 so the
    # build-up never INVENTS delivery/system/overhead cost — the user opts in via
    # the 原価試算 settings screen. ---
    forklift_cost_per_hour: float = 1600.0   # ¥/人時 フォークP社員 (deck p27)
    fixed_labor_per_month: float = 0.0       # 管理者など固定人件費 ¥/月 (opt-in)
    tsubo_rate_per_month: float = 4300.0     # 保管坪単価 ¥/坪/月 (deck p51)
    delivery_cost_per_cage: float = 0.0      # 輸配送 ¥/カゴ台車 (opt-in)
    system_cost_per_month: float = 0.0       # 情報システム費 ¥/月 (opt-in)
    overhead_rate: float = 0.0               # 運営費率 (作業+保管+輸配送+IT の比率; opt-in)
    # 生産性の3層: 実測採用値(override) > 物流形態ベンチマーク(想定) > エンジン既定.
    # productivity_overrides = 実測採用値 (想定→実測 swap; empty = no adoption).
    productivity_overrides: dict[str, float] = Field(default_factory=dict)
    # benchmark_productivity = 物流形態別の想定生産性 (whsim.benchmarks で適用).
    benchmark_productivity: dict[str, float] = Field(default_factory=dict)
    benchmark_id: str = ""                   # which 物流形態プリセットを適用したか
    # バッチ投入スケジュール: {section: [{"hour": H, "pct": P}]} — the day's volume for
    # a section (入荷/出荷) arrives in batches at given hours (e.g. 08:00→70%/12:00→
    # 20%/15:00→10%, or a single noon batch). Empty = all volume from window start.
    batch_schedule: dict[str, list[dict]] = Field(default_factory=dict)
    # シフト・休憩モデル: staffing-solver overlay so 「昼休みは？」 no longer breaks the
    # 人員タイムチャート. Shape (all keys optional; empty dict = legacy behaviour):
    #   {
    #     "breaks": [{"start": 12, "end": 13}],        # hours [start,end) with NO work
    #     "shifts": [{"label": "早番", "start": 6, "end": 15,
    #                 "max_workers": 20, "wage_per_hr": 1300}],  # named time windows
    #     "default_wage_per_hr": 1200,                 # ¥/人時 outside any shift band
    #   }
    # Break hours allocate zero headcount (capacity 0); each shift additionally caps
    # the per-hour TOTAL headcount by Σ max_workers of the shifts covering that hour
    # (shifts defined but none covering an hour ⇒ that hour is closed; NO shifts at all
    # ⇒ unlimited/legacy). wage bands drive a labour-cost line. Empty = no-op.
    shift_plan: dict = Field(default_factory=dict)
    # 提案書ブランドテーマ: cover 宛先/自社名/アクセント/ロゴ for a client-ready export.
    brand: Brand = Field(default_factory=Brand)
    # 提案書の用語ガード (per-client wording guard). Shape — every key optional:
    #   {"forbidden": ["…"], "forbidden_regex": "…",
    #    "replacements": {"NG": "OK"}, "allow": ["…"]}
    # Empty (the default) = the check is entirely INERT: whsim.wording returns no
    # findings and no text is ever rewritten, so existing exports are unchanged.
    # ``allow`` wins over ``forbidden`` — a proper name may contain a banned word
    # (see whsim/wording.py for why the guard freezes that ground first).
    wording: dict = Field(default_factory=dict)


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
    # 荷姿カタログ (資材マスタ). Empty ⇒ the engine default (loadunit.DEFAULT_UNITS);
    # resolve through `loadunit.catalog(model)`, never read this list directly.
    load_units: list[LoadUnit] = Field(default_factory=list)
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
        clamp_f(self.process, "replenish_trigger_frac", 0.0, "補充発注点(容量比)")
        clamp_f(self.process, "replenish_qty_frac", 0.0, "補充目標(容量比)")
        clamp_f(self.process, "replenish_place_s", 0.0, "補充配置時間")
        clamp_i(self.process, "replenishers", 0, "補充要員数")

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
