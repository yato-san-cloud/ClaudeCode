"""Export a compact replay document from a run.

This is the contract the 2D canvas and 3D (three.js) viewers both consume, just
like the rest of the system hangs off one schema. Positions are stored as
worker keyframes (t, x, y, state); viewers linearly interpolate between frames.
"""

from __future__ import annotations

from whsim.engine.navnet import NavNetwork
from whsim.engine.run import RunResult
from whsim.render.shelves import shelf_runs
from whsim.schema.model import WarehouseModel


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
    stations = [
        {"id": s.id, "x": s.x, "y": s.y, "count": s.count}
        for s in model.resources.stations
    ]
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
    conveyors = [
        {"id": c.id, "points": c.points, "speed_mps": c.speed_mps}
        for c in model.resources.conveyors
    ]
    equipment = [
        {"id": e.id, "type": e.type, "x": e.x, "y": e.y, "count": e.count}
        for e in model.resources.equipment
    ]
    walls = [{"id": w.id, "points": w.points, "thickness": w.thickness}
             for w in model.layout.walls]
    doors = [{"id": d.id, "type": d.type, "x": d.x, "y": d.y, "w": d.w}
             for d in model.layout.doors]

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
        "shelves": shelf_runs(model),
        "navnet": _nav.to_dict() if _nav.obstacles else None,
        "stations": stations,
        "workers": workers,
        "agvs": agvs,
        "forklifts": forklifts,
        "conveyors": conveyors,
        "equipment": equipment,
        "walls": walls,
        "doors": doors,
        "routes": routes,
        "staging": staging,
        "kpis": kpis,
    }
