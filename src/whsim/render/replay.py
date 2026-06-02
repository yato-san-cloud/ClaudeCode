"""Export a compact replay document from a run.

This is the contract the 2D canvas and 3D (three.js) viewers both consume, just
like the rest of the system hangs off one schema. Positions are stored as
worker keyframes (t, x, y, state); viewers linearly interpolate between frames.
"""

from __future__ import annotations

from whsim.engine.run import RunResult
from whsim.render.shelves import shelf_runs
from whsim.schema.model import WarehouseModel


def build_replay(model: WarehouseModel, res: RunResult, kpis: dict) -> dict:
    by_sku = model.item_by_sku()
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
        "stations": stations,
        "workers": workers,
        "agvs": agvs,
        "forklifts": forklifts,
        "conveyors": conveyors,
        "equipment": equipment,
        "walls": walls,
        "doors": doors,
        "routes": routes,
        "kpis": kpis,
    }
