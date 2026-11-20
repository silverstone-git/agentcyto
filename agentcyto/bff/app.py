"""agentcyto BFF: durable chat jobs, SSE replay and per-session isolation.

The BFF is the only component that holds the LiteLLM master key. It never
returns it and never accepts one from a browser. Authentication is performed
by nginx; the BFF only checks the forwarded X-Auth-User header.
"""

import asyncio
import json
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from db import DB, clear_gateway_sessions

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://gateway:4000").rstrip("/")
MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
WORKSPACE_DIR = os.environ.get("CLI_WORKSPACE_DIR", "/workspaces")
MODES_FILE = os.environ.get("AGENCYTO_MODES", "/app/modes.yaml")
REQUIRE_AUTH_HEADER = os.environ.get("REQUIRE_AUTH_HEADER", "1") not in ("0", "false", "no")
DAILY_BUDGET_OVERRIDE = os.environ.get("AGENCYTO_DAILY_BUDGET_USD")
MAX_ATTEMPTS = 2
SESSION_RE = re.compile(r"^[0-9a-fA-F]{16,64}$")

SYSTEM_PROMPT = (
    "You are agentcyto, a helpful assistant. Answer the user's latest message. "
    "When asked about earlier turns, use the conversation history provided."
)

db = DB()
modes: dict = {}
_tasks: dict[str, asyncio.Task] = {}


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

def load_modes() -> None:
    global modes
    with open(MODES_FILE, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data.get("modes"), dict):
        raise RuntimeError("modes.yaml has no `modes` mapping")
    if DAILY_BUDGET_OVERRIDE:
        data["daily_budget_usd"] = float(DAILY_BUDGET_OVERRIDE)
    modes = data


def check_session(session_id: str) -> str:
    if not isinstance(session_id, str) or not SESSION_RE.fullmatch(session_id):
        raise HTTPException(400, "invalid session id")
    return session_id


def resolve_job_model(mode: str, role: str, model: str | None) -> tuple[str, dict]:
    """Return (alias, mode_config), applying the daily paid-model guard."""
    cfg = (modes.get("modes") or {}).get(mode)
    if not cfg:
        raise HTTPException(400, f"unknown mode: {mode}")
    if role not in ("chat", "agent"):
        raise HTTPException(400, "role must be 'chat' or 'agent'")

    alias = cfg.get(role)
    allowed = modes.get("agent_models") if role == "agent" else modes.get("chat_models")
    if model:
        if not isinstance(model, str) or model not in (allowed or []):
            raise HTTPException(400, f"model '{model}' is not allowed for role '{role}'")
        alias = model

    start = time.time() - (time.time() % 86400)  # UTC day boundary
    spent = db.spend_since(start)
    cap = float(modes.get("daily_budget_usd") or 0)
    downgraded = False
    if cfg.get("paid") and alias in (modes.get("price_usd_per_million") or {}) and (
        not modes.get("allow_paid", True) or (cap > 0 and spent >= cap)
    ):
        fallback = "light-tool" if role == "agent" and "light-tool" in modes["modes"] else "light"
        alias = modes["modes"][fallback].get(role) or alias
        downgraded = True

    return alias, {**cfg, "downgraded": downgraded, "spent_usd": spent, "budget_usd": cap}


def ensure_workspace(session_id: str) -> None:
    """Create a private workspace for agent sessions, never following symlinks."""
    root = Path(WORKSPACE_DIR).resolve()
    target = (root / session_id).resolve()
    if target.parent != root or target == root:
        raise HTTPException(400, "invalid workspace path")
    target.mkdir(mode=0o700, parents=True, exist_ok=True)


# --------------------------------------------------------------------------- #
# Job execution
# --------------------------------------------------------------------------- #

def schedule(job_id: str) -> None:
    if job_id in _tasks:
        return
    task = asyncio.create_task(run_job(job_id))
    _tasks[job_id] = task
    task.add_done_callback(lambda t: _tasks.pop(job_id, None))


def estimate_cost(model: str | None, usage: dict | None) -> float:
    prices = modes.get("price_usd_per_million") or {}
    rate = float(prices.get(model) or 0)
    if not rate or not usage:
        return 0.0
    tokens = int(usage.get("prompt_tokens") or 0) + int(usage.get("completion_tokens") or 0)
    return round(rate * tokens / 1_000_000, 6)


async def run_job(job_id: str) -> None:
    job = db.get_job(job_id)
    if not job or job["status"] in ("done", "blocked", "cancelled"):
        return

    attempts = int(job["attempts"]) + 1
    db.update_job(job_id, status="running", attempts=attempts)
    db.add_event(job_id, "status", {"status": "running", "attempt": attempts})

    history = [{"role": "system", "content": SYSTEM_PROMPT}] + db.get_history(job["session_id"])
    payload = {"model": job["model"], "messages": history, "stream": True}
    headers = {
        "Authorization": f"Bearer {MASTER_KEY}",
        "Content-Type": "application/json",
        "X-Agentcyto-Session": job["session_id"],
    }
    text_parts: list[str] = []
    usage: dict | None = None
    resolved: str | None = None

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=10)) as client:
            async with client.stream(
                "POST", f"{GATEWAY_URL}/v1/chat/completions", json=payload, headers=headers
            ) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode(errors="replace")[:500]
                    raise RuntimeError(f"gateway returned {resp.status_code}: {body}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if raw == "[DONE]":
                        break
                    try:
                        chunk = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    resolved = chunk.get("model") or resolved
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    text = delta.get("content")
                    if text:
                        text_parts.append(text)
                        db.add_event(job_id, "delta", {"text": text, "attempt": attempts})

        reply = "".join(text_parts)
        if not reply.strip():
            raise RuntimeError("gateway returned an empty reply")

        db.add_message(job["session_id"], "assistant", reply, resolved, job_id)
        db.record_usage(job_id, job["session_id"], job["model"], resolved,
                        int((usage or {}).get("prompt_tokens") or 0),
                        int((usage or {}).get("completion_tokens") or 0),
                        estimate_cost(resolved or job["model"], usage))
        db.update_job(job_id, status="done", resolved_model=resolved, error=None)
        db.add_event(job_id, "done", {
            "text": reply, "model": resolved, "usage": usage, "attempt": attempts,
        })
    except asyncio.CancelledError:
        db.update_job(job_id, status="cancelled", error="cancelled by client")
        db.add_event(job_id, "status", {"status": "cancelled", "attempt": attempts})
        raise
    except Exception as exc:  # noqa: BLE001 - anything upstream is a job failure
        error = str(exc)[:1000]
        if attempts < MAX_ATTEMPTS:
            db.update_job(job_id, status="partial", error=error)
            db.add_event(job_id, "status", {"status": "partial", "detail": "retrying",
                                            "attempt": attempts})
            await asyncio.sleep(min(2 ** attempts, 10))
            schedule(job_id)
        else:
            db.update_job(job_id, status="blocked", error=error)
            db.add_event(job_id, "job_error", {"error": error, "attempt": attempts})


def restore_jobs() -> None:
    """Requeue jobs interrupted by a BFF restart; history is only committed on success."""
    for job in db.recoverable_jobs():
        if int(job["attempts"]) < MAX_ATTEMPTS:
            db.update_job(job["id"], status="partial", error="interrupted by restart")
            schedule(job["id"])
        else:
            db.update_job(job["id"], status="blocked", error="interrupted by restart")
            db.add_event(job["id"], "job_error", {"error": "interrupted by restart"})


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_modes()
    restore_jobs()
    yield


app = FastAPI(title="agentcyto BFF", lifespan=lifespan)


@app.middleware("http")
async def auth_boundary(request: Request, call_next):
    if REQUIRE_AUTH_HEADER and request.url.path.startswith("/api/") \
            and request.url.path != "/api/health":
        if not request.headers.get("x-auth-user"):
            return JSONResponse({"detail": "missing X-Auth-User"}, status_code=401)
    return await call_next(request)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=200_000)
    mode: str = "heavy"
    role: str = "chat"
    session_id: str | None = None
    name: str | None = None
    model: str | None = None
    idempotency_key: str | None = None


class SessionRequest(BaseModel):
    name: str = ""


@app.get("/api/health")
async def health():
    detail = "ok"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{GATEWAY_URL}/health/liveliness")
            gateway_ok = r.status_code == 200
            detail = f"gateway {r.status_code}"
    except Exception as exc:  # noqa: BLE001
        gateway_ok = False
        detail = str(exc)[:200]
    db.record_health(gateway_ok, detail)
    return {"status": "ok" if gateway_ok else "degraded", "gateway": "ok" if gateway_ok else "down"}


@app.get("/api/models")
async def models():
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{GATEWAY_URL}/v1/models",
                                 headers={"Authorization": f"Bearer {MASTER_KEY}"})
            r.raise_for_status()
            return r.json()
    except Exception:  # noqa: BLE001
        return {"data": [{"id": a} for a in (modes.get("chat_models") or [])
                         + (modes.get("agent_models") or [])]}


@app.get("/api/modes")
async def get_modes():
    return modes


@app.post("/api/admin/reload")
async def reload_modes():
    load_modes()
    return {"status": "reloaded"}


@app.post("/api/sessions")
async def create_session(req: SessionRequest = SessionRequest()):
    session_id = uuid.uuid4().hex
    return db.create_session(session_id, (req.name or "")[:200])


@app.get("/api/sessions")
async def list_sessions():
    return db.list_sessions()


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    check_session(session_id)
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    return {**session, "messages": db.get_messages(session_id),
            "jobs": db.jobs_for_session(session_id)}


@app.patch("/api/sessions/{session_id}")
async def rename_session(session_id: str, req: SessionRequest):
    check_session(session_id)
    if not db.get_session(session_id):
        raise HTTPException(404, "session not found")
    db.rename_session(session_id, req.name)
    return db.get_session(session_id)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    check_session(session_id)
    if not db.get_session(session_id):
        raise HTTPException(404, "session not found")
    cleared = clear_gateway_sessions(session_id)
    db.delete_session(session_id)
    return {"status": "deleted", "cli_sessions_cleared": cleared}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    alias, _cfg = resolve_job_model(req.mode, req.role, req.model)
    session_id = check_session(req.session_id) if req.session_id else uuid.uuid4().hex
    if not db.get_session(session_id):
        db.create_session(session_id, (req.name or "")[:200])

    if req.idempotency_key:
        existing = db.find_idempotent_job(session_id, req.idempotency_key)
        if existing:
            return {"job_id": existing["id"], "session_id": session_id,
                    "model": existing["model"], "status": existing["status"]}

    if req.role == "agent" or "-agent" in alias:
        ensure_workspace(session_id)
    db.add_message(session_id, "user", req.message)

    job_id = uuid.uuid4().hex
    db.create_job(job_id, session_id, req.mode, req.role, alias, req.idempotency_key)
    schedule(job_id)
    return {"job_id": job_id, "session_id": session_id, "model": alias, "status": "queued"}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    task = _tasks.get(job_id)
    if task:
        task.cancel()
    else:
        db.update_job(job_id, status="cancelled", error="cancelled by client")
    return {"status": "cancelled"}


@app.get("/api/stream")
async def stream(request: Request, job_id: str, after: int = 0):
    if not db.get_job(job_id):
        raise HTTPException(404, "job not found")

    async def events():
        cursor = max(0, after)
        last_beat = time.monotonic()
        while True:
            batch = db.get_events_after(job_id, cursor)
            for ev in batch:
                cursor = ev["seq"]
                yield (f"id: {cursor}\nevent: {ev['type']}\n"
                       f"data: {json.dumps(ev['data'], ensure_ascii=False)}\n\n")
            job = db.get_job(job_id)
            if job and job["status"] in ("done", "blocked", "cancelled"):
                if not batch:
                    yield (f"event: status\ndata: "
                           f"{json.dumps({'status': job['status'], 'error': job['error']})}\n\n")
                break
            if await request.is_disconnected():
                break
            await asyncio.sleep(0.25)
            if time.monotonic() - last_beat > 15:
                yield ": heartbeat\n\n"
                last_beat = time.monotonic()

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.get("/api/usage")
async def usage(limit: int = 100):
    cap = float(modes.get("daily_budget_usd") or 0)
    start = time.time() - (time.time() % 86400)
    return {"spent_usd": db.spend_since(start), "budget_usd": cap,
            "recent": db.usage_recent(min(limit, 500))}


# Static UI last so /api/* routes always win. nginx proxies /agentcyto/ here.
UI_DIR = os.environ.get("AGENCYTO_UI", "/app/ui")
if os.path.isdir(UI_DIR):
    app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="ui")
