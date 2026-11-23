"""Knowledge-base admin gate: everything that changes the KB (upload/delete source files, ingest,
reindex, clear, enrich, delete documents, reload modes) needs an outsie admin session.

The browser signs in with Google through outsie (same Supabase PKCE flow as Pariksha's /?admin):
  GET  /api/admin/auth-config  -> the Supabase URL to start the Google sign-in (proxied from outsie)
  POST /api/admin/session      -> {auth_code, code_verifier} proxied to outsie's POST /admin/session,
                                  which only answers for a verified Google account in its
                                  OUTSIE_ADMIN_EMAILS allow-list; returns a 2-hour admin token
Every KB write then sends `X-Admin-Token: <token>`, and we ask outsie (`GET /admin/whoami`) whether it
is still valid. agentcyto holds no signing key or allow-list of its own: outsie is the single source of
truth, and taking an email off that list locks it out here too (within CACHE_SECONDS).

The token travels in X-Admin-Token rather than Authorization because nginx basic auth (still in front
of the dashboard) owns the Authorization header. Fails closed: if outsie is unreachable, writes are
refused.
"""
from __future__ import annotations

import hashlib
import os
import time

import httpx
from fastapi import Header, HTTPException

OUTSIE_URL = os.environ.get("OUTSIE_URL", "https://outsie.aryan.cfd").rstrip("/")
CACHE_SECONDS = 60
_cache: dict[str, tuple[float, str]] = {}  # sha256(token) -> (expires, admin email)


async def _whoami(token: str) -> str | None:
    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _cache.get(key)
    now = time.time()
    if hit and hit[0] > now:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{OUTSIE_URL}/admin/whoami", headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        raise HTTPException(503, "Cannot reach outsie to check the admin session")
    if r.status_code != 200:
        _cache.pop(key, None)
        return None
    who = str((r.json() or {}).get("admin") or "")
    if not who or who == "secret":  # a person must sign in; outsie's CLI secret is not accepted here
        return None
    if len(_cache) > 256:
        _cache.clear()
    _cache[key] = (now + CACHE_SECONDS, who)
    return who


async def require_kb_admin(x_admin_token: str | None = Header(default=None)) -> str:
    """FastAPI dependency: returns the admin's email or raises 401."""
    if not x_admin_token or len(x_admin_token) > 4096:
        raise HTTPException(401, "Admin sign-in required")
    who = await _whoami(x_admin_token)
    if not who:
        raise HTTPException(401, "Admin sign-in required or expired")
    return who


async def auth_config() -> dict:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{OUTSIE_URL}/auth/providers")
        return {"supabase_url": (r.json() or {}).get("supabase_url")}
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, "Cannot reach outsie")


async def create_session(auth_code: str, code_verifier: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(f"{OUTSIE_URL}/admin/session",
                                  json={"auth_code": auth_code, "code_verifier": code_verifier})
    except httpx.HTTPError:
        raise HTTPException(503, "Cannot reach outsie")
    if r.status_code != 200:
        try:
            detail = r.json().get("detail") or "Sign-in failed"
        except ValueError:
            detail = "Sign-in failed"
        raise HTTPException(r.status_code if r.status_code in (401, 403) else 502, detail)
    return r.json()
