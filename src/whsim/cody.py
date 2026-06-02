"""Cody — the "Codyに聞く" mascot dialogue brain.

Cody is a warm, dependable mascot ("直せるよ" energy) who lets a non-technical
salesperson DRIVE whsim by chatting in Japanese: create a project, run a
simulation, open the analysis view, compare scenarios, get a quick estimate.

LLM SEAM
========
This module is the ONE seam between the chat UI and whsim's actions. Today
``respond()`` is a pure, rule-based intent router; LATER it will be swapped for
an LLM (tool / function-calling) call that emits the **same dict** — and nothing
downstream changes. To swap:

    def respond(message, context=None) -> dict:
        # call the LLM with `message` + `context` + a tool schema, then map its
        # structured output onto the exact dict contract documented below.
        ...

Keep ``respond()`` free of FastAPI / IO so it stays trivially unit-testable: it
only DECIDES an intent + params + reply. The frontend (or the API caller) is
responsible for actually executing the intent against the existing REST
endpoints (POST /api/projects, .../run, GET .../analysis, .../run-scenarios).

The returned dict is EXACTLY shaped:

    {
      "reply": str,             # Cody's message, Japanese, warm tone
      "mood": str,              # idle thinking typing success error
                                #   curious excited sleeping
      "intent": str,            # create_project | run | open_view | compare
                                #   | estimate | help | smalltalk | unknown
      "params": dict,           # intent-specific (see each handler)
      "suggestions": list[str], # 2-4 follow-up chips (Japanese)
      "needs": list[str] | None # missing slots, e.g. ["name"]
    }

``context`` (all optional) may contain:
    project    : str | None                       — current project name
    templates  : list[{template_id, name}]        — available templates
    has_run    : bool                             — project has a finished run
    kpis       : dict | None                      — latest KPIs (for summaries)
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Intent -> mood mapping. ``unknown`` and the "can't help" path use ``curious``
# / ``idle`` respectively (see _need_project / respond).
# ---------------------------------------------------------------------------
MOOD_FOR_INTENT = {
    "create_project": "excited",
    "run": "thinking",
    "compare": "thinking",
    "open_view": "curious",
    "estimate": "thinking",
    "help": "curious",
    "smalltalk": "excited",
    "unknown": "curious",
}

# Default template id used when none can be resolved from context.
_FALLBACK_TEMPLATE = "ecommerce_small"

# ---------------------------------------------------------------------------
# Keyword tables (generous synonyms). Order matters: more specific intents
# (create / compare) are tested before broad ones (open_view / run).
# ---------------------------------------------------------------------------
_KW_SMALLTALK = (
    "こんにちは", "こんばんは", "おはよう", "やあ", "はじめまして", "よろしく",
    "ありがとう", "ありがと", "かわいい", "可愛い", "すごい", "助かる", "hello", "hi",
)
_KW_HELP = ("ヘルプ", "使い方", "何ができる", "なにができる", "できること", "help", "つかいかた")
_KW_CREATE = ("作", "つく", "新規", "はじめ", "始め", "立ち上げ", "立上げ", "新し")
_KW_COMPARE = ("比較", "繁忙期", "ピーク", "agv導入", "agv入れ", "入れたら", "導入したら",
               "導入したい", "くらべ", "比べ", "what-if", "シナリオ")
_KW_RUN = ("実行", "回し", "回す", "シミュ", "動かし", "動かす", "シミュレーション", "走らせ")
_KW_ESTIMATE = ("概算", "ざっくり", "すぐ", "見積", "速報", "とりあえず数字", "ざっと")
_KW_OPENVIEW = ("結果", "分析", "kpi", "どうなった", "レポート", "見せて", "みせて",
                "ダッシュボード", "成績", "数字を見")

# Template hint keywords -> a matcher run over the available template list.
_KW_ECOMMERCE = ("ec", "通販", "ecommerce", "e-commerce", "ネット通販", "オンライン")


def _contains(message: str, keywords) -> bool:
    return any(k in message for k in keywords)


def _pick_template(context: dict) -> str:
    """Resolve a template id from context, honouring EC/通販 hints.

    Falls back to the first available template, else the canonical default.
    """
    templates = (context or {}).get("templates") or []
    ids = [t.get("template_id") for t in templates if t.get("template_id")]
    return ids[0] if ids else _FALLBACK_TEMPLATE


def _detect_template(message: str, context: dict) -> str:
    """Detect a template from the message; prefer an EC template on EC hints."""
    templates = (context or {}).get("templates") or []
    ids = [t.get("template_id") for t in templates if t.get("template_id")]
    low = message.lower()

    # Explicit: the message mentions a template id verbatim.
    for tid in ids:
        if tid and tid.lower() in low:
            return tid

    # EC / 通販 hint -> first template whose id/name looks like ecommerce.
    if _contains(low, _KW_ECOMMERCE):
        for t in templates:
            tid = (t.get("template_id") or "").lower()
            name = (t.get("name") or "").lower()
            if "ecommerce" in tid or "ec" in tid or "通販" in name or "ec" in name:
                return t["template_id"]
        if _FALLBACK_TEMPLATE in ids or not ids:
            return _FALLBACK_TEMPLATE

    return _pick_template(context)


def _extract_name(message: str) -> str | None:
    """Extract a project name from 「…」, "名前は…", or a trailing token."""
    # 1) Japanese quotation brackets 「…」 or 『…』.
    m = re.search(r"[「『]([^」』]+)[」』]", message)
    if m:
        return m.group(1).strip()

    # 2) "名前は X" / "名前を X" / "プロジェクト名は X".
    m = re.search(r"名前\s*[はを: ]\s*([^\s、。!！?？]+)", message)
    if m:
        return m.group(1).strip()

    # 3) "X という名前/プロジェクト" / "X で作って".
    m = re.search(r"([^\s、。「」]+?)\s*(?:という名前|というプロジェクト|で作|で新規)", message)
    if m:
        return m.group(1).strip()

    return None


# ---------------------------------------------------------------------------
# Per-intent handlers. Each returns the full contract dict.
# ---------------------------------------------------------------------------
def _reply_dict(reply, mood, intent, params, suggestions, needs=None) -> dict:
    return {
        "reply": reply,
        "mood": mood,
        "intent": intent,
        "params": params,
        "suggestions": suggestions,
        "needs": needs,
    }


def _handle_create(message: str, context: dict) -> dict:
    template = _detect_template(message, context)
    name = _extract_name(message)
    params = {"name": name, "template": template}
    if name:
        reply = (f"まかせて！「{name}」を {template} テンプレートで立ち上げるよ。"
                 f"作ったら、そのままシミュレーションも回せるよ。")
        return _reply_dict(reply, "excited", "create_project", params,
                           ["シミュレーションを実行", "結果を見せて", "概算で見たい"])
    # No name yet: ask for one, but keep the chosen template.
    reply = ("いいね、新しい倉庫プロジェクトを作ろう！"
             "名前は何にする？「〇〇」みたいに教えてくれたらすぐ作るよ。")
    return _reply_dict(reply, "excited", "create_project", params,
                       ["名前は「テスト倉庫」", "EC向けで作って", "おすすめテンプレートは？"],
                       needs=["name"])


def _handle_run(message: str, context: dict) -> dict:
    proj = (context or {}).get("project")
    if not proj:
        return _need_project("run")
    reply = (f"「{proj}」のシミュレーションを回すね。"
             "ちょっと待ってて、混雑の様子まで見られるよ。")
    return _reply_dict(reply, "thinking", "run", {},
                       ["結果を見せて", "シナリオを比較", "アニメで動きを見たい"])


def _handle_open_view(message: str, context: dict) -> dict:
    if _contains(message, ("比較",)):
        view = "compare"
    elif _contains(message, ("アニメ", "動き", "動く", "リプレイ")):
        view = "view2d"
    else:
        view = "analysis"
    params = {"view": view}
    proj = (context or {}).get("project")
    if not proj:
        d = _need_project("open_view")
        d["params"] = params
        return d
    summary = _kpi_summary((context or {}).get("kpis"))
    reply = f"「{proj}」の結果を開くね。"
    if summary:
        reply += summary
    return _reply_dict(reply, "curious", "open_view", params,
                       ["シナリオを比較", "もう一度実行", "提案書をつくりたい"])


def _handle_compare(message: str, context: dict) -> dict:
    proj = (context or {}).get("project")
    if not proj:
        return _need_project("compare")
    reply = ("いくつかのシナリオ（繁忙期・AGV導入など）を並べて比べるよ。"
             "どれが一番効くか、投資回収の目安まで見えるよ。")
    return _reply_dict(reply, "thinking", "compare", {},
                       ["結果を見せて", "もう一度実行", "提案書をつくりたい"])


def _handle_estimate(message: str, context: dict) -> dict:
    proj = (context or {}).get("project")
    if not proj:
        return _need_project("estimate")
    summary = _kpi_summary((context or {}).get("kpis"))
    reply = "待たずにざっくり概算を出すね（待ち行列の式で一瞬で計算するよ）。"
    if summary:
        reply += summary
    return _reply_dict(reply, "thinking", "estimate", {},
                       ["きちんと実行する", "結果を見せて", "シナリオを比較"])


def _handle_help(message: str, context: dict) -> dict:
    reply = ("ぼくは Cody！倉庫づくりを手伝うよ。できることは：\n"
             "・プロジェクトを作る（例：「EC倉庫を作って」）\n"
             "・シミュレーションを実行する\n"
             "・結果やKPIを見せる\n"
             "・シナリオを比較する（繁忙期・AGV導入など）\n"
             "・概算をすぐ出す\n"
             "気軽に話しかけてね。直せるところは一緒に直そう！")
    return _reply_dict(reply, "curious", "help", {},
                       ["プロジェクトを作る", "シミュレーションを実行", "結果を見せて",
                        "シナリオを比較"])


def _handle_smalltalk(message: str, context: dict) -> dict:
    if _contains(message, ("ありがとう", "ありがと", "助かる")):
        reply = "どういたしまして！いつでも頼ってね。次は何をする？"
        mood = "idle"
    elif _contains(message, ("かわいい", "可愛い", "すごい")):
        reply = "えへへ、ありがとう！倉庫のことならまかせて。何から始める？"
        mood = "excited"
    else:
        reply = "やあ！ぼくは Cody。倉庫づくり、一緒にやろう。何から始める？"
        mood = "excited"
    return _reply_dict(reply, mood, "smalltalk", {},
                       ["プロジェクトを作る", "できることを教えて", "結果を見せて"])


def _handle_unknown(message: str, context: dict) -> dict:
    reply = ("うーん、ちょっと分からなかったかも。でも大丈夫、"
             "プロジェクト作成・実行・結果表示・比較ならお手伝いできるよ。"
             "どれをやってみる？")
    return _reply_dict(reply, "curious", "unknown", {},
                       ["プロジェクトを作る", "シミュレーションを実行", "結果を見せて",
                        "できることを教えて"])


def _need_project(intent: str) -> dict:
    """Cody wants to act but there is no project loaded: gently steer to create."""
    reply = ("まずは倉庫プロジェクトが必要だよ。先に作ろうか？"
             "「〇〇という名前で作って」みたいに教えてね。")
    return _reply_dict(reply, "idle", intent, {},
                       ["プロジェクトを作る", "EC向けで作って", "できることを教えて"],
                       needs=["project"])


def _kpi_summary(kpis: dict | None) -> str:
    """One short Japanese line about throughput / bottleneck, or "" if N/A."""
    if not kpis:
        return ""
    parts: list[str] = []
    tput = kpis.get("throughput_per_hr") or kpis.get("capacity_orders_per_hr")
    if isinstance(tput, (int, float)) and tput:
        parts.append(f"処理能力は約{round(tput)}件/時")
    bn = kpis.get("bottleneck_jp")
    if bn:
        util = kpis.get("bottleneck_utilization") or kpis.get("picker_utilization")
        if isinstance(util, (int, float)) and util:
            parts.append(f"ボトルネックは{bn}（稼働率{round(util * 100)}%）")
        else:
            parts.append(f"ボトルネックは{bn}")
    if not parts:
        return ""
    return "（" + "、".join(parts) + "）"


# ---------------------------------------------------------------------------
# Public entry point — the LLM seam.
# ---------------------------------------------------------------------------
def respond(message: str, context: dict | None = None) -> dict:
    """Decide Cody's reply + intent for one user message.

    Pure and IO-free: returns the dict contract documented at the top of this
    module. ``context`` is optional and may carry the current project, the
    available templates, whether a run exists, and the latest KPIs.

    LLM SEAM: replace the body with an LLM tool-calling call that emits the same
    dict; everything downstream (the API endpoint, the frontend) is unchanged.
    """
    context = context or {}
    text = (message or "").strip()
    low = text.lower()

    if not text:
        return _handle_unknown(text, context)

    # Order: specific creation/compare first, then run/estimate/view, then
    # help/smalltalk, then fallback.
    if _contains(text, _KW_HELP):
        return _handle_help(text, context)
    if _contains(text, _KW_CREATE):
        return _handle_create(text, context)
    if _contains(low, _KW_COMPARE):
        return _handle_compare(text, context)
    if _contains(text, _KW_ESTIMATE):
        return _handle_estimate(text, context)
    if _contains(low, _KW_RUN):
        return _handle_run(text, context)
    if _contains(low, _KW_OPENVIEW):
        return _handle_open_view(text, context)
    if _contains(low, _KW_SMALLTALK):
        return _handle_smalltalk(text, context)
    return _handle_unknown(text, context)
