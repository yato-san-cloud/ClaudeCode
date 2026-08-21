#!/usr/bin/env python3
"""chrono-lens 用 ダミーラン生成器 (WHSIM_CONTRACTS v1.0 準拠)

標準ライブラリのみ。WHSiM 本体に依存しない。

使い方:
    python gen_dummy.py small   -o /path/to/runs   # 既知ケース (待機ちょうど2件)
    python gen_dummy.py large   -o /path/to/runs   # 負荷ケース (positions 約150万行)
    python gen_dummy.py invalid -o /path/to/runs   # 契約違反ケース (拒否画面の確認用)

出力 (runs/<run_id>/):
    layout.geojson / scenario.json / events.jsonl / positions.jsonl
    summary.json / meta.json
    expected.json   … 自己検証用の期待値 (契約外のテスト補助ファイル。ビューアは読まない)

`summary.json` の数値はすべて生成した events.jsonl / positions.jsonl から
集計している (契約 §6「他経路で数値を作らない」)。
"""

from __future__ import annotations

import argparse
import array
import datetime as _dt
import hashlib
import heapq
import json
import math
import os
import random
import sys

SCHEMA_VERSION = "1.0"
GENERATOR = "chronolens/gen_dummy.py"

# --------------------------------------------------------------------------
# レイアウト生成 (通路グラフ + ラック)
# --------------------------------------------------------------------------


def build_layout(n_aisles: int = 5, aisle_pitch: float = 7.0,
                 rack_margin: float = 1.5, y_bottom: float = 2.0,
                 y_top: float = 22.0, n_rungs: int = 6):
    """縦通路 n_aisles 本 + 上下のクロス通路。ラックは通路の間に置く。

    通路 (edge) は必ずラック矩形の外側を通る -> 契約 §7 の交差0件を構造的に満たす。
    戻り値: (geojson, nodes{id:(x,y)}, adj{id:[(id,dist)]}, loc_nodes[list])
    """
    features = []
    xs = [3.0 + i * aisle_pitch for i in range(n_aisles)]

    # --- ラック (通路の間の帯) -------------------------------------------
    racks = []
    for i in range(n_aisles - 1):
        x0 = xs[i] + rack_margin
        x1 = xs[i + 1] - rack_margin
        # 縦に 2 ブロック (中間にクロス通路を作らないので単純な2分割)
        for b, (ya, yb) in enumerate([(4.0, 12.0), (14.0, 20.0)]):
            rid = f"R{i:02d}{b}"
            racks.append((rid, x0, ya, x1, yb))
            features.append({
                "type": "Feature",
                "properties": {"kind": "rack", "id": rid, "label": f"ラック{i + 1}-{b + 1}"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[x0, ya], [x1, ya], [x1, yb], [x0, yb], [x0, ya]]],
                },
            })

    # --- ノード ----------------------------------------------------------
    nodes: dict[str, tuple[float, float]] = {}
    loc_nodes: list[str] = []
    rung_ys = [y_bottom] + [
        y_bottom + (y_top - y_bottom) * (k + 1) / (n_rungs + 1) for k in range(n_rungs)
    ] + [y_top]
    for i, x in enumerate(xs):
        for k, y in enumerate(rung_ys):
            nid = f"n{i:02d}{k:02d}"
            nodes[nid] = (round(x, 3), round(y, 3))
            props = {"kind": "node", "id": nid}
            if 0 < k < len(rung_ys) - 1:  # 通路の中間 = 間口 (ロケーション)
                props["loc_id"] = f"A{i:02d}-{k:02d}"
                loc_nodes.append(nid)
            features.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Point", "coordinates": [round(x, 3), round(y, 3)]},
            })
    depot = "nDEP"
    nodes[depot] = (0.5, y_bottom)
    features.append({
        "type": "Feature",
        "properties": {"kind": "node", "id": depot, "loc_id": "DEPOT"},
        "geometry": {"type": "Point", "coordinates": [0.5, y_bottom]},
    })

    # --- エッジ ----------------------------------------------------------
    adj: dict[str, list[tuple[str, float]]] = {nid: [] for nid in nodes}
    eid = 0

    def add_edge(a: str, b: str, width: float = 3.0):
        nonlocal eid
        (xa, ya), (xb, yb) = nodes[a], nodes[b]
        d = math.dist((xa, ya), (xb, yb))
        adj[a].append((b, d))
        adj[b].append((a, d))
        features.append({
            "type": "Feature",
            "properties": {"kind": "edge", "id": f"e{eid:03d}", "from": a, "to": b,
                           "width_m": width},
            "geometry": {"type": "LineString", "coordinates": [[xa, ya], [xb, yb]]},
        })
        eid += 1

    for i in range(n_aisles):
        for k in range(len(rung_ys) - 1):
            add_edge(f"n{i:02d}{k:02d}", f"n{i:02d}{k + 1:02d}")
    for i in range(n_aisles - 1):  # 上下クロス通路
        add_edge(f"n{i:02d}{0:02d}", f"n{i + 1:02d}{0:02d}", 4.0)
        last = len(rung_ys) - 1
        add_edge(f"n{i:02d}{last:02d}", f"n{i + 1:02d}{last:02d}", 4.0)
    add_edge(depot, f"n{0:02d}{0:02d}", 4.0)

    # --- ゾーン (意味領域) -----------------------------------------------
    features.append({
        "type": "Feature",
        "properties": {"kind": "zone", "id": "z_ship", "label": "出荷バース"},
        "geometry": {"type": "Polygon", "coordinates": [[
            [0.0, 0.0], [6.0, 0.0], [6.0, 3.2], [0.0, 3.2], [0.0, 0.0]]]},
    })
    max_x = xs[-1] + rack_margin + 1.5
    features.append({
        "type": "Feature",
        "properties": {"kind": "zone", "id": "z_pack", "label": "梱包エリア"},
        "geometry": {"type": "Polygon", "coordinates": [[
            [max_x - 5.0, 0.0], [max_x, 0.0], [max_x, 3.2], [max_x - 5.0, 3.2],
            [max_x - 5.0, 0.0]]]},
    })

    geojson = {
        "type": "FeatureCollection",
        "meta": {"crs": "local-meters", "schema_version": SCHEMA_VERSION,
                 "generator": GENERATOR},
        "features": features,
    }
    return geojson, nodes, adj, loc_nodes, depot


def dijkstra(adj, nodes, src, dst):
    """最短経路 (ノードid列)。"""
    if src == dst:
        return [src]
    dist = {src: 0.0}
    prev: dict[str, str] = {}
    pq = [(0.0, src)]
    seen = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in seen:
            continue
        seen.add(u)
        if u == dst:
            break
        for v, w in adj[u]:
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    if dst not in dist:
        return [src]
    path = [dst]
    while path[-1] != src:
        path.append(prev[path[-1]])
    path.reverse()
    return path


# --------------------------------------------------------------------------
# 走行シミュレーション (時間グリッド上の状態機械)
# --------------------------------------------------------------------------


class Actor:
    __slots__ = ("aid", "dest", "did_wait", "node", "route", "seg", "seg_s",
                 "state", "task_no", "task_t", "timer", "x", "y")

    def __init__(self, aid, node, xy):
        self.aid = aid
        self.node = node
        self.state = "idle"
        self.timer = 0.0
        self.route: list[str] = []
        self.seg = 0
        self.seg_s = 0.0
        self.x, self.y = xy
        self.dest = node
        self.task_t = 0.0
        self.did_wait = False
        self.task_no = 0


def simulate(nodes, adj, loc_nodes, depot, n_actors, duration_s, dt,
             speed_mps, seed, scripted_waits=None, wait_prob=0.0,
             pick_mu=2.35, pick_sigma=0.35):
    """時間グリッド (0, dt, 2dt, ...) 上で全アクタを進める。

    scripted_waits: [(actorId, node_id, start_t, dur_s)] — 既知ケース用の仕込み待機。
    wait_prob     : 到着時に確率的な待ち行列待機を発生させる確率 (負荷ケース用)。
    戻り値: (events[list[dict]], px{aid: array('f')}, py{aid: array('f')}, n_steps)
    """
    rnd = random.Random(seed)
    steps = int(duration_s / dt) + 1
    actors = [Actor(f"P{i + 1:02d}", depot, nodes[depot]) for i in range(n_actors)]
    px = {a.aid: array.array("f", bytes(4 * steps)) for a in actors}
    py = {a.aid: array.array("f", bytes(4 * steps)) for a in actors}
    events: list[dict] = []

    scripted = {}
    for (aid, nid, st, dur) in (scripted_waits or []):
        scripted.setdefault(aid, []).append((st, nid, dur))
    for v in scripted.values():
        v.sort()

    def ev(t, typ, aid, frm=None, to=None, meta=None):
        e = {"t": round(t, 3), "type": typ, "actorId": aid}
        if frm is not None:
            e["from"] = frm
        if to is not None:
            e["to"] = to
        e["meta"] = meta or {}
        events.append(e)

    def route_len(route):
        return sum(math.dist(nodes[route[i]], nodes[route[i + 1]])
                   for i in range(len(route) - 1))

    # 初期状態: 全員 depot で idle
    for k in range(steps):
        t = k * dt
        for a in actors:
            # --- 仕込み待機の発火 (状態に関わらず最優先) ------------------
            sc = scripted.get(a.aid)
            if sc and a.state != "wait" and sc[0][0] <= t and a.node == sc[0][1]:
                st, nid, dur = sc.pop(0)
                ev(t, "wait_start", a.aid, frm=a.node,
                   meta={"reason": "scripted", "node": nid})
                a.state = "wait"
                a.timer = dur

            if a.state == "idle":
                if t + 1.0 >= duration_s:
                    pass
                else:
                    a.task_no += 1
                    a.dest = loc_nodes[rnd.randrange(len(loc_nodes))]
                    a.task_t = t
                    ev(t, "task_assign", a.aid, frm=a.node, to=a.dest,
                       meta={"order_id": f"O{a.aid}-{a.task_no:05d}"})
                    a.route = dijkstra(adj, nodes, a.node, a.dest)
                    a.seg = 0
                    a.seg_s = 0.0
                    ev(t, "move_start", a.aid, frm=a.node, to=a.dest,
                       meta={"path_m": round(route_len(a.route), 2)})
                    a.state = "move"
            elif a.state == "move":
                rem = speed_mps * dt
                while rem > 0 and a.seg < len(a.route) - 1:
                    p0 = nodes[a.route[a.seg]]
                    p1 = nodes[a.route[a.seg + 1]]
                    seg_len = math.dist(p0, p1)
                    left = seg_len - a.seg_s
                    if rem < left:
                        a.seg_s += rem
                        rem = 0.0
                    else:
                        rem -= left
                        a.seg += 1
                        a.seg_s = 0.0
                if a.seg >= len(a.route) - 1:
                    a.node = a.dest
                    a.x, a.y = nodes[a.dest]
                    ev(t, "move_end", a.aid, frm=a.route[0], to=a.dest)
                    if wait_prob and rnd.random() < wait_prob:
                        ev(t, "wait_start", a.aid, frm=a.dest,
                           meta={"reason": "congestion"})
                        a.state = "wait"
                        a.timer = rnd.uniform(4.0, 40.0)
                    else:
                        ev(t, "pick_start", a.aid, frm=a.dest)
                        a.state = "pick"
                        a.timer = rnd.lognormvariate(pick_mu, pick_sigma)
                else:
                    p0 = nodes[a.route[a.seg]]
                    p1 = nodes[a.route[a.seg + 1]]
                    seg_len = math.dist(p0, p1) or 1.0
                    r = a.seg_s / seg_len
                    a.x = p0[0] + (p1[0] - p0[0]) * r
                    a.y = p0[1] + (p1[1] - p0[1]) * r
            elif a.state == "wait":
                a.timer -= dt
                if a.timer <= 0:
                    ev(t, "wait_end", a.aid, frm=a.node)
                    if a.node == depot:
                        a.state = "idle"
                    else:
                        ev(t, "pick_start", a.aid, frm=a.node)
                        a.state = "pick"
                        a.timer = rnd.lognormvariate(pick_mu, pick_sigma)
            elif a.state == "pick":
                a.timer -= dt
                if a.timer <= 0:
                    qty = rnd.randint(1, 6)
                    ev(t, "pick_end", a.aid, frm=a.node, meta={"qty": qty})
                    ev(t, "load", a.aid, frm=a.node, meta={"qty": qty})
                    if a.task_no % 4 == 0:  # 4件に1回 デポへ戻して unload
                        a.dest = depot
                        a.route = dijkstra(adj, nodes, a.node, depot)
                        a.seg = 0
                        a.seg_s = 0.0
                        ev(t, "move_start", a.aid, frm=a.node, to=depot,
                           meta={"path_m": round(route_len(a.route), 2)})
                        a.state = "return"
                    else:
                        a.state = "idle"
            elif a.state == "return":
                rem = speed_mps * dt
                while rem > 0 and a.seg < len(a.route) - 1:
                    p0 = nodes[a.route[a.seg]]
                    p1 = nodes[a.route[a.seg + 1]]
                    seg_len = math.dist(p0, p1)
                    left = seg_len - a.seg_s
                    if rem < left:
                        a.seg_s += rem
                        rem = 0.0
                    else:
                        rem -= left
                        a.seg += 1
                        a.seg_s = 0.0
                if a.seg >= len(a.route) - 1:
                    a.node = depot
                    a.x, a.y = nodes[depot]
                    ev(t, "move_end", a.aid, frm=a.route[0], to=depot)
                    ev(t, "unload", a.aid, frm=depot)
                    a.state = "idle"
                else:
                    p0 = nodes[a.route[a.seg]]
                    p1 = nodes[a.route[a.seg + 1]]
                    seg_len = math.dist(p0, p1) or 1.0
                    r = a.seg_s / seg_len
                    a.x = p0[0] + (p1[0] - p0[0]) * r
                    a.y = p0[1] + (p1[1] - p0[1]) * r

            px[a.aid][k] = a.x
            py[a.aid][k] = a.y

    # 開いたままの wait を閉じる (契約 §7: wait_start と wait_end の対応)
    for a in actors:
        if a.state == "wait":
            ev(duration_s, "wait_end", a.aid, frm=a.node, meta={"reason": "run_end"})

    events.sort(key=lambda e: (e["t"],))
    return events, px, py, steps


# --------------------------------------------------------------------------
# 集計 (events / positions からのみ)
# --------------------------------------------------------------------------


def percentile(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = (len(sorted_vals) - 1) * q
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return float(sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac)


def summarize(events, px, py, dt, duration_s, actor_ids):
    total_distance = 0.0
    for aid in actor_ids:
        xs, ys = px[aid], py[aid]
        for i in range(1, len(xs)):
            total_distance += math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])

    waits: list[float] = []
    open_wait: dict[str, float] = {}
    picks = 0
    busy = {aid: 0.0 for aid in actor_ids}
    open_task: dict[str, float] = {}
    for e in events:
        typ, aid, t = e["type"], e["actorId"], e["t"]
        if typ == "wait_start":
            open_wait[aid] = t
        elif typ == "wait_end":
            if aid in open_wait:
                waits.append(t - open_wait.pop(aid))
        elif typ == "pick_end":
            picks += 1
        if typ == "task_assign":
            open_task[aid] = t
        elif typ in ("unload", "pick_end") and aid in open_task:
            if typ == "pick_end":
                busy[aid] += t - open_task[aid]
                open_task.pop(aid)
            else:
                busy[aid] += 0.0
    waits.sort()
    hours = duration_s / 3600.0
    return {
        "schema_version": SCHEMA_VERSION,
        "rows_per_hour": round(picks / hours, 4) if hours else 0.0,
        "total_distance_m": round(total_distance, 3),
        "wait_time_s": {
            "mean": round(sum(waits) / len(waits), 4) if waits else 0.0,
            "p50": round(percentile(waits, 0.50), 4),
            "p95": round(percentile(waits, 0.95), 4),
            "total": round(sum(waits), 4),
        },
        "utilization": {aid: round(min(1.0, busy[aid] / duration_s), 5)
                        for aid in actor_ids},
    }


def heat_expectation(px, py, dt, actor_ids, layout, cell=1.0):
    """ビューアと同じ規約で滞在時間グリッドを作り、最大セルを返す。

    規約: 原点 = layout の全座標のバウンディングボックス最小値、セル = cell[m]、
          サンプル i の重み = t[i+1] - t[i] (最終サンプルは重み0)。
    """
    minx = miny = math.inf
    maxx = maxy = -math.inf

    def walk(c):
        nonlocal minx, miny, maxx, maxy
        if isinstance(c[0], (int, float)):
            minx = min(minx, c[0]); maxx = max(maxx, c[0])
            miny = min(miny, c[1]); maxy = max(maxy, c[1])
        else:
            for s in c:
                walk(s)

    for f in layout["features"]:
        walk(f["geometry"]["coordinates"])
    nx = max(1, math.ceil((maxx - minx) / cell))
    ny = max(1, math.ceil((maxy - miny) / cell))
    grid = [0.0] * (nx * ny)
    for aid in actor_ids:
        xs, ys = px[aid], py[aid]
        for i in range(len(xs) - 1):  # 最終サンプルは重み0
            gx = int((xs[i] - minx) / cell)
            gy = int((ys[i] - miny) / cell)
            if 0 <= gx < nx and 0 <= gy < ny:
                grid[gy * nx + gx] += dt
    best = max(range(len(grid)), key=lambda i: grid[i])
    return {
        "cell_m": cell,
        "grid_origin": [round(minx, 4), round(miny, 4)],
        "grid_size": [nx, ny],
        "max_cell_index": [best % nx, best // nx],
        "max_cell_center_m": [round(minx + (best % nx + 0.5) * cell, 3),
                              round(miny + (best // nx + 0.5) * cell, 3)],
        "max_cell_dwell_s": round(grid[best], 3),
    }


# --------------------------------------------------------------------------
# 書き出し
# --------------------------------------------------------------------------


def write_jsonl(path, rows_iter):
    n = 0
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows_iter:
            fh.write(row)
            fh.write("\n")
            n += 1
    return n


def positions_lines(px, py, actor_ids, steps, dt):
    """t 昇順 (契約 §7: 単調非減少) で positions 行を吐く。"""
    for k in range(steps):
        t = round(k * dt, 3)
        for aid in actor_ids:
            yield ('{"t": %s, "actorId": "%s", "x": %.3f, "y": %.3f}'  # noqa: UP031
                   % (t, aid, px[aid][k], py[aid][k]))


def emit_run(outdir, run_id, layout, scenario, events, px, py, actor_ids, steps,
             dt, duration_s, seed, expected_extra=None):
    d = os.path.join(outdir, run_id)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "layout.geojson"), "w", encoding="utf-8") as fh:
        json.dump(layout, fh, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(d, "scenario.json"), "w", encoding="utf-8") as fh:
        json.dump(scenario, fh, ensure_ascii=False, indent=2)
    n_ev = write_jsonl(os.path.join(d, "events.jsonl"),
                       (json.dumps(e, ensure_ascii=False, separators=(",", ":"))
                        for e in events))
    n_pos = write_jsonl(os.path.join(d, "positions.jsonl"),
                        positions_lines(px, py, actor_ids, steps, dt))
    summary = summarize(events, px, py, dt, duration_s, actor_ids)
    with open(os.path.join(d, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    scen_hash = hashlib.sha256(
        json.dumps(scenario, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    meta = {
        "run_id": run_id,
        "schema_version": SCHEMA_VERSION,
        "seed": seed,
        "scenario_hash": scen_hash,
        "t0": None,
        "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "generator": GENERATOR,
    }
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    n_wait = sum(1 for e in events if e["type"] == "wait_start")
    expected = {
        "run_id": run_id,
        "note": "chrono-lens 自己検証用。契約外のテスト補助ファイル。",
        "counts": {"events": n_ev, "positions": n_pos, "actors": len(actor_ids),
                   "wait_pairs": n_wait},
        "duration_s": duration_s,
        "sample_dt_s": dt,
        "summary": summary,
        "heatmap_dwell": heat_expectation(px, py, dt, actor_ids, layout, cell=1.0),
    }
    if expected_extra:
        expected.update(expected_extra)
    with open(os.path.join(d, "expected.json"), "w", encoding="utf-8") as fh:
        json.dump(expected, fh, ensure_ascii=False, indent=2)
    return d, expected


# --------------------------------------------------------------------------
# モード
# --------------------------------------------------------------------------


def gen_small(outdir, seed=42):
    layout, nodes, adj, loc_nodes, depot = build_layout(n_aisles=5)
    duration_s, dt, n_actors, speed = 600.0, 0.5, 3, 1.4
    # 待機ちょうど2件 — 同じノードに仕込むのでヒートマップ最大セルもそこになる
    hot = "n0203"
    scripted = [("P01", hot, 90.0, 120.0), ("P02", hot, 260.0, 150.0)]
    # 仕込みノードを必ず通るように、そのノードを目的地に含める確率を上げる:
    # 単純化のため P01/P02 の最初の目的地を hot に固定する仕掛けは使わず、
    # 「hot に到達したら待つ」= 到達するまで待機は発火しない。確実性のために
    # loc_nodes を hot に偏らせる。
    loc_biased = loc_nodes + [hot] * max(1, len(loc_nodes) // 2)
    events, px, py, steps = simulate(
        nodes, adj, loc_biased, depot, n_actors, duration_s, dt, speed, seed,
        scripted_waits=scripted, wait_prob=0.0)
    actor_ids = [f"P{i + 1:02d}" for i in range(n_actors)]
    scenario = {
        "schema_version": SCHEMA_VERSION,
        "layout": "layout.geojson",
        "actors": {"count": n_actors, "speed_mps": speed, "type": "picker"},
        "dispatch": "fifo",
        "orders": [{"order_id": e["meta"]["order_id"],
                    "loc_id": e.get("to"), "qty": 1, "ready_t": e["t"]}
                   for e in events if e["type"] == "task_assign"][:200],
        "duration_s": duration_s,
        "seed": seed,
    }
    d, exp = emit_run(outdir, "small_known", layout, scenario, events, px, py,
                      actor_ids, steps, dt, duration_s, seed,
                      expected_extra={"scripted_waits": [
                          {"actorId": a, "node": n, "start_t": s, "duration_s": u}
                          for (a, n, s, u) in scripted]})
    n_ws = sum(1 for e in events if e["type"] == "wait_start")
    n_we = sum(1 for e in events if e["type"] == "wait_end")
    assert n_ws == 2 and n_we == 2, f"待機件数が2件でない: start={n_ws} end={n_we}"
    return d, exp


def gen_large(outdir, seed=7, n_actors=50, duration_s=28800.0, dt=1.0):
    layout, nodes, adj, loc_nodes, depot = build_layout(n_aisles=9, n_rungs=8)
    speed = 1.4
    events, px, py, steps = simulate(
        nodes, adj, loc_nodes, depot, n_actors, duration_s, dt, speed, seed,
        scripted_waits=None, wait_prob=0.18)
    actor_ids = [f"P{i + 1:02d}" for i in range(n_actors)]
    scenario = {
        "schema_version": SCHEMA_VERSION,
        "layout": "layout.geojson",
        "actors": {"count": n_actors, "speed_mps": speed, "type": "picker"},
        "dispatch": "fifo",
        "orders": "orders.json",
        "duration_s": duration_s,
        "seed": seed,
    }
    return emit_run(outdir, "large_load", layout, scenario, events, px, py,
                    actor_ids, steps, dt, duration_s, seed)


def gen_invalid(outdir):
    """契約違反を意図的に仕込んだラン (DoD5 の拒否画面確認用)。"""
    d = os.path.join(outdir, "bad_contract")
    os.makedirs(d, exist_ok=True)
    layout, _nodes, _adj, _locs, _depot = build_layout(n_aisles=3, n_rungs=3)
    # 違反1: 座標系が地理座標を名乗る
    layout["meta"]["crs"] = "EPSG:4326"
    feats = layout["features"]
    # 違反2: node の id 欠落
    for f in feats:
        if f["properties"]["kind"] == "node":
            f["properties"].pop("id")
            break
    # 違反3: rack を貫通する edge
    rack = next(f for f in feats if f["properties"]["kind"] == "rack")
    ring = rack["geometry"]["coordinates"][0]
    x0, y0 = ring[0]
    x1, y1 = ring[2]
    feats.append({
        "type": "Feature",
        "properties": {"kind": "edge", "id": "e_bad", "from": "nDEP", "to": "nDEP"},
        "geometry": {"type": "LineString",
                     "coordinates": [[x0 - 2.0, (y0 + y1) / 2],
                                     [x1 + 2.0, (y0 + y1) / 2]]},
    })
    # 違反4: zone の label 欠落
    feats.append({
        "type": "Feature",
        "properties": {"kind": "zone", "id": "z_bad"},
        "geometry": {"type": "Polygon", "coordinates": [[
            [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]},
    })
    with open(os.path.join(d, "layout.geojson"), "w", encoding="utf-8") as fh:
        json.dump(layout, fh, ensure_ascii=False)

    # events: actorId 欠落 / t 非単調 / t が文字列 / from が数値 / JSON でない
    ev_lines = [
        '{"t": 0.0, "type": "task_assign", "actorId": "P01", "to": "n0001", "meta": {}}',
        '{"t": 1.0, "type": "move_start", "actorId": "P01", "from": "n0000", "to": "n0001"}',
        '{"t": 5.0, "type": "move_end", "actorId": "P01", "to": "n0001"}',
        '{"t": 2.0, "type": "pick_start", "actorId": "P01", "from": "n0001"}',  # t 逆行
        '{"t": 6.0, "type": "wait_start", "from": "n0001"}',            # actorId 欠落
        '{"t": "7.0", "type": "wait_end", "actorId": "P01"}',           # t が文字列
        '{"t": 8.0, "type": "pick_end", "actorId": "P01", "from": 12}',  # from が数値
        '{"t": 9.0, "type": "wait_start", "actorId": "P02"}',           # wait_end なし
        'not json at all',                                              # JSON でない
    ]
    with open(os.path.join(d, "events.jsonl"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(ev_lines) + "\n")

    # positions: y 欠落 / x が文字列 / t 逆行 / rack 内部の座標
    rx = (x0 + x1) / 2
    ry = (y0 + y1) / 2
    pos_lines = [
        '{"t": 0.0, "actorId": "P01", "x": 3.0, "y": 2.0}',
        '{"t": 5.0, "actorId": "P01", "x": 3.2, "y": 2.0}',
        '{"t": 3.0, "actorId": "P01", "x": 3.4, "y": 2.0}',             # t 逆行
        '{"t": 6.0, "actorId": "P01", "x": 3.0}',                       # y 欠落
        '{"t": 7.0, "actorId": "P01", "x": "3.5", "y": 2.0}',           # x が文字列
        '{"t": 8.0, "actorId": "P01", "x": %.2f, "y": %.2f}' % (rx, ry),  # noqa: UP031
    ]
    with open(os.path.join(d, "positions.jsonl"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(pos_lines) + "\n")

    # summary: 型違反 + 必須キー欠落
    with open(os.path.join(d, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump({"schema_version": "0.9", "rows_per_hour": "たくさん",
                   "wait_time_s": {"mean": 1.0}, "utilization": {"P01": "high"}},
                  fh, ensure_ascii=False, indent=2)
    return d, {"note": "意図的に契約違反を仕込んだラン"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["small", "large", "invalid", "all"])
    ap.add_argument("-o", "--out", default="runs", help="出力先ディレクトリ")
    ap.add_argument("--actors", type=int, default=50, help="large: アクタ数")
    ap.add_argument("--duration", type=float, default=28800.0, help="large: 秒")
    ap.add_argument("--dt", type=float, default=1.0, help="large: サンプリング間隔[s]")
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    made = []
    if a.mode in ("small", "all"):
        d, exp = gen_small(a.out, seed=a.seed if a.seed is not None else 42)
        made.append(d)
        print(f"[small ] {d}")
        print(f"         events={exp['counts']['events']} "
              f"positions={exp['counts']['positions']} "
              f"waits={exp['counts']['wait_pairs']}")
        print(f"         heatmap max cell={exp['heatmap_dwell']['max_cell_index']} "
              f"center={exp['heatmap_dwell']['max_cell_center_m']}m "
              f"dwell={exp['heatmap_dwell']['max_cell_dwell_s']}s")
    if a.mode in ("large", "all"):
        d, exp = gen_large(a.out, seed=a.seed if a.seed is not None else 7,
                           n_actors=a.actors, duration_s=a.duration, dt=a.dt)
        made.append(d)
        print(f"[large ] {d}")
        print(f"         events={exp['counts']['events']} "
              f"positions={exp['counts']['positions']}")
    if a.mode in ("invalid", "all"):
        d, _ = gen_invalid(a.out)
        made.append(d)
        print(f"[invalid] {d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
