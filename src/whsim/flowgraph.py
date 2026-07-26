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
                          share=share, derived=False))
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
    return out
