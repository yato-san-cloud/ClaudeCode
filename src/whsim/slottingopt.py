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

**Affinity (併買) slotting** — additive, opt-in via ``affinity_weight`` (0 = off,
the default → byte-identical to the legacy COI result). SKUs frequently picked in
the SAME outbound order should sit near each other (an OptiSlot-class lever that
cuts *tour* length beyond single-command COI/ABC). We build a co-occurrence matrix
from ``model.orders.outbound`` (pairs within one order_id, capped to the top-N SKUs
by volume for O(N²) safety) and blend an affinity pull into the greedy: when placing
a SKU we prefer free slots near its already-placed high-affinity partners.

**Seasonality** — :func:`seasonality` turns a date+sku shipments table into a monthly
入替候補リスト (a SKU whose ABC class drifts between the first and last observed month
is flagged for a re-slot). Recommendation only — nothing is moved automatically.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from whsim.engine.routing import manhattan
from whsim.schema.model import Item, Location, WarehouseModel

# Caps that keep the affinity build analytic and O(N²)-safe on real DCs.
AFFINITY_TOP_N = 300          # SKUs (by volume) admitted to the co-occurrence matrix
AFFINITY_TOP_PARTNERS = 12    # strongest partners kept per SKU for the greedy pull


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
    # --- Affinity (併買) extras — all default so legacy callers are unaffected ---
    affinity_weight: float = 0.0
    pairs_considered: int = 0        # distinct co-picked SKU pairs in the matrix
    tour_cost: float = 0.0           # Σ cooccur(a,b)·dist(slot_a, slot_b) for THIS pegging

    @property
    def reduction(self) -> float:
        return self.before - self.after

    @property
    def reduction_pct(self) -> float:
        return (self.reduction / self.before) if self.before > 0 else 0.0


def _cooccurrence(model: WarehouseModel, top_n: int = AFFINITY_TOP_N):
    """Build the 併買 co-occurrence matrix from ``model.orders.outbound``.

    For each outbound order, every unordered pair of its (distinct) SKUs is a
    co-pick; the pair's count is how often the two ride the same tour. Only the
    top-``top_n`` SKUs by shipped volume are admitted, capping the pair space at
    O(top_n²) so the build stays fast on a real DC (~thousands of SKUs).

    Returns ``(adj, pair_count)`` where ``adj[sku]`` is a list of
    ``(partner_sku, count)`` and ``pair_count[(a, b)]`` (a < b) is the raw count.
    Empty when there are no outbound orders (→ affinity simply stays off).
    """
    orders = model.orders.outbound
    vol: dict[str, float] = defaultdict(float)
    for o in orders:
        for ln in o.lines:
            if ln.sku:
                vol[ln.sku] += float(max(1, ln.qty))
    if not vol:
        return {}, {}
    top = {sku for sku, _ in sorted(vol.items(), key=lambda kv: (-kv[1], kv[0]))[:top_n]}

    pair_count: dict[tuple[str, str], float] = defaultdict(float)
    for o in orders:
        skus = sorted({ln.sku for ln in o.lines if ln.sku and ln.sku in top})
        for i in range(len(skus)):
            for j in range(i + 1, len(skus)):
                pair_count[(skus[i], skus[j])] += 1.0

    adj: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for (a, b), c in pair_count.items():
        adj[a].append((b, c))
        adj[b].append((a, c))
    return dict(adj), dict(pair_count)


def _copick_cost(pair_count: dict, coord_of_sku: dict[str, tuple[float, float]]) -> float:
    """Estimated inter-pick tour travel: Σ cooccur(a,b) · dist(slot_a, slot_b).

    This is the affinity-relevant half of tour length — the distance a picker walks
    *between* two SKUs that share an order. Pairs with an unplaced SKU contribute
    nothing. It is an ESTIMATE (adjacency proxy, not a sequenced route)."""
    total = 0.0
    for (a, b), c in pair_count.items():
        pa = coord_of_sku.get(a)
        pb = coord_of_sku.get(b)
        if pa is not None and pb is not None:
            total += c * manhattan(pa, pb)
    return total


def _affinity_order(items: list[Item], partners: dict, aff_weight: float) -> list[Item]:
    """Velocity ordering, but a SKU strongly co-picked with FAST movers is boosted up
    the queue so it reaches the golden zone alongside them (the core 併買 lever — a
    slow SKU that always ships with a fast one still deserves a near slot).

        eff(s) = velocity(s) + w · Σ_partner (cooccur(s,p)/max_cooccur) · velocity(p)

    At ``w == 0`` this collapses to the plain velocity key, so the order — and hence
    the whole assignment — is byte-identical to the legacy greedy."""
    vel = {it.sku: _velocity_key(it) for it in items}
    max_c = max((w for lst in partners.values() for _, w in lst), default=1.0) or 1.0
    boost = {
        it.sku: sum((w / max_c) * vel.get(p, 0.0) for p, w in partners.get(it.sku, ()))
        for it in items
    }
    return sorted(items, key=lambda it: (-(vel[it.sku] + aff_weight * boost[it.sku]), it.sku))


def _affinity_assignment(items: list[Item], storage: list[Location],
                         ref: tuple[float, float], adj: dict, aff_weight: float) -> dict[str, str]:
    """Affinity-aware greedy pegging (loc-id → sku).

    SKUs are placed in affinity-boosted velocity order (:func:`_affinity_order`), and
    each takes the free slot that maximises a blended score

        score(slot) = (1-w)·proximity(slot→I/O) + w·affinity(slot ↔ placed partners)

    both terms normalised to [0, 1]. ``proximity`` is 1 at the nearest slot, 0 at the
    farthest; ``affinity`` is the co-occurrence-weighted average closeness to the SKU's
    already-placed partners (0 when none are placed yet). At ``w == 0`` the argmax is
    the nearest free slot with a lowest-id tie-break — i.e. exactly the legacy pick —
    so this path is never taken for ``w == 0`` (see :func:`optimize`)."""
    partners = {s: sorted(lst, key=lambda t: (-t[1], t[0]))[:AFFINITY_TOP_PARTNERS]
                for s, lst in adj.items()}
    items_sorted = _affinity_order(items, partners, aff_weight)
    dref = {loc.id: manhattan(ref, (loc.x, loc.y)) for loc in storage}
    dmax, dmin = max(dref.values()), min(dref.values())
    drange = (dmax - dmin) or 1.0
    xs = [loc.x for loc in storage]
    ys = [loc.y for loc in storage]
    span = ((max(xs) - min(xs)) + (max(ys) - min(ys))) or 1.0
    coord = {loc.id: (loc.x, loc.y) for loc in storage}

    free = sorted(storage, key=lambda loc: (dref[loc.id], loc.id))
    placed_coord: dict[str, tuple[float, float]] = {}
    assignment: dict[str, str] = {}
    for it in items_sorted:
        active = [(p, w) for (p, w) in partners.get(it.sku, ()) if p in placed_coord]
        wsum = sum(w for _, w in active)
        best, best_score = None, None
        for loc in free:
            prox = (dmax - dref[loc.id]) / drange
            if wsum > 0.0:
                px, py = coord[loc.id]
                aterm = 0.0
                for p, w in active:
                    qx, qy = placed_coord[p]
                    aterm += w * ((span - (abs(px - qx) + abs(py - qy))) / span)
                score = (1.0 - aff_weight) * prox + aff_weight * (aterm / wsum)
            else:
                score = (1.0 - aff_weight) * prox
            if best_score is None or score > best_score:
                best_score, best = score, loc
        assignment[best.id] = it.sku
        placed_coord[it.sku] = coord[best.id]
        free.remove(best)
        if not free:
            break
    return assignment


def _derive_moves_after(assignment: dict[str, str], ref: tuple[float, float],
                        loc_by_id: dict, item_by_sku: dict,
                        cur_loc_of: dict) -> tuple[list[Move], float]:
    """Move list + AFTER weighted distance for a finished assignment (loc-id → sku)."""
    moves: list[Move] = []
    for lid, sku in assignment.items():
        it = item_by_sku[sku]
        loc = loc_by_id[lid]
        new_d = manhattan(ref, (loc.x, loc.y))
        prev_id = cur_loc_of.get(sku)
        prev_loc = loc_by_id.get(prev_id) if prev_id else None
        old_d = manhattan(ref, (prev_loc.x, prev_loc.y)) if prev_loc else None
        delta = it.pick_freq * (new_d - old_d) if old_d is not None else 0.0
        if prev_id != lid:
            moves.append(Move(
                sku=sku, name=it.name or sku, from_loc=prev_id, to_loc=lid,
                pick_freq=it.pick_freq, delta_dist=delta,
            ))
    after = sum(max(0.0, item_by_sku[sku].pick_freq)
                * manhattan(ref, (loc_by_id[lid].x, loc_by_id[lid].y))
                for lid, sku in assignment.items())
    return moves, after


def optimize(model: WarehouseModel, affinity_weight: float = 0.0) -> SlottingPlan:
    """Compute the velocity×distance-greedy optimal pegging (no mutation).

    Deterministic and O(n log n): sort SKUs by velocity (COI-adjusted) desc, sort
    free slots by distance to the I/O ref asc, then peg greedily — the fastest
    unplaced SKU takes the nearest unfilled slot. Capacity-aware: a slot holds one
    SKU (single-deep address), so one SKU → one slot here; surplus SKUs are
    reported as unplaced. Returns a SlottingPlan with BEFORE/AFTER and the moves.

    ``affinity_weight`` ∈ [0, 1] blends a 併買 (co-pick) pull into the greedy so
    SKUs shipped together land near each other (reduces tour length beyond COI).
    ``0`` (the default) reproduces the legacy assignment BYTE-for-BYTE; the pull is
    only engaged when there are outbound orders to learn co-picks from.
    """
    ref = _io_reference(model)
    storage = _storage_locations(model)
    before = weighted_distance(model, ref)
    aff_weight = min(1.0, max(0.0, float(affinity_weight)))

    if not storage or not model.items:
        return SlottingPlan(ref=ref, before=before, after=before, moves=[],
                            placed=0, unplaced=len(model.items),
                            locations=len(storage), skus=len(model.items),
                            assignment={}, affinity_weight=aff_weight)

    loc_by_id = {loc.id: loc for loc in model.locations}
    cur_loc_of = {it.sku: it.default_location for it in model.items if it.sku}
    item_by_sku = {it.sku: it for it in model.items if it.sku}

    items = sorted(
        (it for it in model.items if it.sku),
        key=lambda it: (-_velocity_key(it), it.sku),
    )
    locs = sorted(storage, key=lambda loc: (manhattan(ref, (loc.x, loc.y)), loc.id))
    n = min(len(items), len(locs))

    # Co-occurrence is cheap and always built (so tour_cost is reported even at w=0);
    # the affinity-aware pegging is only used when a positive weight is asked AND
    # there is a matrix to learn from — otherwise the legacy positional greedy runs,
    # which keeps affinity_weight=0 byte-identical to the historical result.
    adj, pair_count = _cooccurrence(model)
    if aff_weight > 0.0 and adj:
        assignment = _affinity_assignment(items[:n], storage, ref, adj, aff_weight)
    else:
        assignment = {locs[i].id: items[i].sku for i in range(n)}

    moves, after = _derive_moves_after(assignment, ref, loc_by_id, item_by_sku, cur_loc_of)
    coord_of_sku = {sku: (loc_by_id[lid].x, loc_by_id[lid].y) for lid, sku in assignment.items()}
    tour_cost = _copick_cost(pair_count, coord_of_sku)

    return SlottingPlan(
        ref=ref, before=before, after=after, moves=moves,
        placed=n, unplaced=max(0, len(items) - len(locs)),
        locations=len(storage), skus=len(model.items), assignment=assignment,
        affinity_weight=aff_weight, pairs_considered=len(pair_count), tour_cost=tour_cost,
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
        "affinity_weight": round(plan.affinity_weight, 3),
    }


def affinity_report(model: WarehouseModel, affinity_weight: float,
                    baseline: SlottingPlan | None = None,
                    plan: SlottingPlan | None = None) -> dict:
    """併買アフィニティ block for the API: co-pick pairs considered + the estimated
    tour-length delta of the affinity pegging vs the legacy (weight-0) pegging.

    ``tour_*_est`` are ESTIMATES (co-pick adjacency proxy, not a sequenced route).
    ``available=false`` when there are no outbound orders to learn co-picks from,
    so the view degrades gracefully (never blocks)."""
    aff_weight = min(1.0, max(0.0, float(affinity_weight)))
    base = baseline if baseline is not None else optimize(model, affinity_weight=0.0)
    if not base.pairs_considered:
        return {"available": False, "weight": aff_weight, "pairs_considered": 0,
                "message": "併買アフィニティには出荷オーダー（明細）データが必要です。"}
    cur = plan if plan is not None else (
        base if aff_weight <= 0.0 else optimize(model, affinity_weight=aff_weight))
    delta = base.tour_cost - cur.tour_cost
    return {
        "available": True,
        "weight": round(aff_weight, 3),
        "pairs_considered": base.pairs_considered,
        "tour_before_est": round(base.tour_cost, 2),
        "tour_after_est": round(cur.tour_cost, 2),
        "tour_delta_est": round(delta, 2),
        "tour_reduction_pct": round(delta / base.tour_cost, 4) if base.tour_cost > 0 else 0.0,
    }


def _classify_abc(vols: dict[str, float], a_cutoff: float = 0.7,
                  b_cutoff: float = 0.9) -> dict[str, str]:
    """Pareto/ABC labels for one period's {sku: qty} (standard 'before this row'
    convention: the SKU that crosses a cutoff still counts in the lower class)."""
    total = sum(v for v in vols.values() if v > 0)
    if total <= 0:
        return {sku: "C" for sku in vols}
    cls: dict[str, str] = {}
    cum = 0.0
    for sku, v in sorted(vols.items(), key=lambda kv: (-kv[1], kv[0])):
        prev = cum / total
        cls[sku] = "A" if prev < a_cutoff else ("B" if prev < b_cutoff else "C")
        cum += max(0.0, v)
    return cls


def seasonality(records, a_cutoff: float = 0.7, b_cutoff: float = 0.9) -> dict:
    """季節性スロッティング: monthly ABC drift → a 入替候補リスト (recommendation only).

    ``records`` is any iterable of ``(month, sku, qty)`` where ``month`` is a
    sortable period key (e.g. ``'2026-01'``). Volumes are summed per (month, sku),
    each SKU is ABC-classified within the FIRST and the LAST observed month, and a
    SKU whose class moved ≥1 level is flagged with its monthly trend. Nothing is
    re-slotted — this is a candidate list a human decides on.

    ``available=false`` when fewer than two dated months are present (never blocks).
    """
    month_sku: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for month, sku, qty in records:
        if not month or not sku:
            continue
        month_sku[str(month)][str(sku)] += float(qty or 0.0)
    months = sorted(month_sku)
    if len(months) < 2:
        return {"available": False, "months_observed": len(months), "rows": [],
                "message": "月次の入替候補には、2ヶ月以上の日付つき出荷データが必要です。"}

    first, last = months[0], months[-1]
    cls_first = _classify_abc(month_sku[first], a_cutoff, b_cutoff)
    cls_last = _classify_abc(month_sku[last], a_cutoff, b_cutoff)
    rank = {"A": 0, "B": 1, "C": 2}

    rows = []
    for sku in set(cls_first) | set(cls_last):
        oc = cls_first.get(sku, "C")
        nc = cls_last.get(sku, "C")
        if oc == nc:
            continue
        moved = rank[oc] - rank[nc]  # >0 → climbed toward A (needs a golden-zone slot)
        rows.append({
            "sku": sku,
            "old_class": oc,
            "new_class": nc,
            "delta_class": abs(moved),
            "direction": "up" if moved > 0 else "down",
            "trend": [{"month": m, "qty": round(month_sku[m].get(sku, 0.0), 2)} for m in months],
        })
    # Biggest movers first; risers (→A) before decliners; deterministic tie-break.
    rows.sort(key=lambda r: (-r["delta_class"], 0 if r["direction"] == "up" else 1, r["sku"]))
    return {
        "available": True,
        "months_observed": len(months),
        "first_month": first,
        "last_month": last,
        "rows": rows,
    }
