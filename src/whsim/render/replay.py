"""Export a compact replay document from a run.

This is the contract the 2D canvas and 3D (three.js) viewers both consume, just
like the rest of the system hangs off one schema. Positions are stored as
worker keyframes (t, x, y, state); viewers linearly interpolate between frames.
"""

from __future__ import annotations

import math

from whsim.engine.navnet import NavNetwork
from whsim.engine.routing import leg_cells
from whsim.engine.run import RunResult
from whsim.render.shelves import shelf_runs
from whsim.schema.model import WarehouseModel

# Keep the replay congestion grid coarse enough to stay cheap to ship and draw:
# a sparse cell list bounded by this many non-empty cells (the resolution is
# automatically coarsened for large floors so we never blow past it).
_MAX_CONGEST_CELLS = 400


def _productivity_series(res: RunResult) -> list[dict]:
    """A playback-head-synced productivity timeline for the live graph.

    Buckets the replay window into ~30s intervals (capped at ~120 points) and,
    per bucket, reports cumulative completions (`done`), the bucket's throughput
    in orders/hour (`rate`), the 仮置き WIP at that time forward-filled from
    staging events (`wip`), and a best-effort count of concurrently active work
    (`active`). Purely additive; returns [] when there are no events / no window
    so callers never break.
    """
    events = getattr(res, "events", None) or []
    win = res.replay_window_s or res.duration_s or 0.0
    if win <= 0 or not events:
        return []

    # Bucket geometry: ~30s buckets, but never more than ~120 points.
    target = 30.0
    n = max(1, int(round(win / target)))
    n = min(n, 120)
    step = win / n

    completes = sorted(e["t"] for e in events
                       if e.get("event") == "order_complete" and e.get("t", 0) <= win)

    # staging WIP samples (t, wip) within the window, for forward-fill.
    wip_samples = sorted(
        ((e["t"], int(e.get("wip", 0))) for e in events
         if e.get("event") in ("staging_put", "staging_get") and e.get("t", 0) <= win),
        key=lambda p: p[0])

    # Active work intervals from pick_start/pick_done pairs per worker, so we can
    # count how many were mid-pick at each bucket time. Best-effort: skipped if
    # the pairing is incomplete.
    open_by_worker: dict = {}
    intervals: list[tuple[float, float]] = []
    for e in sorted(events, key=lambda x: x.get("t", 0)):
        ev = e.get("event")
        if ev == "pick_start":
            open_by_worker[e.get("worker")] = e.get("t", 0.0)
        elif ev == "pick_done":
            wid = e.get("worker")
            if wid in open_by_worker:
                intervals.append((open_by_worker.pop(wid), e.get("t", 0.0)))

    series: list[dict] = []
    ci = 0          # cursor into completes
    wi = 0          # cursor into wip_samples
    last_wip = 0
    done = 0
    for k in range(1, n + 1):
        edge = win if k == n else step * k
        bstart = step * (k - 1)
        in_bucket = 0
        while ci < len(completes) and completes[ci] <= edge:
            in_bucket += 1
            ci += 1
        done += in_bucket
        rate = in_bucket * 3600.0 / step if step > 0 else 0.0
        while wi < len(wip_samples) and wip_samples[wi][0] <= edge:
            last_wip = wip_samples[wi][1]
            wi += 1
        active = sum(1 for s, e2 in intervals if s <= edge and e2 > bstart) \
            if intervals else 0
        series.append({
            "t": round(edge, 1),
            "done": done,
            "rate": round(rate, 1),
            "wip": last_wip,
            "active": active,
        })
    return series


def _congestion_grid(model: WarehouseModel, res: RunResult) -> dict:
    """Per-cell congestion (occupancy/dwell) for the 2D canvas heatmap overlay.

    Mirrors the engine/png2d congestion logic: every agent leg is rasterised with
    the same L-shaped `leg_cells` walk the engine uses for its heat grid, so the
    canvas overlay matches the proposal PNG. We accumulate over agent keyframe
    trajectories within the replay window (the keyframes ARE the recorded
    trajectory samples), then normalise so the busiest cell == 1.0.

    Always returned (never None) so the client can rely on the key; `cells` is
    empty when nothing moved. The grid is coarsened for large floors so the cell
    list stays sparse and bounded (≤ _MAX_CONGEST_CELLS). Tolerates degenerate
    bounds (zero/negative width/depth) without dividing by zero.
    """
    width = max(float(getattr(model.layout.bounds, "width", 0.0) or 0.0), 0.0)
    depth = max(float(getattr(model.layout.bounds, "depth", 0.0) or 0.0), 0.0)
    win = res.replay_window_s or res.duration_s or 0.0

    # Choose a cell size: start from the model's heatmap resolution, then coarsen
    # until the worst-case full grid fits the cell budget (keeps it sane & sparse).
    grid_m = float(getattr(model.simulation, "heatmap_grid_m", 1.0) or 1.0)
    if grid_m <= 0:
        grid_m = 1.0
    if width > 0 and depth > 0:
        while (math.ceil(width / grid_m) * math.ceil(depth / grid_m)
               > _MAX_CONGEST_CELLS):
            grid_m *= 1.5
    nx = max(1, math.ceil(width / grid_m)) if width > 0 else 0
    ny = max(1, math.ceil(depth / grid_m)) if depth > 0 else 0

    empty = {"grid_m": round(grid_m, 3), "nx": nx, "ny": ny, "cells": []}
    if nx == 0 or ny == 0:
        return empty

    # Gather every agent's trajectory (all carry (t, x, y, state) keyframes).
    tracks: list[list] = []
    tracks += [w.keyframes for w in res.workers]
    for attr in ("helpers", "packers", "inspectors", "agvs", "forklifts"):
        tracks += [a.keyframes for a in getattr(res, attr, []) if a.keyframes]

    counts: dict[tuple[int, int], float] = {}
    for kf in tracks:
        # Keyframes are (t, x, y, state[, meta]) — slice the first 3 so a 5-tuple
        # (upper-段 pick carrying level meta) does not break the unpack.
        for a, b in zip(kf, kf[1:]):
            t0, x0, y0 = a[0], a[1], a[2]
            x1, y1 = b[1], b[2]
            if win and t0 > win:
                break
            for gx, gy in leg_cells((x0, y0), (x1, y1), grid_m):
                if 0 <= gx < nx and 0 <= gy < ny:
                    counts[(gx, gy)] = counts.get((gx, gy), 0.0) + 1.0

    if not counts:
        return empty

    peak = max(counts.values())
    if peak <= 0:
        return empty
    # Sparse, normalised cell list; drop near-zero cells to keep the payload light.
    cells = [[gx, gy, round(c / peak, 3)]
             for (gx, gy), c in counts.items() if c / peak >= 0.02]
    cells.sort(key=lambda c: (c[1], c[0]))
    return {"grid_m": round(grid_m, 3), "nx": nx, "ny": ny, "cells": cells}


def _pick_targets(shelves: list[dict]) -> list[tuple]:
    """Flatten authored shelf runs into pickable targets for `hit` derivation.

    Each target is (cx, cy, run_id, along, sku, qty): the cell's floor position,
    its run index, the cell's fractional position ALONG the run (0..1, so the 3D
    can find the bay without re-deriving geometry), and its SKU/qty. Only runs
    that actually carry per-cell SKU detail (the authored / detailed path) yield
    targets; a bare reconstructed run with no SKUs yields none, so `hit` is simply
    absent rather than wrong.
    """
    targets: list[tuple] = []
    for ri, run in enumerate(shelves):
        cells = run.get("cells") or []
        y0 = run.get("y0", 0.0)
        y1 = run.get("y1", 0.0)
        span = (y1 - y0) or 1.0
        x = run.get("x", 0.0)
        for c in cells:
            sku = c.get("sku")
            if not sku:
                continue
            cy = c.get("y", y0)
            along = min(1.0, max(0.0, (cy - y0) / span))
            targets.append((x, cy, ri, round(along, 4), sku, int(c.get("qty", 0) or 0)))
    return targets


def _attach_pick_hits(model: WarehouseModel, workers: list[dict],
                      shelves: list[dict]) -> None:
    """Best-effort: tag each `pick`-state worker keyframe with the cell it hit.

    The engine's keyframes are `[t, x, y, state]` and do NOT carry which Location
    was picked, so we derive a hit geometrically: for a `pick` keyframe, snap to
    the NEAREST authored shelf cell (the picker stands at the aisle face of the
    slot it is reaching into). Appends a 5th element

        hit = {run_id, along, sku, qty}

    only when a target is found within a sane reach radius; otherwise the keyframe
    is left as the original 4-tuple. Fully backward-compatible: `sampleKeyframes`
    and the 2D canvas both index [0..3] and ignore any extra element. Mutates the
    `workers` keyframe lists in place (they are fresh copies surfaced by caller).

    Gated to models that carry **authored** `ShelfArea`s (the MapMaker / M1
    target). Legacy reconstructed-rack replays keep pure 4-tuple keyframes — so
    the established replay contract (and its tests) is unchanged — while
    free-placed MapMaker shelves, whose rectangles 3D draws individually, gain the
    pick-event geometry the new 3D viz needs.
    """
    authored = any(
        z.type == "storage" and getattr(z, "shelves", None)
        for z in model.layout.zones
    )
    if not authored:
        return
    targets = _pick_targets(shelves)
    if not targets:
        return
    # Reach radius: a picker reaching a slot is within ~one aisle-width of it.
    # Beyond this we leave the keyframe untagged rather than point at a far shelf.
    max_r2 = 4.0 ** 2
    for w in workers:
        kfs = w.get("keyframes") or []
        new_kfs = []
        for kf in kfs:
            # Only augment 4-tuple pick frames; pass everything else through as-is.
            if len(kf) >= 4 and kf[3] == "pick":
                px, py = kf[1], kf[2]
                best = None
                best_d2 = max_r2
                for (cx, cy, ri, along, sku, qty) in targets:
                    d2 = (cx - px) ** 2 + (cy - py) ** 2
                    if d2 < best_d2:
                        best_d2 = d2
                        best = (ri, along, sku, qty)
                if best is not None:
                    ri, along, sku, qty = best
                    # MERGE into any existing meta (the engine's 段 level/height for
                    # the vertical animation) so both coexist in one dict.
                    existing = kf[4] if len(kf) >= 5 and isinstance(kf[4], dict) else {}
                    kf = [kf[0], kf[1], kf[2], kf[3],
                          {**existing, "run_id": ri, "along": along, "sku": sku, "qty": qty}]
            new_kfs.append(kf)
        w["keyframes"] = new_kfs


def _station_dict(s) -> dict:
    """One bench for the replay contract.

    ``w``/``d`` (the bench's plan footprint) are emitted ONLY when the model
    states them: the 3D falls back to its historical fixed 2.0×0.9 desk when the
    key is absent, and a ``null`` would read as a real zero there. So a model
    that never sets a footprint ships a byte-identical replay.
    """
    out = {"id": s.id, "x": s.x, "y": s.y, "count": s.count}
    if getattr(s, "w", None) is not None:
        out["w"] = float(s.w)
    if getattr(s, "d", None) is not None:
        out["d"] = float(s.d)
    return out


def _conveyor_dict(c) -> dict:
    """One belt for the replay contract (``elevation_m`` only when stated —
    same additive-and-guarded rule as the bench footprint above)."""
    out = {"id": c.id, "points": c.points, "speed_mps": c.speed_mps}
    if getattr(c, "elevation_m", None) is not None:
        out["elevation_m"] = float(c.elevation_m)
    return out


def build_layout_replay(model: WarehouseModel) -> dict:
    """A run-free replay carrying only the STATIC layout — zones, racks/shelves,
    walls, doors, stations, equipment, conveyors, routes — so the 2D/3D viewers can
    show the CURRENT design the moment it is saved, before any simulation. Agent
    tracks / heat / KPIs are empty (there is no run yet); ``layout_only`` flags this
    so the UI can prompt ▶実行 to see the movement."""
    _nav = NavNetwork.from_model(model)
    by_sku = model.item_by_sku()
    racks = [{"x": loc.x, "y": loc.y,
              "abc": by_sku[loc.sku].abc_class if loc.sku in by_sku else "C"}
             for loc in model.locations]
    zones = [{"id": z.id, "type": z.type, "x": z.x, "y": z.y, "w": z.w, "h": z.h,
              "color": z.color} for z in model.layout.zones]
    stations = [_station_dict(s) for s in model.resources.stations]
    routes = [{"id": r.id, "name": r.name, "mover": r.mover,
               "speed_mps": r.speed_mps, "points": r.points} for r in model.routes]
    conveyors = [_conveyor_dict(c) for c in model.resources.conveyors]
    equipment = [{"id": e.id, "type": e.type, "x": e.x, "y": e.y, "count": e.count}
                 for e in model.resources.equipment]
    walls = [{"id": w.id, "points": w.points, "thickness": w.thickness}
             for w in model.layout.walls]
    doors = [{"id": d.id, "type": d.type, "x": d.x, "y": d.y, "w": d.w}
             for d in model.layout.doors]
    dur = float(model.simulation.duration_s or 0.0)
    return {
        "layout_only": True,
        "meta": {"name": model.meta.name, "duration_s": dur, "replay_window_s": dur,
                 "bounds": {"width": model.layout.bounds.width,
                            "depth": model.layout.bounds.depth},
                 "grid_m": model.simulation.heatmap_grid_m},
        "zones": zones, "racks": racks, "shelves": shelf_runs(model),
        "navnet": _nav.to_dict() if _nav.obstacles else None,
        "stations": stations, "workers": [], "agvs": [], "forklifts": [],
        "conveyors": conveyors, "equipment": equipment, "walls": walls, "doors": doors,
        "routes": routes, "staging": None, "congestion": None, "series": [], "kpis": {},
    }


def build_replay(model: WarehouseModel, res: RunResult, kpis: dict) -> dict:
    by_sku = model.item_by_sku()
    _nav = NavNetwork.from_model(model)  # MapMaker-style waypoint/Delaunay net
    racks = []
    for loc in model.locations:
        cls = by_sku[loc.sku].abc_class if loc.sku in by_sku else "C"
        racks.append({"x": loc.x, "y": loc.y, "abc": cls})

    zones = [
        {"id": z.id, "type": z.type, "x": z.x, "y": z.y, "w": z.w, "h": z.h,
         "color": z.color}
        for z in model.layout.zones
    ]
    stations = [_station_dict(s) for s in model.resources.stations]
    workers = [
        {"id": w.id, "role": w.role, "keyframes": w.keyframes}
        for w in res.workers
    ]
    # Parallel-zone legs run concurrently on their own replay tracks (so a single
    # worker never teleports between zones); surface them as extra worker agents.
    workers += [
        {"id": h.id, "role": h.role, "keyframes": h.keyframes}
        for h in getattr(res, "helpers", [])
        if h.keyframes
    ]
    # Dedicated packer agents (仮置き staged mode) are individual workers with a
    # position + "pack"/"idle" states, so the 2D/3D viewers animate them like any
    # other worker (the "pack" colour already exists). Absent in legacy mode.
    workers += [
        {"id": p.id, "role": p.role, "keyframes": p.keyframes}
        for p in getattr(res, "packers", [])
        if p.keyframes
    ]
    # 入荷検品 agents — same idea, animated with the "inspect" state colour.
    workers += [
        {"id": ins.id, "role": ins.role, "keyframes": ins.keyframes}
        for ins in getattr(res, "inspectors", [])
        if ins.keyframes
    ]
    agvs = [
        {"id": a.id, "keyframes": a.keyframes}
        for a in res.agvs
    ]
    forklifts = [
        {"id": f.id, "keyframes": f.keyframes}
        for f in getattr(res, "forklifts", [])
    ]
    routes = [
        {"id": r.id, "name": r.name, "mover": r.mover,
         "speed_mps": r.speed_mps, "points": r.points}
        for r in model.routes
    ]
    conveyors = [_conveyor_dict(c) for c in model.resources.conveyors]
    # コンベア搬送: the goods as their own tracks — keyframes are (t, x, y, state)
    # exactly like a worker's, with state in {"carry","belt","pack"}. Additive and
    # guarded: an engine/run artefact without totes (or any model with no conveyor)
    # yields an empty list, so viewers that ignore it are unaffected.
    # ``kind`` (荷の種別 — what a 選択停止ゲート sorts on) and ``belt_id`` (which deck
    # of a 2段駆動コンベア this box rides) ride along ONLY when the engine set them:
    # an unset key is omitted entirely rather than emitted as null, because a
    # viewer reading ``null`` as a belt id would snap the box to the wrong deck.
    totes = [
        {"id": t.id, "keyframes": t.keyframes,
         **({"kind": t.kind} if getattr(t, "kind", None) else {}),
         **({"belt_id": t.belt_id} if getattr(t, "belt_id", None) else {})}
        for t in getattr(res, "totes", []) or []
        if t.keyframes
    ]
    equipment = [
        {"id": e.id, "type": e.type, "x": e.x, "y": e.y, "count": e.count}
        for e in model.resources.equipment
    ]
    walls = [{"id": w.id, "points": w.points, "thickness": w.thickness}
             for w in model.layout.walls]
    doors = [{"id": d.id, "type": d.type, "x": d.x, "y": d.y, "w": d.w}
             for d in model.layout.doors]

    # Shelf runs (one truth for 2D/PNG/3D). Compute once, then best-effort tag
    # `pick`-state worker keyframes with the cell they reach (the 3D pick-event
    # viz). Backward-compatible: 4-tuple keyframes stay valid when no hit derives.
    shelves = shelf_runs(model)
    _attach_pick_hits(model, workers, shelves)

    # 仮置き(staging): a finite buffer whose WIP (滞留数) rises and falls. Surface
    # its footprint + an exact (t, wip) timeline so the 2D/3D viewers can colour it
    # by occupancy at the current playback time. Only present in staged mode.
    staging = None
    staging_events = [e for e in res.events
                      if e["event"] in ("staging_put", "staging_get")]
    # Only surface the buffer when it was actually used (manual non-conveyor path):
    # with a conveyor/AGV the engine bypasses staging, so don't draw an empty box.
    if getattr(res, "staging_capacity", 0) > 0 and staging_events:
        win = res.replay_window_s or res.duration_s
        timeline = sorted(
            ([round(e["t"], 1), int(e.get("wip", 0))] for e in staging_events
             if e["t"] <= win),          # only the playback window keeps it light
            key=lambda p: p[0])
        sz = next((z for z in model.layout.zones if z.type == "staging"), None)
        if sz is not None:
            box = {"x": sz.x, "y": sz.y, "w": sz.w, "h": sz.h}
        else:
            st = model.resources.stations[0] if model.resources.stations else None
            bx, by = (st.x, st.y) if st else (0.0, 0.0)
            box = {"x": bx + 2.0, "y": by, "w": 3.0, "h": 3.0}
        staging = {**box, "capacity": res.staging_capacity, "timeline": timeline}

    return {
        "meta": {
            "name": model.meta.name,
            "duration_s": res.duration_s,
            "replay_window_s": res.replay_window_s,
            "bounds": {"width": model.layout.bounds.width,
                       "depth": model.layout.bounds.depth},
            "grid_m": model.simulation.heatmap_grid_m,
        },
        "zones": zones,
        "racks": racks,
        "shelves": shelves,
        "navnet": _nav.to_dict() if _nav.obstacles else None,
        "stations": stations,
        "workers": workers,
        "agvs": agvs,
        "forklifts": forklifts,
        "conveyors": conveyors,
        "totes": totes,
        "equipment": equipment,
        "walls": walls,
        "doors": doors,
        "routes": routes,
        "staging": staging,
        "congestion": _congestion_grid(model, res),
        "series": _productivity_series(res),
        "kpis": kpis,
    }
