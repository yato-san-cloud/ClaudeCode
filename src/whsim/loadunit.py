"""荷姿 — the containers and carriers goods ride in, and the conversion between them.

A 3PL design lives and dies on this arithmetic: 「バラ 2,500 点は折コン何枚か、
それはカゴ車何台か、検品前に何台溜まるか、その仮置きに何坪要るか」. SLC has it and
makes you fill in a materials master before anything runs; whsim's rule is the
opposite — **ship the catalogue with sane defaults, edit the 入数 in place on the
edge that uses it**.

Two design points carry the weight:

* **The catalogue is resolved, never read raw.** ``catalog(model)`` returns the
  project's list when it has one, else :data:`DEFAULT_UNITS` — the same
  single-source rule the work-process master follows (ARCHITECTURE invariant 14),
  so renaming or adding a 荷姿 flows everywhere at once.

* **Capacity is a chain, and mixed loads fill by OCCUPANCY.** A carrier that
  takes both 折コン and cases is filled by ``Σ (count / capacity)``, not by
  adding raw counts. With the seeded 14/14 that is *identical* to the flat
  「(OC＋ケース)÷14」 the 基礎物量 screen has always used, so no existing number
  moves; but it also expresses 「カゴ車＝折コン12枚 or ケース20個」 honestly, which
  the flat form cannot.

Every 入数 here is an ASSUMPTION (``provisional=True``). Nothing in this module
measures anything — it converts, and says so.
"""

from __future__ import annotations

import math

#: Leaf units. They hold nothing, so a chain terminates here.
BASE_UNITS = frozenset({"piece", "case"})

#: Japanese labels for the leaves (a LoadUnit row carries its own ``name``).
BASE_LABELS = {"piece": "ピース(バラ)", "case": "ケース"}

#: The catalogue a project gets for free. Seeded so the numbers the 基礎物量
#: screen already shows do not move:
#:   ``pieces_per_orikon=30`` / ``units_per_cage=14`` / ``cases_per_pallet=40``
#: (see ``bi.derive_volumes``). Footprints are the real footprint of the
#: standard article, used only to turn a 滞留 count into 坪数.
DEFAULT_UNITS: list[dict] = [
    {"id": "piece", "name": "ピース(バラ)", "kind": "base", "capacity": {},
     "footprint_m2": 0.0, "provisional": False},
    {"id": "case", "name": "ケース", "kind": "base", "capacity": {},
     "footprint_m2": 0.0, "provisional": False},
    # 折りたたみコンテナ 60x40 — the workhorse tote for バラ出荷.
    {"id": "orikon", "name": "オリコン", "kind": "container",
     "capacity": {"piece": 30.0}, "footprint_m2": 0.24, "provisional": True},
    # 番重/トレー — flatter, used in 食品/日配.
    {"id": "tray", "name": "トレー(番重)", "kind": "container",
     "capacity": {"piece": 20.0}, "footprint_m2": 0.22, "provisional": True},
    # カゴ台車 110x80. 14/14 reproduces the historical flat approximation.
    {"id": "cage", "name": "カゴ台車", "kind": "carrier",
     "capacity": {"orikon": 14.0, "case": 14.0, "tray": 14.0},
     "footprint_m2": 0.88, "provisional": True},
    {"id": "cart6", "name": "6輪カート", "kind": "carrier",
     "capacity": {"orikon": 6.0, "case": 6.0, "tray": 8.0},
     "footprint_m2": 0.60, "provisional": True},
    {"id": "dolly", "name": "平台車", "kind": "carrier",
     "capacity": {"orikon": 4.0, "case": 4.0, "tray": 6.0},
     "footprint_m2": 0.48, "provisional": True},
    {"id": "pallet", "name": "パレット", "kind": "pallet",
     "capacity": {"case": 40.0}, "footprint_m2": 1.21, "provisional": True},
]


def catalog(model=None) -> list[dict]:
    """The 荷姿 catalogue: the project's list when set, else the engine default.

    THE single source — every consumer resolves through here so an edited 入数
    or a renamed 荷姿 reaches the flow, the staffing solver and the cost stack at
    once. Never raises.
    """
    units = getattr(model, "load_units", None)
    if not units:
        return [dict(u) for u in DEFAULT_UNITS]
    out: list[dict] = []
    for u in units:
        d = u.model_dump() if hasattr(u, "model_dump") else dict(u)
        uid = str(d.get("id") or "").strip()
        if not uid:
            continue
        cap: dict[str, float] = {}
        for k, v in (d.get("capacity") or {}).items():
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            if f > 0:
                cap[str(k)] = f
        out.append({
            "id": uid,
            "name": str(d.get("name") or "") or uid,
            "kind": str(d.get("kind") or "container"),
            "capacity": cap,
            "footprint_m2": max(float(d.get("footprint_m2") or 0.0), 0.0),
            "provisional": bool(d.get("provisional", True)),
        })
    return out


def by_id(model=None) -> dict[str, dict]:
    return {u["id"]: u for u in catalog(model)}


def label(unit_id: str, units: dict[str, dict] | None = None) -> str:
    if units and unit_id in units:
        return units[unit_id].get("name") or unit_id
    return BASE_LABELS.get(unit_id, unit_id)


def capacity_for(unit: dict, held_id: str) -> float:
    """How many ``held_id`` fit in one ``unit`` (0 = it does not take them)."""
    try:
        return float((unit.get("capacity") or {}).get(held_id, 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def pack(amounts: dict[str, float], unit: dict) -> float:
    """Units needed to hold ``amounts`` — ``{held_id: count}`` — by OCCUPANCY.

    ``Σ(count / capacity)`` rather than a raw sum: a carrier taking 14 折コン OR
    14 cases is full at 7 of each, which is what the flat 「(OC＋ケース)÷14」 said;
    but a carrier taking 12 折コン or 20 cases is now expressible too.

    Amounts naming something this unit cannot hold are IGNORED here and reported
    by :func:`whsim.flowgraph.diagnose` — silently rounding them into the load
    would invent capacity that does not exist.
    """
    occupancy = 0.0
    for held, count in (amounts or {}).items():
        try:
            n = float(count)
        except (TypeError, ValueError):
            continue
        if n <= 0:
            continue
        cap = capacity_for(unit, held)
        if cap > 0:
            occupancy += n / cap
    return occupancy


def convert(model, pieces: float = 0.0, cases: float = 0.0,
            container_ref: str = "", carrier_ref: str = "") -> dict:
    """バラ/ケース → 容器 → 台車, with the arithmetic shown.

    Returns counts plus a ``chain`` string ("バラ 2,500 点 ÷ 30 = 84 オリコン →
    ＋ケース 120 ÷ 14 = 15 台") so the screen can always show HOW a number was
    reached — the same 「式を明示」 rule the cost stack follows.

    Unspecified refs degrade to "no conversion at that step", so an edge that
    names nothing simply reports the raw amounts (never-blocks).
    """
    units = by_id(model)
    try:
        pieces = max(float(pieces or 0.0), 0.0)
        cases = max(float(cases or 0.0), 0.0)
    except (TypeError, ValueError):
        pieces, cases = 0.0, 0.0

    steps: list[str] = []
    containers = 0.0
    container = units.get(container_ref) if container_ref else None
    if container is not None and pieces > 0:
        per = capacity_for(container, "piece")
        if per > 0:
            containers = math.ceil(pieces / per)
            steps.append(f"バラ {pieces:,.0f} 点 ÷ {per:g} = {containers:,.0f} "
                         f"{label(container_ref, units)}")

    carriers = 0.0
    carrier = units.get(carrier_ref) if carrier_ref else None
    if carrier is not None:
        load: dict[str, float] = {}
        if containers > 0 and container_ref:
            load[container_ref] = containers
        if cases > 0:
            load["case"] = cases
        occ = pack(load, carrier)
        if occ > 0:
            carriers = math.ceil(occ)
            parts = " ＋ ".join(
                f"{v:,.0f} {label(k, units)}(積載{capacity_for(carrier, k):g})"
                for k, v in load.items() if capacity_for(carrier, k) > 0)
            steps.append(f"{parts} → {carriers:,.0f} {label(carrier_ref, units)}")

    return {
        "pieces": pieces,
        "cases": cases,
        "containers": containers,
        "carriers": carriers,
        "container_ref": container_ref,
        "carrier_ref": carrier_ref,
        # Floor a full waiting load occupies — the input to 仮置き坪数.
        "carrier_footprint_m2": (carrier or {}).get("footprint_m2", 0.0) if carrier else 0.0,
        "container_footprint_m2": (container or {}).get("footprint_m2", 0.0) if container else 0.0,
        "chain": " → ".join(steps),
        # True when any number above rests on an assumed 入数.
        "provisional": bool((container or {}).get("provisional")
                            or (carrier or {}).get("provisional")),
    }
