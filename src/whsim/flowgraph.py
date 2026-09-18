"""The ONE flow graph: work processes as nodes, 物の流れ as edges.

Before this module whsim described the same warehouse three times, with no
shared identity between the descriptions:

  ① ``WorkProcess.depends``  — 入荷検品→格納→ピッキング→検品→梱包→出荷 (②マテリアルフロー)
  ② ``Process.stages``       — receive→putaway→pick→pack→ship          (③フロー)
  ③ ``Resources``            — conveyor ``takeaway`` / forklifts / stations (③配置)

Not one id was shared between ① and ②, and NEITHER could name a physical
object in ③. So "packing is fed by that belt" had nowhere to live, and the
engine had to guess geometrically: it used whatever conveyor was nearest,
which is why switching a stage to 人手 did not stop the belt being used.

This module is the resolver, not a fourth model. It reads what is already
there and answers the questions the rest of the codebase needs:

  * :func:`resolve`        — nodes + edges, whatever the project has authored
  * :func:`transport_into` — how (and on WHICH machine) goods reach a process
  * :func:`conveyor_ids_in_use` — which belts the design actually commits to
  * :func:`diagnose`       — what is inconsistent, as warnings (never blocks)

**Compatibility is the load-bearing property.** A project that has never
touched ``flow_edges`` resolves to exactly the graph its ``depends`` already
implied, with transport read from the stage it maps to — so behaviour is
unchanged. Authoring an edge is what makes the binding explicit.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

# Business-process id → the engine role it drives. Only used to bridge the two
# vocabularies that grew apart (① uses Japanese business names, ② uses engine
# stage ids); an explicit ``WorkProcess.role`` always wins over this guess.
_ROLE_BY_NAME: dict[str, str] = {
    "入荷検品": "receive", "入荷": "receive", "検収": "receive",
    "格納": "putaway", "棚入れ": "putaway", "入庫": "putaway",
    "ピッキング": "pick", "ピック": "pick", "出庫": "pick",
    "検品": "inspect", "出荷検品": "inspect",
    "梱包": "pack", "包装": "pack", "流通加工": "pack",
    "出荷": "ship", "積込": "ship",
}

#: Engine roles that a stage can actually drive. Anything else is staffing-only.
ENGINE_ROLES = frozenset({"receive", "putaway", "pick", "pack", "ship"})


@dataclass(frozen=True)
class Node:
    """One work process in the graph."""

    id: str
    role: str                 # engine role ("" / "none" = staffing-only)
    zone: str
    section: str

    @property
    def simulated(self) -> bool:
        return self.role in ENGINE_ROLES


@dataclass(frozen=True)
class Edge:
    """One leg of 物の流れ. ``src``/``dst`` are node ids ("" = outside world)."""

    src: str
    dst: str
    transport: str
    equipment_ref: str
    share: float
    container_ref: str = ""    # LoadUnit.id goods are IN over this leg
    carrier_ref: str = ""      # LoadUnit.id goods ride ON (人手区間で効く)
    #: True when this edge was inferred (from ``depends``) rather than authored.
    derived: bool = False


@dataclass
class FlowGraph:
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)

    def node(self, nid: str) -> Node | None:
        return next((n for n in self.nodes if n.id == nid), None)

    def into(self, nid: str) -> list[Edge]:
        """Edges feeding ``nid`` (how work arrives at this process)."""
        return [e for e in self.edges if e.dst == nid]

    def out_of(self, nid: str) -> list[Edge]:
        return [e for e in self.edges if e.src == nid]


def _role_for(proc: dict) -> str:
    explicit = str(proc.get("role") or "").strip()
    if explicit:
        return explicit
    return _ROLE_BY_NAME.get(str(proc.get("id") or "").strip(), "")


def _stage_by_role(model) -> dict[str, object]:
    """Engine role → the Stage carrying its transport method."""
    stages = getattr(getattr(model, "process", None), "stages", None) or []
    return {str(getattr(s, "id", "")): s for s in stages}


def resolve(model) -> FlowGraph:
    """The project's flow graph. Never raises; a bare model yields an empty one."""
    from whsim.analysis.staffing.profile import process_master

    try:
        master = process_master(model)
    except Exception:      # noqa: BLE001 — a broken master must not break callers
        master = []

    stage_by_id = _stage_by_role(model)
    nodes: list[Node] = []
    for p in master:
        role = _role_for(p)
        zone = str(p.get("zone") or "")
        if not zone and role in stage_by_id:
            zone = str(getattr(stage_by_id[role], "zone", "") or "")
        nodes.append(Node(id=str(p.get("id") or ""), role=role, zone=zone,
                          section=str(p.get("section") or "")))
    known = {n.id for n in nodes}

    authored_raw = list(getattr(getattr(model, "process", None), "flow_edges", None) or [])
    edges: list[Edge] = []
    wired: set[str] = set()          # destinations the user has spoken for
    for e in authored_raw:
        d = e.model_dump() if hasattr(e, "model_dump") else dict(e)
        src, dst = str(d.get("src") or ""), str(d.get("dst") or "")
        # An edge naming a process that no longer exists is dropped here and
        # reported by diagnose() — the graph must stay traversable.
        if (src and src not in known) or (dst and dst not in known):
            continue
        try:
            share = float(d.get("share", 1.0))
        except (TypeError, ValueError):
            share = 1.0
        edges.append(Edge(src=src, dst=dst,
                          transport=str(d.get("transport") or "manual"),
                          equipment_ref=str(d.get("equipment_ref") or ""),
                          share=share, derived=False,
                          container_ref=str(d.get("container_ref") or ""),
                          carrier_ref=str(d.get("carrier_ref") or "")))
        if dst:
            wired.add(dst)

    # PARTIAL authoring is the normal case: someone wires the one leg they care
    # about (「梱包はこのベルトで受ける」) and expects the rest of the chain to keep
    # following the process order. So every destination the user has NOT spoken
    # for still gets its derived edges — otherwise wiring one leg would make the
    # other five processes look disconnected. Transport comes from the stage the
    # destination maps to, which is what the engine used before edges existed, so
    # a project with no authored edges resolves exactly as it always did.
    for p in master:
        dst = str(p.get("id") or "")
        if dst in wired:
            continue
        node = next((n for n in nodes if n.id == dst), None)
        stage = stage_by_id.get(node.role) if node else None
        transport = str(getattr(stage, "method", "manual") or "manual") if stage else "manual"
        ups = [u for u in (p.get("depends") or []) if u in known]
        if not ups:
            edges.append(Edge("", dst, transport, "", 1.0, derived=True))
        for u in ups:
            edges.append(Edge(u, dst, transport, "", 1.0, derived=True))
    return FlowGraph(nodes=nodes, edges=edges)


def transport_into(model, role: str) -> tuple[str, str]:
    """``(transport, equipment_ref)`` for goods arriving at an engine ``role``.

    This is the question the engine asks: "does work reach packing on a belt,
    and if so which one?". Falls back to the stage's own method so a project
    with no authored edges answers exactly as it did before.
    """
    g = resolve(model)
    for n in g.nodes:
        if n.role != role:
            continue
        into = g.into(n.id)
        for e in into:
            if e.transport and e.transport != "manual":
                return e.transport, e.equipment_ref
        # An AUTHORED leg that says 人手 is a decision, not an absence — it must
        # not be overridden by a stale stage method (that is the very bug this
        # layer exists to fix). Only fall through when nothing was authored.
        if into and any(not e.derived for e in into):
            return "manual", ""
    stage = _stage_by_role(model).get(role)
    return (str(getattr(stage, "method", "manual") or "manual") if stage else "manual"), ""


def conveyor_ids_in_use(model) -> set[str] | None:
    """Which conveyors the DESIGN commits to.

    ``None`` means "no conveyor leg is designed" — the engine then runs no belt
    at all, which is what makes 「人手に戻したのにベルトが使われ続ける」 impossible.
    A returned EMPTY-ref set means "conveyor, but no specific machine named", so
    every drawn belt stays available (the historical behaviour).
    """
    g = resolve(model)
    refs: set[str] = set()
    any_conveyor = False
    for e in g.edges:
        if e.transport != "conveyor":
            continue
        any_conveyor = True
        if e.equipment_ref:
            refs.add(e.equipment_ref)
    if not any_conveyor:
        return None
    return refs


def _conveyor_refs(model, *, src_role: str = "", dst_role: str = "") -> set[str] | None:
    """Belts named by the conveyor legs LEAVING ``src_role`` / ENTERING ``dst_role``.

    Same three-valued answer as :func:`conveyor_ids_in_use`, applied to one end of
    the leg: ``None`` = "no such conveyor leg is designed", an EMPTY set =
    「コンベアだが機番の指定なし」, a non-empty set = exactly those belts. Callers
    treat both falsy answers as "no gate" so a half-authored flow never removes
    behaviour (never-blocks).
    """
    g = resolve(model)
    role_of = {n.id: n.role for n in g.nodes}
    refs: set[str] = set()
    found = False
    for e in g.edges:
        if e.transport != "conveyor":
            continue
        if src_role and role_of.get(e.src) != src_role:
            continue
        if dst_role and role_of.get(e.dst) != dst_role:
            continue
        found = True
        if e.equipment_ref:
            refs.add(e.equipment_ref)
    return refs if found else None


def entry_conveyor_ids(model) -> set[str] | None:
    """Belts a PICKER may hand a tote to (conveyor legs out of a ``pick`` process).

    A chained line has an entrance: 検品ラインに載せるのであって、引き込みや本線に
    直接載せるのではない. Without this the engine let a picker board whatever belt
    ran nearest — on a line whose 本線 and 引き込み pass right through the pick
    area, that is halfway down the chain, and the jam upstream of it can never
    reach the picker. ``None`` (no such leg authored) keeps the historical
    "every belt is boardable" behaviour.
    """
    return _conveyor_refs(model, src_role="pick")


def pack_conveyor_ids(model) -> set[str] | None:
    """Belts that DELIVER to packing (conveyor legs into a ``pack`` process).

    These are the 引き込み(spur) belts: the leg that ends at a work bench rather
    than handing on to another belt. ``None`` = packing is not fed by a belt, so
    the engine keeps the pooled pack stations.
    """
    return _conveyor_refs(model, dst_role="pack")


def _drawn_belts(model) -> list[tuple[str, list[tuple[float, float]], object]]:
    """Belts with usable geometry, as ``(id, points, conveyor)`` in ID order.

    Degenerate entries (fewer than 2 points, or every point coincident) are not
    physical transport: ``engine.build`` skips them, so every check reading this
    skips them too (never blocks). Sorted by id and never by drawing order — a
    re-saved file with its belts in another order must produce the same warnings
    in the same sequence.
    """
    out: list[tuple[str, list[tuple[float, float]], object]] = []
    for cv in (getattr(getattr(model, "resources", None), "conveyors", None) or []):
        raw = getattr(cv, "points", None) or []
        pts = [(float(p[0]), float(p[1])) for p in raw if len(p) >= 2]
        if len(pts) < 2:
            continue
        if sum(math.dist(pts[i - 1], pts[i]) for i in range(1, len(pts))) <= 1e-9:
            continue
        out.append((str(getattr(cv, "id", "")), pts, cv))
    out.sort(key=lambda r: r[0])
    return out


def _closer_by(gap: float, limit: float) -> float:
    """How much closer the drawing has to come, rounded UP to 10 cm.

    Rounded up, because advice that lands exactly ON the threshold is advice that
    might not connect, and two decimal places of a drawn corner ("0.24 m 伸ばして
    ください") reads as precision the drawing does not have. 1.044 m against a
    0.80 m threshold comes out 「0.3 m 伸ばせば繋がります」, which is what the
    person with the drawing can actually do.

    The epsilon is float noise, not slack: ``3.3 - 3.0`` is 0.30000000000000027
    in binary, and without it a bench 30 cm out would be told to move 40.
    """
    return max(0.1, math.ceil((gap - limit) * 10.0 - 1e-9) / 10.0)


def _near_miss_warnings(model, warn) -> None:
    """Geometry that ALMOST connects — reported, never acted on.

    Every rule in :mod:`whsim.beltgeom` answers "are these two joined?" with yes
    or no, and a drawing that misses by centimetres gets the same silent "no" as
    one that misses by the width of the building. Over one engagement that
    silence cost four separate mechanisms, and **the model ran and completed its
    orders every time**: a 引き込み 1.04 m off the 本線 got no junction and never
    received a load (every tote rode to the end and packed out of the shared
    pool, which reads as a healthy line with dead belts); two 検品 belts resolved
    serial instead of parallel because one discharge end was 1.044 m from the
    trunk; a bench 2.6 m from one spur and 1.6 m from another silently belonged
    to the nearer one; a bench drawn with ``count: 0`` and a bench a neighbour had
    already claimed looked identical from outside.

    So: measure the gap, name the two objects, and say what to do about it. These
    do NOT change a single wiring decision — the thresholds above stay exactly
    where they are, and every one of these is a warning (invariant 13).

    Closed-form throughout (``beltgeom`` is pure geometry: no DES, no graph
    search), so it is cheap enough to run on every keystroke of the フロー tab.
    """
    from whsim import beltgeom

    belts = _drawn_belts(model)
    if not belts:
        return
    geom = [(bid, pts) for bid, pts, _cv in belts]
    pts_by_id = {bid: pts for bid, pts, _cv in belts}

    def refs(fn) -> set[str]:
        try:
            return fn(model) or set()
        except Exception:      # noqa: BLE001 — a broken flow must not break diagnose
            return set()

    spur_ids = sorted({r for r in refs(pack_conveyor_ids) if r in pts_by_id})
    spur_set = set(spur_ids)
    spurs = [(sid, pts_by_id[sid]) for sid in spur_ids]
    both = {bid for bid, _pts, cv in belts
            if bid in spur_set and getattr(cv, "discharge_both", False)}
    tol = beltgeom.JOIN_TOL_M
    reach = beltgeom.BENCH_REACH_M

    # 7. a belt drawn but wired into no leg of the flow at all. The engine gates
    # on ``conveyor_ids_in_use`` while ``analytic._belt_access`` reads every drawn
    # belt, so a belt only one of them can see means the two are pricing different
    # warehouses (invariant 5's "解析とDESが構造的に食い違ってはいけない").
    # ``None``/empty is not this case: no conveyor leg at all is already reported
    # as ``conveyor_unused``, and a leg naming no machine deliberately leaves every
    # belt available.
    try:
        used = conveyor_ids_in_use(model)
    except Exception:          # noqa: BLE001
        used = None
    if used:
        wired = [(bid, pts) for bid, pts, _cv in belts if bid in used]
        for bid, pts, _cv in belts:
            # 2段駆動コンベア: an upper deck (空容器の還流) drawn over the SAME XY as
            # a wired belt leaves both readers looking at the same floor, so it is
            # not the asymmetry this check is about.
            if bid in used or beltgeom.path_covered_by(pts, wired):
                continue
            warn("belt_not_wired",
                 f"コンベア「{bid}」は引かれていますが、フローのどの搬送にも使われていません"
                 "（搬送設備に指定されていません）。エンジンはこのベルトを動かさない一方、"
                 "能力試算は図面のベルトを全部読むので、両者が別々の倉庫を計算します。"
                 f"フローの該当区間の搬送設備に「{bid}」を指定してください。",
                 conveyor=bid)

    # 8. a belt end that ALMOST hands over. A 引き込み is excluded on both sides:
    # it ends at its 梱包台 on purpose (so its own discharge end is not a near
    # miss), and it is never a hand-over TARGET (``build._attach_to`` excludes it),
    # so moving a belt to touch one would not connect anything.
    for bid, pts, _cv in belts:
        if bid in spur_set:
            continue
        if beltgeom.attach(pts[-1], geom, exclude={bid}) is not None:
            continue                       # already handing over to something
        hit = beltgeom.nearest_path(pts[-1], geom, exclude=spur_set | {bid})
        if hit is None or not (tol < hit[1] <= beltgeom.NEAR_JOIN_M):
            continue
        other, gap, _arc = hit
        warn("near_join",
             f"「{bid}」の払い出し端は「{other}」まで {gap:.2f} m、接続は {tol:.2f} m 以内です。"
             f"{_closer_by(gap, tol):.1f} m 伸ばせば繋がります"
             "（今は繋がっておらず、別々のラインとして計算されます）。",
             belt=bid, other=other, gap=round(gap, 3), tolerance=tol)

    # 9. THE DEAD BELT. A 引き込み the flow names as feeding 梱包 that ends up with
    # no junction receives not one load, keeps its 梱包台, and the orders still
    # complete out of the shared pool — nothing in the numbers says the line's
    # whole mechanism is missing. Said loudly, because it is.
    for sid in spur_ids:
        if beltgeom.feed_point(pts_by_id[sid], geom, exclude=spur_set) is not None:
            continue
        best = None
        for bid, pts in geom:
            if bid in spur_set:
                continue
            near = beltgeom.path_nearest(pts_by_id[sid], pts)
            if near is not None and (best is None or (near[0], bid) < (best[0], best[1])):
                best = (near[0], bid)
        head = (f"引き込み「{sid}」は梱包への搬送として配線されていますが、"
                "どの本線にも接続していません")
        tail = ("。このままでは荷が1つも流れ込まず、梱包台は空のまま — "
                "荷は全部ラインの終端まで行って共用の梱包プールで捌かれます"
                "（オーダーは完了するので、数字だけでは気づけません）。")
        if best is None:
            warn("spur_no_junction", head + "（接続先になる本線が1本も引かれていません）" + tail
                 + "本線を引くか、この配線を外してください。",
                 belt=sid, severity="critical")
        else:
            gap, other = best
            warn("spur_no_junction",
                 head + f"（最寄りの「{other}」まで {gap:.2f} m、接続は {tol:.2f} m 以内）" + tail
                 + f"「{other}」に {_closer_by(gap, tol):.1f} m 近づければ繋がります。",
                 belt=sid, other=other, gap=round(gap, 3), tolerance=tol,
                 severity="critical")

    if not spurs:
        return
    stations = list(getattr(getattr(model, "resources", None), "stations", None) or [])
    if not stations:
        return
    pts_st = [(float(s.x), float(s.y), int(getattr(s, "count", 0) or 0)) for s in stations]
    pools, _claimed = beltgeom.bench_pools(spurs, geom, pts_st, both=both)
    ranks = beltgeom.bench_distances(spurs, geom, pts_st, both=both)
    # Stations are addressed by id and position, never by their index in the file:
    # the same drawing saved in another order must warn identically.
    order = sorted(range(len(stations)),
                   key=lambda i: (str(stations[i].id), pts_st[i][0], pts_st[i][1], i))

    # 10. a 引き込み with no hands. "Drawn but deliberately unmanned" and "a
    # neighbour took my bench" both mean the pull-in takes nothing at all
    # (``beltgeom.NO_HANDS``) and look identical from outside — but one is fixed
    # by entering a bench count and the other by moving a bench, so say WHICH.
    for sid in spur_ids:
        n = pools.get(sid)
        if n == beltgeom.CLOSED:
            warn("spur_closed",
                 f"引き込み「{sid}」の担当範囲にある梱包台は、台数が全て 0 台です（無人）。"
                 "この引き込みには荷を流しません（意図どおりなら、そのままで構いません）。"
                 "稼働させるなら梱包台の台数を入れてください。",
                 belt=sid)
        elif n == beltgeom.LOST:
            taken = None
            for i in order:
                ranked = ranks.get(i) or []
                mine = next((d for d, s in ranked if s == sid), None)
                if mine is None or mine > reach or ranked[0][1] == sid:
                    continue               # out of reach, or this spur won it
                if taken is None or mine < taken[0]:
                    taken = (mine, ranked[0][0], ranked[0][1], str(stations[i].id))
            if taken is None:
                continue
            mine, won, winner, label = taken
            warn("spur_bench_lost",
                 f"引き込み「{sid}」の担当範囲にある梱包台「{label}」は、より近い"
                 f"「{winner}」の持ち台です（「{winner}」まで {won:.2f} m 対 "
                 f"「{sid}」まで {mine:.2f} m）。「{sid}」には人が残らないので荷を流しません。"
                 f"専用の梱包台を置くか、この台を「{sid}」側に寄せてください。",
                 belt=sid, other=winner, station=label,
                 gap=round(mine, 3), rival_gap=round(won, 3))

    # 停止線の作業者 are NOT orphans: a 梱包台 standing at a stop gate belongs to
    # that gate (``build._wire_conveyor_chain`` hands it over once every 引き込み
    # has taken its own), so the check below must not call it ownerless. The gate
    # rule lives in ``linemech``, which is imported only when a belt actually
    # carries one — a model with the mechanism off never touches it (invariant 17:
    # 既定オフ＝import すらされない).
    gated: set[int] = set()
    if any(getattr(cv, "stop_gate", None) for _bid, _pts, cv in belts):
        try:
            from whsim import linemech
            for _bid, pts, cv in belts:
                g = linemech.resolve_gate(cv)
                if g is None:
                    continue
                at = beltgeom.point_at(pts, g[0])
                gated.update(i for i, st in enumerate(pts_st)
                             if math.dist((st[0], st[1]), at) <= reach)
        except Exception:      # noqa: BLE001 — a gate we cannot read is not a gate
            gated = set()

    # 11. 梱包台 nobody owns, and 梱包台 two pull-ins both reach. The first quietly
    # falls back to the shared pack pool (the bench is drawn, staffed, and serving
    # a different queue than the drawing shows); the second is resolved correctly
    # and invisibly, so state who won and by how much.
    for i in order:
        if pts_st[i][2] <= 0:
            continue                       # unmanned by choice — reported above
        ranked = ranks.get(i) or []
        if not ranked:
            continue
        label = str(stations[i].id)
        within = [r for r in ranked if r[0] <= reach]
        if i in gated and not within:
            continue                       # it belongs to a 停止線, not to nobody
        if not within:
            gap, sid = ranked[0]
            if gap > beltgeom.NEAR_REACH_M:
                continue                   # a bench elsewhere in the building
            warn("bench_out_of_reach",
                 f"梱包台「{label}」（{pts_st[i][0]:.1f}, {pts_st[i][1]:.1f}）は最寄りの"
                 f"引き込み「{sid}」の払い出し端まで {gap:.2f} m あり、担当範囲 {reach:.1f} m の"
                 "外です。どの引き込みの持ち台にもならず、共用の梱包プールに回ります。"
                 f"{_closer_by(gap, reach):.1f} m 近づければ「{sid}」の持ち台になります。",
                 station=label, belt=sid, gap=round(gap, 3), reach=reach)
        elif len(within) >= 2:
            (won, winner), (lost, runner) = within[0], within[1]
            warn("bench_contested",
                 f"梱包台「{label}」は「{winner}」まで {won:.2f} m、「{runner}」まで "
                 f"{lost:.2f} m で、どちらの担当範囲（{reach:.1f} m）にも入っています。"
                 f"近い「{winner}」の持ち台として計算します（差 {lost - won:.2f} m）。"
                 f"「{runner}」に付けたい場合は、台か引き込みを動かしてください。",
                 station=label, belt=winner, other=runner,
                 gap=round(won, 3), rival_gap=round(lost, 3), severity="info")


def diagnose(model) -> list[dict]:
    """Inconsistencies in the design, as warnings. Never blocks, never raises.

    Surfaced in the フロー tab and folded into the 採点表's 連鎖 row: the point is
    to make a half-wired design VISIBLE, not to refuse to run it.
    """
    out: list[dict] = []
    try:
        g = resolve(model)
    except Exception:      # noqa: BLE001
        return out

    conveyor_ids = {str(c.id) for c in (getattr(model.resources, "conveyors", None) or [])}
    equip_ids = {str(e.id) for e in (getattr(model.resources, "equipment", None) or [])}

    def warn(kind: str, msg: str, **extra):
        out.append({"kind": kind, "message": msg, **extra})

    # 1. an authored edge naming a process that no longer exists
    known = {n.id for n in g.nodes}
    for e in (getattr(model.process, "flow_edges", None) or []):
        d = e.model_dump() if hasattr(e, "model_dump") else dict(e)
        for side in ("src", "dst"):
            v = str(d.get(side) or "")
            if v and v not in known:
                warn("dangling_process", f"工程「{v}」が見つかりません（フローの接続が切れています）",
                     edge=str(d.get("id") or ""), missing=v)

    # 2. a conveyor/agv leg pointing at a machine that is not placed
    for e in g.edges:
        if not e.equipment_ref:
            continue
        pool = conveyor_ids if e.transport == "conveyor" else equip_ids
        if e.equipment_ref not in pool:
            warn("missing_equipment",
                 f"「{e.dst or '出荷'}」への搬送が設備「{e.equipment_ref}」を指していますが、"
                 "その設備は配置されていません",
                 edge=f"{e.src}→{e.dst}", equipment=e.equipment_ref)

    # 3. a conveyor leg with no belt drawn at all
    if any(e.transport == "conveyor" for e in g.edges) and not conveyor_ids:
        warn("no_conveyor_drawn",
             "搬送手段が「コンベア」の工程がありますが、コンベアが1本も引かれていません")

    # 4. a belt drawn but no leg uses it (the inverse — it will not run)
    used = conveyor_ids_in_use(model)
    if conveyor_ids and used is None:
        warn("conveyor_unused",
             "コンベアが引かれていますが、どの工程も「コンベア」で受け取る設定になっていません"
             "（このままでは搬送に使われません）",
             conveyors=sorted(conveyor_ids))

    # 4b. 荷姿 that does not exist, or a carrier that cannot hold what is on it
    from whsim import loadunit
    units = loadunit.by_id(model)
    for e in g.edges:
        for ref, what in ((e.container_ref, "容器"), (e.carrier_ref, "台車")):
            if ref and ref not in units:
                warn("missing_loadunit",
                     f"「{e.dst or '出荷'}」への搬送が{what}「{ref}」を指していますが、"
                     "荷姿カタログにありません",
                     edge=f"{e.src}→{e.dst}", unit=ref)
        if e.container_ref and e.carrier_ref:
            carrier = units.get(e.carrier_ref)
            if carrier and loadunit.capacity_for(carrier, e.container_ref) <= 0:
                warn("incompatible_loadunit",
                     f"「{loadunit.label(e.carrier_ref, units)}」に"
                     f"「{loadunit.label(e.container_ref, units)}」の積載数が"
                     "設定されていません（積めない組み合わせです）",
                     edge=f"{e.src}→{e.dst}",
                     carrier=e.carrier_ref, container=e.container_ref)

    # 5. split ratios that do not add up
    by_src: dict[str, float] = {}
    for e in g.edges:
        if e.src and not e.derived:
            by_src[e.src] = by_src.get(e.src, 0.0) + e.share
    for src, total in by_src.items():
        if abs(total - 1.0) > 0.01:
            warn("share_sum", f"「{src}」からの分岐率の合計が {total * 100:.0f}% です（100%になっていません）",
                 process=src, total=total)

    # 6. a process nothing feeds (other than the entry point)
    fed = {e.dst for e in g.edges if e.dst}
    for i, n in enumerate(g.nodes):
        if i and n.id not in fed:
            warn("unconnected", f"工程「{n.id}」に前工程からの流れがありません", process=n.id)

    # 7-11. 近接ミス — the drawing that almost connects (see _near_miss_warnings).
    # Appended last and guarded on its own: a drawing whose geometry cannot be
    # read must not cost the caller the six checks above (never blocks).
    try:
        _near_miss_warnings(model, warn)
    except Exception:          # noqa: BLE001
        pass
    return out


def loadunits_in_use(model) -> set[str]:
    """Every 荷姿 the design actually references (for "unused" reporting)."""
    refs: set[str] = set()
    for e in resolve(model).edges:
        if e.container_ref:
            refs.add(e.container_ref)
        if e.carrier_ref:
            refs.add(e.carrier_ref)
    return refs


def edge_loadunits(model, src: str, dst: str) -> tuple[str, str]:
    """``(container_ref, carrier_ref)`` for one leg ("" when unspecified)."""
    for e in resolve(model).edges:
        if e.src == src and e.dst == dst:
            return e.container_ref, e.carrier_ref
    return "", ""
