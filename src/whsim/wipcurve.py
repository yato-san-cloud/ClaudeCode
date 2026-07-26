"""滞留 — how much piles up between two processes, and the 仮置き it needs.

The question a 3PL designer actually asks about a 荷姿: 「検品前にカゴ車は最大何台
溜まる? その仮置きに何坪要る? 台車は何台保有すればいい?」 A daily total cannot
answer it — 500 cages a day is nothing if they flow through evenly and a disaster
if 300 of them land in one hour.

This is a **cumulative-flow diagram**, computed analytically from things whsim
already has:

* the staffing solver's per-hour ``headcount_by_hour × productivity`` = what each
  process actually PUTS OUT in each hour, and
* :mod:`whsim.loadunit`, which turns that flow into 容器/台車 counts.

    WIP(t) = max(0, Σ_{h≤t} out_upstream(h) − Σ_{h≤t} out_downstream(h))

Both sides are taken as FRACTIONS of the same daily physical flow before being
converted, which sidesteps the unit mismatch that would otherwise poison the
subtraction — an upstream process may be measured in 行/h and the downstream one
in 件/h, and 行 − 件 is meaningless. The same physical goods cross the edge, so
the honest common currency is "how much of today's flow has each side finished".

No simulation is involved: this is the 爆速 layer, so a 荷姿 change re-costs the
whole day while the user is still dragging. The DES does not model carriers at
all yet; that is an explicit extension point, not a silent gap.
"""

from __future__ import annotations

import math

from whsim import loadunit

#: Aisle/handling allowance on top of the raw footprint, matching `storage.py`
#: so a 仮置き坪 and a 保管坪 are measured the same way.
AISLE_FACTOR = 1.9

#: 1坪 = 3.30578 m². The rest of the app reports floor in 坪.
M2_PER_TSUBO = 3.305785


def _cum(xs: list[float]) -> list[float]:
    total, out = 0.0, []
    for x in xs:
        total += max(float(x or 0.0), 0.0)
        out.append(total)
    return out


def _fractions(hourly: list[float]) -> list[float]:
    """Cumulative output as a fraction of the day (0…1). Empty ⇒ []."""
    cum = _cum(hourly)
    total = cum[-1] if cum else 0.0
    if total <= 0:
        return [0.0] * len(cum)
    return [c / total for c in cum]


def _hourly_output(proc: dict) -> list[float]:
    """What one process puts out each hour: headcount × productivity."""
    prod = float(proc.get("productivity") or 0.0)
    return [max(float(h or 0.0), 0.0) * prod for h in (proc.get("headcount_by_hour") or [])]


def edge_wip(model, solved: dict, src: str, dst: str, *,
             pieces: float = 0.0, cases: float = 0.0,
             container_ref: str = "", carrier_ref: str = "",
             share: float = 1.0) -> dict:
    """滞留 on ONE leg, in that leg's own 荷姿.

    ``solved`` is a :func:`whsim.analysis.staffing.solve_staffing` result.
    Returns the hourly curve plus the peak and what that peak costs in floor.
    never-blocks: anything missing yields a zero curve, not an error.
    """
    procs = {p["id"]: p for p in (solved or {}).get("processes", [])}
    hours = list((solved or {}).get("hours") or [])
    up, down = procs.get(src), procs.get(dst)

    try:
        share = min(max(float(share), 0.0), 1.0)
    except (TypeError, ValueError):
        share = 1.0

    conv = loadunit.convert(model, pieces=float(pieces or 0.0) * share,
                            cases=float(cases or 0.0) * share,
                            container_ref=container_ref, carrier_ref=carrier_ref)
    # The unit the curve is reported in: the carrier when one is named, else the
    # container, else raw pieces. Whatever the design actually says.
    if carrier_ref and conv["carriers"]:
        daily, unit_id = conv["carriers"], carrier_ref
    elif container_ref and conv["containers"]:
        daily, unit_id = conv["containers"], container_ref
    else:
        daily, unit_id = conv["pieces"], "piece"

    if not hours or up is None or down is None or daily <= 0:
        return {"hours": hours, "curve": [0.0] * len(hours), "peak": 0.0,
                "peak_hour": hours[0] if hours else None, "unit": unit_id,
                "unit_label": loadunit.label(unit_id, loadunit.by_id(model)),
                "daily": daily, "staging_m2": 0.0, "staging_tsubo": 0.0,
                "chain": conv["chain"], "provisional": conv["provisional"],
                "available": False}

    f_up = _fractions(_hourly_output(up))
    f_dn = _fractions(_hourly_output(down))
    n = min(len(hours), len(f_up), len(f_dn))
    curve = [max(0.0, (f_up[i] - f_dn[i]) * daily) for i in range(n)]
    curve += [0.0] * (len(hours) - n)

    peak = max(curve) if curve else 0.0
    peak_idx = curve.index(peak) if curve else 0
    units = loadunit.by_id(model)
    foot = float((units.get(unit_id) or {}).get("footprint_m2") or 0.0)
    staging_m2 = math.ceil(peak) * foot * AISLE_FACTOR

    return {
        "hours": hours,
        "curve": [round(c, 2) for c in curve],
        "peak": round(peak, 2),
        "peak_units": int(math.ceil(peak)),
        "peak_hour": hours[peak_idx] if hours else None,
        "unit": unit_id,
        "unit_label": loadunit.label(unit_id, units),
        "daily": round(daily, 1),
        "footprint_m2": foot,
        "staging_m2": round(staging_m2, 2),
        "staging_tsubo": round(staging_m2 / M2_PER_TSUBO, 2),
        "chain": conv["chain"],
        "provisional": conv["provisional"],
        "available": True,
    }


def all_edges(model, solved: dict, base_volumes: dict | None = None) -> dict:
    """滞留 for every leg of the flow, plus what the day needs in total.

    ``base_volumes`` is a :func:`whsim.bi.base_volumes` dict; the physical flow on
    a leg is taken from the section it belongs to (入荷 legs move inbound goods,
    出荷 legs outbound). Absent ⇒ no physical flow is invented and every curve
    reports ``available: False`` rather than a made-up number.
    """
    from whsim import flowgraph

    base = base_volumes or {}
    g = flowgraph.resolve(model)
    node_section = {n.id: n.section for n in g.nodes}

    rows: list[dict] = []
    for e in g.edges:
        if not e.src or not e.dst:
            continue
        inbound = str(node_section.get(e.dst) or "") == "入荷"
        pieces = float(base.get("in_pieces" if inbound else "out_pieces", 0.0) or 0.0)
        cases = float(base.get("in_cases" if inbound else "out_cases", 0.0) or 0.0)
        r = edge_wip(model, solved, e.src, e.dst, pieces=pieces, cases=cases,
                     container_ref=e.container_ref, carrier_ref=e.carrier_ref,
                     share=e.share)
        r.update({"src": e.src, "dst": e.dst, "transport": e.transport,
                  "container_ref": e.container_ref, "carrier_ref": e.carrier_ref})
        rows.append(r)

    # Carriers are a POOL: a cage waiting between 検品 and 梱包 is not available
    # to 出荷 at the same moment, so the fleet a design needs is the peak of the
    # SUM across legs sharing that unit, not the sum of each leg's own peak.
    by_unit: dict[str, list[float]] = {}
    for r in rows:
        # Legs with no 荷姿 named still report their WIP (in raw pieces) on the
        # edge itself, but they are NOT a fleet: there is no article to own or
        # park. Listing them here would put 「ピース 3,798」 next to 「カゴ台車 13」
        # as if both were things you buy.
        if not r.get("available") or r["unit"] in loadunit.BASE_UNITS:
            continue
        cur = by_unit.setdefault(r["unit"], [])
        for i, v in enumerate(r["curve"]):
            if i < len(cur):
                cur[i] += v
            else:
                cur.append(v)
    units = loadunit.by_id(model)
    fleet = []
    for uid, cur in by_unit.items():
        peak = max(cur) if cur else 0.0
        foot = float((units.get(uid) or {}).get("footprint_m2") or 0.0)
        m2 = math.ceil(peak) * foot * AISLE_FACTOR
        fleet.append({
            "unit": uid, "unit_label": loadunit.label(uid, units),
            "peak": round(peak, 2), "peak_units": int(math.ceil(peak)),
            "curve": [round(v, 2) for v in cur],
            "staging_m2": round(m2, 2), "staging_tsubo": round(m2 / M2_PER_TSUBO, 2),
        })
    fleet.sort(key=lambda f: -f["peak"])

    return {
        "hours": list((solved or {}).get("hours") or []),
        "edges": rows,
        "fleet": fleet,
        "total_staging_tsubo": round(sum(f["staging_tsubo"] for f in fleet), 2),
        "available": any(r.get("available") for r in rows),
    }
