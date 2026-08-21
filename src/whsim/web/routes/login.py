"""Login form + session endpoints for the self-hosted gate (see ``web.auth``).

Kept out of the SPA on purpose: the login page is a standalone document with no
imports, so it renders and works even when the rest of the frontend is not (or
must not yet be) reachable.
"""

from __future__ import annotations

import hmac
import math

from fastapi import APIRouter, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from whsim.web import auth

router = APIRouter()


_PAGE = """<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>WHSiM — サインイン</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0F141D;color:#E6EDF4;
    font-family:system-ui,-apple-system,"Segoe UI","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif}
  .box{width:min(380px,92vw);background:#161D29;border:1px solid rgba(150,172,200,.14);
    border-radius:14px;padding:28px 26px;box-shadow:0 18px 60px rgba(0,0,0,.45)}
  .bd{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .bd svg{width:30px;height:30px}
  .bd b{font-size:19px;letter-spacing:.06em}
  p.sub{margin:0 0 20px;font-size:12.5px;color:rgba(230,237,244,.5);line-height:1.6}
  label{display:block;font-size:12px;color:rgba(230,237,244,.62);margin-bottom:6px}
  input{width:100%;padding:11px 12px;font-size:15px;border-radius:8px;
    border:1px solid rgba(150,172,200,.22);background:#0F141D;color:#E6EDF4}
  input:focus{outline:2px solid #34E3FF;outline-offset:1px;border-color:transparent}
  button{width:100%;margin-top:16px;padding:11px 12px;font-size:15px;font-weight:600;
    border:0;border-radius:8px;background:#34E3FF;color:#04222C;cursor:pointer}
  button:hover:not(:disabled){background:#5CEBFF}
  button:disabled{opacity:.5;cursor:default}
  .err{margin-top:14px;font-size:12.5px;color:#FF8A8A;min-height:17px;line-height:1.5}
  .ft{margin-top:18px;font-size:11px;color:rgba(230,237,244,.32);line-height:1.6}
</style></head><body>
  <form class="box" method="post" action="/api/login" id="f">
    <div class="bd">
      <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <polygon points="9.83,19.2 32,32 32,57.6 9.83,44.8" fill="#1685b4"/>
        <polygon points="32,32 54.17,19.2 54.17,44.8 32,57.6" fill="#0c5a82"/>
        <polygon points="9.83,19.2 32,6.4 54.17,19.2 32,32" fill="#3ae6ff"/>
      </svg>
      <b>WHSiM</b>
    </div>
    <p class="sub">このシミュレータは所有者のPC上で動いています。<br>続けるにはパスワードを入力してください。</p>
    <input type="hidden" name="next" value="__NEXT__">
    <label for="pw">パスワード</label>
    <input id="pw" name="password" type="password" autocomplete="current-password"
           autofocus required>
    <button type="submit" id="b">サインイン</button>
    <div class="err" id="e" role="alert">__ERR__</div>
    <div class="ft">データはこのPCの中にのみ保存されます。<br>外部サービスへの送信・アカウント登録はありません。</div>
  </form>
<script>
// Progressive enhancement: post via fetch so a wrong password re-renders the
// message in place. Without JS the plain form POST still works (it redirects).
const f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('b');
f.addEventListener('submit',async(ev)=>{
  ev.preventDefault(); b.disabled=true; e.textContent='';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:f.password.value,next:f.next.value})});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j.ok){location.href=j.next||'/';return;}
    e.textContent=j.detail||'サインインできませんでした。';
  }catch(_){ e.textContent='サーバーに接続できませんでした。'; }
  b.disabled=false; f.password.select();
});
</script>
</body></html>"""


def _safe_next(raw: str | None) -> str:
    """Only same-origin, absolute-path redirects — never an open redirect."""
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw


def _page(next_url: str, err: str = "") -> HTMLResponse:
    html = (_PAGE
            .replace("__NEXT__", _safe_next(next_url).replace('"', "&quot;"))
            .replace("__ERR__", err))
    resp = HTMLResponse(html)
    # A cached login page can hand a stale CSRF-ish state to the next visitor.
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.get("/login")
def login_page(request: Request, next: str = "/"):   # noqa: A002 — query param name
    if not auth.enabled():
        return RedirectResponse("/", status_code=302)
    if auth.token_valid(request.cookies.get(auth.COOKIE_NAME), auth.configured_password()):
        return RedirectResponse(_safe_next(next), status_code=302)
    return _page(next)


def _set_session(resp: Response, password: str) -> None:
    resp.set_cookie(
        auth.COOKIE_NAME,
        auth.issue_token(password),
        max_age=auth.SESSION_TTL_S,
        httponly=True,            # not readable from JS -> XSS cannot lift it
        samesite="lax",           # blocks cross-site POSTs (the CSRF story here)
        secure=auth.secure_cookies(),
        path="/",
    )


@router.post("/api/login")
async def api_login(request: Request):
    password = auth.configured_password()
    if password is None:
        return JSONResponse({"ok": True, "next": "/"})

    ip = auth.client_ip(request)
    wait = auth.limiter.blocked_for(ip)
    if wait > 0:
        return JSONResponse(
            {"ok": False, "detail": f"試行回数が多すぎます。{math.ceil(wait / 60)}分ほど待ってからお試しください。"},
            status_code=429)

    # Accept both the JSON path (fetch) and a plain form POST (no-JS fallback).
    supplied, next_url = "", "/"
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("application/json"):
        body = await request.json() if await request.body() else {}
        if isinstance(body, dict):
            supplied = str(body.get("password") or "")
            next_url = str(body.get("next") or "/")
    else:
        form = await request.form()
        supplied = str(form.get("password") or "")
        next_url = str(form.get("next") or "/")
    next_url = _safe_next(next_url)

    if not hmac.compare_digest(supplied, password):
        auth.limiter.record_failure(ip)
        if ctype.startswith("application/json"):
            return JSONResponse({"ok": False, "detail": "パスワードが違います。"}, status_code=401)
        return _page(next_url, "パスワードが違います。")

    auth.limiter.record_success(ip)
    if ctype.startswith("application/json"):
        resp: Response = JSONResponse({"ok": True, "next": next_url})
    else:
        resp = RedirectResponse(next_url, status_code=303)
    _set_session(resp, password)
    return resp


@router.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME, path="/")
    return resp


@router.get("/healthz")
def healthz():
    """Unauthenticated liveness probe for the tunnel / process supervisor.

    Deliberately says nothing about the data: whether a project exists is
    itself information the gate is there to protect.
    """
    return {"ok": True}
