"""Slotting OPTIMIZATION — assign SKUs to locations to minimise picker travel.

The basic ``slotting.assign_inventory`` pegs fast movers near the pack station
by ABC rank. This module is the proper optimiser behind it: it MINIMISES the
weighted pick-distance objective

    Σ_sku  pick_freq(sku) · distance(location(sku) → dominant pick face / I/O)

with a deterministic, capacity-aware **velocity × distance greedy**: rank SKUs
by velocity (with a golden-zone / cube-per-order tweak), rank free slots by
distance to the I/O reference, and peg the fastest SKU to the nearest open slot.
This is the classic COI (cube-per-order index) heuristic — provably good for
single-command travel and O(n log n), so it stays fast at ~600 slots / ~800 SKUs.

Pure functions over the canonical schema; an ``apply`` mode writes the result
back onto ``item.default_location`` / ``loc.sku`` / ``loc.qty`` (NEVER the
schema). The headline output is BEFORE vs AFTER total weighted pick-distance.
"""

from __future__ import annotations

from dataclasses import dataclass

from whsim.engine.routing import manhattan
from whsim.schema.model import Item, Location, WarehouseModel


def _io_reference(model: WarehouseModel) -> tuple[float, float]:
    """The I/O / dominant pick face the travel objective is measured against.

    Prefer the first 梱包台 (packing station); fall back to the centre of a
    packing/shipping zone; else the floor's bottom-centre (the dock edge)."""
    if model.resources.stations:
        st = model.resources.stations[0]
        return (st.x, st.y)
    for ztype in ("packing", "shipping"):
        for z in model.layout.zones:
            if z.type == ztype:
                return (z.x + z.w / 2.0, z.y + z.h / 2.0)
    b = model.layout.bounds
    return (b.width / 2.0, 0.0)


def _storage_locations(model: WarehouseModel) -> list[Location]:
    return [loc for loc in model.locations if loc.zone == "storage"] or list(model.locations)


def _capacity_units(loc: Location, it: Item) -> int:
    """Units to peg into a slot for an item (on-hand if known, else a case)."""
    if it.stock:
        return min(it.stock, loc.capacity) if loc.capacity else it.stock
    base = it.case_qty or 1
    return min(base, loc.capacity) if loc.capacity else base


def _velocity_key(it: Item) -> float:
    """Slotting priority for a SKU.

    Velocity (pick_freq) is the dominant lever on single-command travel; we
    fold in a small **cube-per-order** awareness — a bulky SKU (large case_qty)
    consumes more golden-zone real estate per pick, so per the COI heuristic its
    effective priority is freq / cube. Two SKUs of equal velocity: the
    smaller-cube one earns the nearer slot. Deterministic ties → sku string."""
    freq = max(0.0, it.pick_freq)
    cube = max(1.0, float(it.case_qty or 1))
    # COI-flavoured score: high frequency, low cube → nearest slot.
    return freq / (cube ** 0.5)


def weighted_distance(model: WarehouseModel, ref: tuple[float, float] | None = None) -> float:
    """Σ pick_freq · distance(current location → I/O) for the CURRENT pegging.

    SKUs with no slot (default_location None / unknown) contribute nothing — the
    metric is over what is actually slotted, so BEFORE/AFTER compare like-for-like
    only when the same SKUs are placed (the optimiser never drops a placeable SKU).
    """
    if ref is None:
        ref = _io_reference(model)
    loc_by_id = {loc.id: loc for loc in model.locations}
    total = 0.0
    for it in model.items:
        lid = it.default_location
        if not lid or lid not in loc_by_id:
            continue
        loc = loc_by_id[lid]
        total += max(0.0, it.pick_freq) * manhattan(ref, (loc.x, loc.y))
    return total


@dataclass
class Move:
    sku: str
    name: str
    from_loc: str | None
    to_loc: str
    pick_freq: float
    delta_dist: float  # signed change in weighted distance for this SKU (after - before)


@dataclass
class SlottingPlan:
    ref: tuple[float, float]
    before: float
    after: float
    moves: list[Move]
    placed: int
    unplaced: int
    locations: int
    skus: int
    # the optimised pegging, location-id → sku (so apply can write without re-running)
    assignment: dict[str, str]

    @property
    def reduction(self) -> float:
        return self.before - self.after

    @property
    def reduction_pct(self) -> float:
        return (self.reduction / self.before) if self.before > 0 else 0.0


def optimize(model: WarehouseModel) -> SlottingPlan:
    """Compute the velocity×distance-greedy optimal pegging (no mutation).

    Deterministic and O(n log n): sort SKUs by velocity (COI-adjusted) desc, sort
    free slots by distance to the I/O ref asc, then peg greedily — the fastest
    unplaced SKU takes the nearest unfilled slot. Capacity-aware: a slot holds one
    SKU (single-deep address), so one SKU → one slot here; surplus SKUs are
    reported as unplaced. Returns a SlottingPlan with BEFORE/AFTER and the moves.
    """
    ref = _io_reference(model)
    storage = _storage_locations(model)
    before = weighted_distance(model, ref)

    if not storage or not model.items:
        return SlottingPlan(ref=ref, before=before, after=before, moves=[],
                            placed=0, unplaced=len(model.items),
                            locations=len(storage), skus=len(model.items),
                            assignment={})

    # Current location of each SKU (for the move list + per-SKU delta).
    loc_by_id = {loc.id: loc for loc in model.locations}
    cur_loc_of = {it.sku: it.default_location for it in model.items if it.sku}

    items = sorted(
        (it for it in model.items if it.sku),
        key=lambda it: (-_velocity_key(it), it.sku),
    )
    locs = sorted(storage, key=lambda loc: (manhattan(ref, (loc.x, loc.y)), loc.id))

    n = min(len(items), len(locs))
    assignment: dict[str, str] = {}
    moves: list[Move] = []
    for i in range(n):
        it, loc = items[i], locs[i]
        assignment[loc.id] = it.sku
        new_d = manhattan(ref, (loc.x, loc.y))
        prev_id = cur_loc_of.get(it.sku)
        prev_loc = loc_by_id.get(prev_id) if prev_id else None
        old_d = manhattan(ref, (prev_loc.x, prev_loc.y)) if prev_loc else None
        delta = it.pick_freq * (new_d - old_d) if old_d is not None else 0.0
        if prev_id != loc.id:
            moves.append(Move(
                sku=it.sku, name=it.name or it.sku, from_loc=prev_id, to_loc=loc.id,
                pick_freq=it.pick_freq, delta_dist=delta,
            ))

    # AFTER objective from the optimised assignment.
    freq_of = {it.sku: max(0.0, it.pick_freq) for it in model.items if it.sku}
    after = sum(freq_of.get(sku, 0.0) * manhattan(ref, (loc_by_id[lid].x, loc_by_id[lid].y))
                for lid, sku in assignment.items())

    return SlottingPlan(
        ref=ref, before=before, after=after, moves=moves,
        placed=n, unplaced=max(0, len(items) - len(locs)),
        locations=len(storage), skus=len(model.items), assignment=assignment,
    )


def apply_plan(model: WarehouseModel, plan: SlottingPlan) -> int:
    """Write an optimised plan onto the model in place (NEVER the schema).

    Clears the current pegging of every storage slot, then sets ``loc.sku`` /
    ``loc.qty`` and ``item.default_location`` from ``plan.assignment``. SKUs with
    no slot have ``default_location`` cleared so the model stays honest. Returns
    the number of SKUs placed."""
    storage = _storage_locations(model)
    storage_ids = {loc.id for loc in storage}
    item_by_sku = {it.sku: it for it in model.items if it.sku}

    for loc in storage:
        loc.sku = None
        loc.qty = 0
    for it in model.items:
        if it.sku in item_by_sku:  # placeable; cleared then re-set below if slotted
            it.default_location = None

    placed = 0
    for lid, sku in plan.assignment.items():
        if lid not in storage_ids:
            continue
        loc = next((loc for loc in storage if loc.id == lid), None)
        it = item_by_sku.get(sku)
        if loc is None or it is None:
            continue
        loc.sku = sku
        loc.qty = _capacity_units(loc, it)
        it.default_location = lid
        placed += 1
    return placed


def plan_summary(plan: SlottingPlan, top: int = 20) -> dict:
    """JSON-able summary of a plan: headline BEFORE/AFTER + the top SKU moves.

    The move list is sorted by the magnitude of distance improvement (the moves
    that buy the most travel reduction first) and truncated to ``top``."""
    moves_sorted = sorted(plan.moves, key=lambda m: m.delta_dist)  # most negative (best) first
    move_rows = [{
        "sku": m.sku, "name": m.name,
        "from": m.from_loc, "to": m.to_loc,
        "pick_freq": round(m.pick_freq, 4),
        "delta_dist": round(m.delta_dist, 2),
    } for m in moves_sorted[:top]]
    return {
        "before_weighted_distance": round(plan.before, 2),
        "after_weighted_distance": round(plan.after, 2),
        "reduction": round(plan.reduction, 2),
        "reduction_pct": round(plan.reduction_pct, 4),
        "placed": plan.placed,
        "unplaced": plan.unplaced,
        "locations": plan.locations,
        "skus": plan.skus,
        "moves": move_rows,
        "moves_total": len(plan.moves),
        "ref": {"x": round(plan.ref[0], 2), "y": round(plan.ref[1], 2)},
    }
