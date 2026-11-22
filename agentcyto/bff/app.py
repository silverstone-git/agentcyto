"""agentcyto BFF: durable chat jobs, SSE replay and per-session isolation.

The BFF is the only component that holds the LiteLLM master key. It never
returns it and never accepts one from a browser. Authentication is performed
by nginx; the BFF only checks the forwarded X-Auth-User header.
"""

import asyncio
import hmac
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from db import DB, clear_gateway_sessions
from kb import get_kb, KB, KB_DEFAULT_SKILL, skill_title
from retrieval import Retriever
import byok
import websearch

KB_SOURCE_DIR = os.environ.get("KB_SOURCE_DIR", "/kb-source")
KB_INGEST_TIMEOUT = int(os.environ.get("KB_INGEST_TIMEOUT_SECONDS", "3600"))
_kb_tasks: dict[str, asyncio.Task] = {}

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://gateway:4000").rstrip("/")
MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
WORKSPACE_DIR = os.environ.get("CLI_WORKSPACE_DIR", "/workspaces")
MODES_FILE = os.environ.get("AGENCYTO_MODES", "/app/modes.yaml")
REQUIRE_AUTH_HEADER = os.environ.get("REQUIRE_AUTH_HEADER", "1") not in ("0", "false", "no")
# Bearer key for server-to-server POST /api/retrieve; defaults to the gateway master key, which any
# such caller already holds to reach /api/v1, so it grants nothing new.
RETRIEVE_API_KEY = os.environ.get("RETRIEVE_API_KEY") or MASTER_KEY
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
# BYOK API keys live only here (never in SQLite/events/logs), keyed by job id.
_byok_keys: dict[str, dict] = {}


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


async def retrieve_context(job_id: str, job: dict, opts: dict) -> str:
    """Structure-aware KB (+ optional web) retrieval; see retrieval.py for the pipeline."""
    doc_ids = json.loads(job["kb_docs"]) if job.get("kb_docs") else []
    web = bool(opts.get("web_search"))
    if not doc_ids and not web:
        return ""
    r = Retriever(db=db, kb=get_kb(db), job_id=job_id, session_id=job["session_id"],
                  gateway_url=GATEWAY_URL, master_key=MASTER_KEY, cfg=modes.get("retrieval") or {},
                  llm=opts.get("llm_search", True) is not False, web=web,
                  price=lambda m, u: estimate_cost(m, u))
    ctx, _ = await r.run(doc_ids, db.get_history(job["session_id"]))
    return ctx


async def run_job(job_id: str) -> None:
    job = db.get_job(job_id)
    if not job or job["status"] in ("done", "blocked", "cancelled"):
        return

    attempts = int(job["attempts"]) + 1
    db.update_job(job_id, status="running", attempts=attempts)
    db.add_event(job_id, "status", {"status": "running", "attempt": attempts})

    opts = json.loads(job["options"]) if job.get("options") else {}
    system_prompt = SYSTEM_PROMPT
    if opts.get("system_prompt"):
        system_prompt = SYSTEM_PROMPT + "\n\nUser's custom instructions:\n" + opts["system_prompt"]
    kb_ctx = ""
    if job.get("kb_docs") or opts.get("web_search"):
        try:
            kb_ctx = await retrieve_context(job_id, job, opts)
        except Exception as exc:  # noqa: BLE001 - retrieval must never kill the chat
            db.add_event(job_id, "trace", {"step": "error", "text": f"retrieval failed: {exc}"[:300]})
            kb_ctx = ""
    history = [{"role": "system", "content": system_prompt}] + db.get_history(job["session_id"])
    if kb_ctx:
        # CLI-backed models drop system messages, so put the passages in the last user turn.
        for m in reversed(history):
            if m["role"] == "user":
                m["content"] = f"{kb_ctx}\n\n---\nUser question:\n{m['content']}"
                break
    text_parts: list[str] = []
    usage: dict | None = None
    resolved: str | None = None

    async def gateway_stream():
        payload = {"model": job["model"], "messages": history, "stream": True}
        if opts.get("temperature") is not None:
            payload["temperature"] = opts["temperature"]
        if opts.get("max_tokens"):
            payload["max_tokens"] = opts["max_tokens"]
        headers = {
            "Authorization": f"Bearer {MASTER_KEY}",
            "Content-Type": "application/json",
            "X-Agentcyto-Session": job["session_id"],
        }
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
                    if chunk.get("model"):
                        yield "model", chunk["model"]
                    if chunk.get("usage"):
                        yield "usage", chunk["usage"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    think = delta.get("reasoning_content") or delta.get("reasoning")
                    if think:
                        yield "thinking", think
                    if delta.get("content"):
                        yield "delta", delta["content"]

    async def byok_stream():
        cfg = _byok_keys.get(job_id)
        if not cfg:
            raise RuntimeError("custom-provider credentials are no longer available "
                               "(server restarted); please resend the message")
        async for item in byok.stream_chat(cfg, history, opts.get("temperature"), opts.get("max_tokens")):
            yield item

    try:
        async for kind, val in (byok_stream() if opts.get("byok") else gateway_stream()):
            if kind == "model":
                resolved = val
            elif kind == "usage":
                usage = val
            elif kind == "thinking":
                db.add_event(job_id, "thinking", {"text": val, "attempt": attempts})
            elif kind == "delta":
                text_parts.append(val)
                db.add_event(job_id, "delta", {"text": val, "attempt": attempts})

        reply = "".join(text_parts)
        if not reply.strip():
            raise RuntimeError("gateway returned an empty reply")

        db.add_message(job["session_id"], "assistant", reply, resolved, job_id, db.job_meta(job_id))
        db.record_usage(job_id, job["session_id"], job["model"], resolved,
                        int((usage or {}).get("prompt_tokens") or 0),
                        int((usage or {}).get("completion_tokens") or 0),
                        0.0 if opts.get("byok") else estimate_cost(resolved or job["model"], usage))
        db.update_job(job_id, status="done", resolved_model=resolved, error=None)
        db.add_event(job_id, "done", {
            "text": reply, "model": resolved, "usage": usage, "attempt": attempts,
        })
        _byok_keys.pop(job_id, None)
    except asyncio.CancelledError:
        _byok_keys.pop(job_id, None)
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
            _byok_keys.pop(job_id, None)
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
    kb = get_kb(db)
    kb.db.kb_backfill_skill(KB_DEFAULT_SKILL)
    if kb.fts_outdated() and kb.db.kb_list_documents():
        # Stemmed + breadcrumb index (fts_version 2): rebuild once in the background.
        app.state.fts_task = asyncio.create_task(asyncio.to_thread(kb.migrate_index))
    if Path(KB_SOURCE_DIR).exists():
        files = list(kb.source_files())
        if files:
            app.state.kb_files = len(files)
        else:
            app.state.kb_files = 0
    else:
        app.state.kb_files = 0
    yield


app = FastAPI(title="agentcyto BFF", lifespan=lifespan)


SERVICE_PATHS = {"/api/retrieve", "/api/kb/skills"}


def _service_bearer_ok(request: Request) -> bool:
    """Server-to-server callers (e.g. outstagram) authenticate with a bearer key instead of
    nginx basic auth. Only the read-only SERVICE_PATHS accept it."""
    if not RETRIEVE_API_KEY:
        return False
    return hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {RETRIEVE_API_KEY}")


@app.middleware("http")
async def auth_boundary(request: Request, call_next):
    if REQUIRE_AUTH_HEADER and request.url.path.startswith("/api/") \
            and request.url.path != "/api/health":
        if request.url.path in SERVICE_PATHS and _service_bearer_ok(request):
            return await call_next(request)
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
    kb_docs: list[str] | None = None
    kb_skills: list[str] | None = None  # attach every document of these skills (KB top-level folders)
    reply_to: dict | None = None  # {"role": "user"|"assistant", "content": str}
    system_prompt: str | None = Field(default=None, max_length=8000)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=200_000)
    byok: dict | None = None  # {api_type, base_url, api_key, model, label}: user's own provider
    llm_search: bool = True    # LLM plans the KB search and reranks passages
    web_search: bool = False   # also search the web (Brave) and scrape top pages


class CompressRequest(BaseModel):
    action: str = "summarize"  # "summarize" | "clear"
    model: str | None = None   # chat alias for the summary (default: light)
    byok: dict | None = None


class ByokModelsRequest(BaseModel):
    byok: dict


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
    return {**modes, "web_search_available": websearch.available()}


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


@app.post("/api/sessions/{session_id}/autoname")
async def autoname_session(session_id: str):
    """Ask a light model for a short topic title based on the first exchange."""
    check_session(session_id)
    if not db.get_session(session_id):
        raise HTTPException(404, "session not found")
    msgs = [m for m in db.get_history(session_id)][:4]
    if not msgs:
        raise HTTPException(400, "nothing to name yet")
    convo = "\n\n".join(f"{m['role'].upper()}: {m['content'][:600]}" for m in msgs)
    prompt = ("Write a short topic title (2 to 6 words, no quotes, no trailing punctuation) "
              "for this conversation. Reply with the title only.\n\n" + convo)
    payload = {"model": "light", "messages": [{"role": "user", "content": prompt}], "stream": False}
    headers = {"Authorization": f"Bearer {MASTER_KEY}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as client:
            resp = await client.post(f"{GATEWAY_URL}/v1/chat/completions", json=payload, headers=headers)
        resp.raise_for_status()
        title = resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"auto-name failed: {str(exc)[:200]}")
    title = " ".join(title.replace("\n", " ").strip().strip("\"'`*#").split())[:60].rstrip(".")
    if not title:
        raise HTTPException(502, "auto-name returned an empty title")
    db.rename_session(session_id, title)
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
    options: dict = {}
    if req.byok:
        if req.role == "agent":
            raise HTTPException(400, "custom providers support chat only, not agent mode")
        try:
            cfg = await byok.validate_cfg(req.byok)
        except byok.ByokError as exc:
            raise HTTPException(400, str(exc))
        alias = f"byok:{cfg['model']}"[:120]
        options["byok"] = {k: cfg[k] for k in ("api_type", "base_url", "model", "label")}
    else:
        alias, _cfg = resolve_job_model(req.mode, req.role, req.model)
    if req.system_prompt and req.system_prompt.strip():
        options["system_prompt"] = req.system_prompt.strip()
    if req.temperature is not None:
        options["temperature"] = req.temperature
    if req.max_tokens:
        options["max_tokens"] = req.max_tokens
    if not req.llm_search:
        options["llm_search"] = False
    if req.web_search:
        options["web_search"] = True
    session_id = check_session(req.session_id) if req.session_id else uuid.uuid4().hex
    if not db.get_session(session_id):
        db.create_session(session_id, " ".join((req.name or req.message).split())[:48])

    if req.idempotency_key:
        existing = db.find_idempotent_job(session_id, req.idempotency_key)
        if existing:
            return {"job_id": existing["id"], "session_id": session_id,
                    "model": existing["model"], "status": existing["status"]}

    if not req.byok and (req.role == "agent" or "-agent" in alias):
        ensure_workspace(session_id)
    user_text = req.message
    if req.reply_to and isinstance(req.reply_to.get("content"), str):
        who = "the assistant's" if req.reply_to.get("role") == "assistant" else "my"
        quote = " ".join(req.reply_to["content"].split())[:600]
        user_text = f'[In reply to {who} earlier message: "{quote}"]\n\n{req.message}'
    db.add_message(session_id, "user", user_text)

    job_id = uuid.uuid4().hex
    db.create_job(job_id, session_id, req.mode, req.role, alias, req.idempotency_key,
                  _expand_kb(req.kb_docs, req.kb_skills),
                  options or None)
    if req.byok:
        _byok_keys[job_id] = cfg
    schedule(job_id)
    return {"job_id": job_id, "session_id": session_id, "model": alias, "status": "queued"}


@app.get("/api/search")
async def search(q: str = "", limit: int = 40):
    """Universal search over every chat's title and message text."""
    q = " ".join(q.split())
    if len(q) < 2:
        return {"query": q, "results": []}
    limit = max(1, min(limit, 100))
    results = []
    for s_ in db.search_sessions(q, 8):
        results.append({"kind": "session", "session_id": s_["id"], "session_name": s_["name"],
                        "snippet": "", "updated": s_["updated"]})
    low = q.lower()
    for m in db.search_messages(q, limit):
        text = " ".join(m["content"].split())
        i = text.lower().find(low)
        a = max(0, i - 60)
        snippet = ("…" if a else "") + text[a:i + len(q) + 120] + ("…" if i + len(q) + 120 < len(text) else "")
        results.append({"kind": "message", "session_id": m["session_id"], "session_name": m["session_name"],
                        "message_id": m["id"], "role": m["role"], "snippet": snippet,
                        "match": text[i:i + len(q)], "updated": m["created"]})
    return {"query": q, "results": results}


@app.post("/api/sessions/{session_id}/compress")
async def compress_session(session_id: str, req: CompressRequest):
    """Summarise the live context into one note ("summarize") or drop it ("clear").

    Old messages stay visible in the UI (archived) but are no longer sent upstream.
    Native CLI sessions are reset too so they do not keep the old context.
    """
    check_session(session_id)
    if not db.get_session(session_id):
        raise HTTPException(404, "session not found")
    if req.action not in ("summarize", "clear"):
        raise HTTPException(400, "action must be 'summarize' or 'clear'")
    if any(j["status"] in ("queued", "running", "partial") for j in db.jobs_for_session(session_id, 5)):
        raise HTTPException(409, "wait for the current reply to finish first")
    live = db.get_history(session_id)
    if not live:
        raise HTTPException(400, "no live context to compress")

    summary = ""
    if req.action == "summarize":
        parts, budget = [], 60_000
        for m in reversed(live):  # keep the newest material when over budget
            chunk = f"{m['role'].upper()}: {m['content'][:6000]}"
            if budget - len(chunk) < 0:
                break
            budget -= len(chunk)
            parts.append(chunk)
        convo = "\n\n".join(reversed(parts))
        prompt = ("Compress the conversation below into a dense note that lets an assistant continue it "
                  "seamlessly. Keep: the user's goals and preferences, decisions made, key facts, names, "
                  "numbers, equations, code or commands that matter, and unresolved questions. Drop "
                  "pleasantries and repetition. Write plain text or short bullet points, no preamble.\n\n"
                  "=== CONVERSATION ===\n" + convo)
        try:
            if req.byok:
                cfg = await byok.validate_cfg(req.byok)
                summary = await byok.complete(cfg, [{"role": "user", "content": prompt}])
            else:
                model = req.model or "light"
                if model not in (modes.get("chat_models") or []):
                    raise HTTPException(400, f"model '{model}' is not allowed")
                async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10)) as client:
                    resp = await client.post(
                        f"{GATEWAY_URL}/v1/chat/completions",
                        json={"model": model, "stream": False,
                              "messages": [{"role": "user", "content": prompt}]},
                        headers={"Authorization": f"Bearer {MASTER_KEY}", "Content-Type": "application/json"})
                resp.raise_for_status()
                summary = resp.json()["choices"][0]["message"]["content"]
        except HTTPException:
            raise
        except byok.ByokError as exc:
            raise HTTPException(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"compression failed: {str(exc)[:200]}")
        summary = summary.strip()
        if not summary:
            raise HTTPException(502, "compression returned an empty summary")

    archived = db.archive_messages(session_id)
    db.add_message(session_id, "system", summary)
    clear_gateway_sessions(session_id)
    return {"status": "ok", "action": req.action, "archived": archived, "summary": summary}


@app.post("/api/byok/models")
async def byok_models(req: ByokModelsRequest):
    """List the models a user-supplied provider exposes (also doubles as a key check)."""
    try:
        cfg = await byok.validate_cfg(req.byok, need_model=False)
        return {"models": await byok.list_models(cfg)}
    except byok.ByokError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"could not reach provider: {str(exc)[:200]}")


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


# --------------------------------------------------------------------------- #
# Knowledge base API
# --------------------------------------------------------------------------- #

class KBReindexRequest(BaseModel):
    force: bool = False


class KBEnrichRequest(BaseModel):
    model: str = "heavy"


def _expand_kb(docs: list[str] | None, skills: list[str] | None) -> list[str]:
    """Explicit documents plus every document of the attached skills (deduplicated, capped)."""
    out = [d for d in (docs or []) if re.fullmatch(r'[\w\-.]{1,120}', d)]
    sk = [x for x in (skills or []) if re.fullmatch(r'[a-z0-9\-]{1,60}', x)][:10]
    for d in db.kb_doc_ids_for_skills(sk):
        if d not in out:
            out.append(d)
    return out[:60]


@app.get("/api/kb/skills")
async def kb_skills():
    """Skills = top-level folders of the KB source. Ingested counts plus folders not ingested yet."""
    kb = get_kb(db)
    on_disk = kb.source_skills()
    rows = {r["skill"]: r for r in kb.db.kb_list_skills()}
    out = []
    for skill in sorted(set(on_disk) | set(rows)):
        r = rows.get(skill, {})
        out.append({"skill": skill, "title": skill_title(skill), "documents": int(r.get("documents") or 0),
                    "nodes": int(r.get("nodes") or 0), "equations": int(r.get("equations") or 0),
                    "source_files": on_disk.get(skill, 0), "updated": r.get("updated")})
    return {"skills": out, "default": KB_DEFAULT_SKILL}


@app.get("/api/kb/status")
async def kb_status():
    kb = get_kb(db)
    files = kb.source_files()
    docs = kb.db.kb_list_documents()
    latest = kb.db.kb_list_ingestions(limit=1)
    total_nodes = 0
    total_equations = 0
    total_symbols = 0
    try:
        with kb.db.conn() as c:
            total_nodes = int(c.execute("SELECT COUNT(*) FROM kb_nodes").fetchone()[0])
            total_equations = int(c.execute(
                "SELECT COUNT(*) FROM kb_nodes WHERE type='equation'").fetchone()[0])
            total_symbols = int(c.execute("SELECT COUNT(*) FROM kb_symbols").fetchone()[0])
    except sqlite3.Error:
        pass
    return {
        "source_dir": str(KB_SOURCE_DIR),
        "source_dir_exists": Path(KB_SOURCE_DIR).exists(),
        "source_files": len(files),
        "documents": len(docs),
        "total_nodes": total_nodes,
        "total_equations": total_equations,
        "total_symbols": total_symbols,
        "latest_ingestion": latest[0] if latest else None,
        "skills": len(kb.source_skills()),
        "default_skill": KB_DEFAULT_SKILL,
    }


@app.post("/api/kb/ingest")
async def kb_ingest(skill: str | None = None):
    """Ingest new/changed files: all skills, or only ?skill=history."""
    kb = get_kb(db)
    files = kb.source_files(skill)
    if not files:
        where = f"{KB_SOURCE_DIR}/{skill}" if skill else str(KB_SOURCE_DIR)
        return {"status": "nothing", "files_found": 0,
                "message": f"No .md files found in {where}"}

    ingestion_id = uuid.uuid4().hex

    def run():
        try:
            return kb.ingest_all(ingestion_id, force=False, skill=skill)
        finally:
            _kb_tasks.pop(ingestion_id, None)

    task = asyncio.create_task(asyncio.to_thread(run))
    _kb_tasks[ingestion_id] = task
    task.add_done_callback(lambda t: _kb_tasks.pop(ingestion_id, None))

    return {"status": "queued", "ingestion_id": ingestion_id,
            "files_found": len(files)}


@app.post("/api/kb/reindex")
async def kb_reindex():
    kb = get_kb(db)
    files = kb.source_files()
    if not files:
        return {"status": "nothing", "files_found": 0}

    ingestion_id = uuid.uuid4().hex

    def run():
        try:
            return kb.reindex_all(ingestion_id)
        finally:
            _kb_tasks.pop(ingestion_id, None)

    task = asyncio.create_task(asyncio.to_thread(run))
    _kb_tasks[ingestion_id] = task
    task.add_done_callback(lambda t: _kb_tasks.pop(ingestion_id, None))

    return {"status": "queued", "ingestion_id": ingestion_id,
            "files_found": len(files)}


@app.delete("/api/kb/clear")
async def kb_clear():
    kb = get_kb(db)
    return kb.clear_all()


@app.get("/api/kb/documents")
async def kb_documents():
    return get_kb(db).db.kb_list_documents()


@app.get("/api/kb/documents/{doc_id}")
async def kb_document(doc_id: str):
    kb = get_kb(db)
    doc = kb.db.kb_get_document(doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    doc["tree"] = kb.db.kb_get_node_tree(doc_id)
    return doc


@app.delete("/api/kb/documents/{doc_id}")
async def kb_delete_document(doc_id: str):
    kb = get_kb(db)
    if not kb.db.kb_get_document(doc_id):
        raise HTTPException(404, "document not found")
    docs_removed, nodes_removed = kb.db.kb_delete_document(doc_id)
    return {"status": "deleted", "documents_removed": docs_removed,
            "nodes_removed": nodes_removed}


@app.get("/api/kb/search")
async def kb_search(q: str | None = None, type: str | None = None,
                    doc: str | None = None, limit: int = 50):
    kb = get_kb(db)
    results: list[dict] = []
    if q:
        # FTS5 full-text search
        fts_query = q
        try:
            results = kb.db.kb_search_fts(fts_query, limit=limit,
                                          doc_id=doc, node_type=type)
        except sqlite3.Error:
            results = []
    elif type or doc:
        # List nodes of a given type / document without full-text
        with kb.db.conn() as c:
            sql = "SELECT * FROM kb_nodes WHERE 1=1"
            params: list = []
            if doc:
                sql += " AND document_id=?"
                params.append(doc)
            if type:
                sql += " AND type=?"
                params.append(type)
            sql += " ORDER BY id LIMIT ?"
            params.append(limit)
            results = [dict(r) for r in c.execute(sql, params).fetchall()]
    else:
        return {"results": [], "message": "provide q, type, and/or doc"}

    # Enrich each result with parent section and document info
    enriched = []
    for r in results:
        d = dict(r)
        parent = kb.db.kb_get_node(d["parent_id"]) if d.get("parent_id") else None
        doc_row = kb.db.kb_get_document(d["document_id"]) if d.get("document_id") else None
        d["parent_title"] = parent.get("title") if parent else None
        d["parent_type"] = parent.get("type") if parent else None
        d["document_name"] = doc_row.get("file_name") if doc_row else None
        d["document_title"] = doc_row.get("title") if doc_row else None
        enriched.append(d)
    return {"results": enriched, "count": len(enriched)}


@app.get("/api/kb/nodes/{node_id}")
async def kb_node(node_id: str):
    kb = get_kb(db)
    node = kb.db.kb_get_node(node_id)
    if not node:
        raise HTTPException(404, "node not found")
    doc = kb.db.kb_get_document(node["document_id"]) if node.get("document_id") else None
    children = kb.db.kb_node_children(node_id)
    edges = kb.db.kb_get_edges(node_id)
    return {"node": node, "document": doc, "children": children, "edges": edges}


@app.get("/api/kb/equations")
async def kb_equations(doc: str | None = None, limit: int = 200):
    return get_kb(db).db.kb_get_equations(doc_id=doc, limit=limit)


@app.get("/api/kb/symbols")
async def kb_symbols(doc: str | None = None, limit: int = 200):
    return get_kb(db).db.kb_get_symbols(doc_id=doc, limit=limit)


@app.get("/api/kb/symbols/{symbol_id}/occurrences")
async def kb_symbol_occurrences(symbol_id: str):
    return get_kb(db).db.kb_get_symbol_occurrences(symbol_id)


@app.get("/api/kb/derivations")
async def kb_derivations(doc: str | None = None):
    return get_kb(db).db.kb_get_derivations(doc_id=doc)


@app.get("/api/kb/concepts")
async def kb_concepts(doc: str | None = None):
    return get_kb(db).db.kb_get_concepts(doc_id=doc)


@app.get("/api/kb/stats")
async def kb_stats():
    return get_kb(db).db.kb_count_by_type()


@app.post("/api/kb/enrich")
async def kb_enrich(req: KBEnrichRequest):
    kb = get_kb(db)
    import httpx
    try:
        result = await kb.enrich_section_summaries(
            GATEWAY_URL, MASTER_KEY, model=req.model)
        # Rebuild FTS after enrichment changed content
        kb._rebuild_all_fts()
        return result
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc)[:500])


@app.get("/api/kb/ingestions")
async def kb_ingestions(limit: int = 50):
    return get_kb(db).db.kb_list_ingestions(limit=limit)


@app.get("/api/kb/ingestions/{ingestion_id}")
async def kb_ingestion(ingestion_id: str):
    ing = get_kb(db).db.kb_get_ingestion(ingestion_id)
    if not ing:
        raise HTTPException(404, "ingestion not found")
    return ing


# Static UI. Assets are served directly; all other non-API paths fall back to
# index.html so client-side routing (React Router) works. nginx proxies /agentcyto/ here.
UI_DIR = os.environ.get("AGENCYTO_UI", "/app/ui")
UI_INDEX = os.path.join(UI_DIR, "index.html")


if os.path.isdir(UI_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(UI_DIR, "assets")), name="assets")


class _CaptureEvents:
    """Lets Retriever run outside a chat job: trace/retrieval events are kept in memory and
    returned to the caller; token usage still lands in the real usage table."""

    def __init__(self, real: DB):
        self.real, self.events = real, []

    def add_event(self, job_id: str, event_type: str, data: dict) -> int:
        self.events.append({"type": event_type, **data})
        return len(self.events)

    def record_usage(self, *args, **kwargs) -> None:
        self.real.record_usage(*args, **kwargs)


class RetrieveRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    docs: list[str] | None = None       # KB document ids; default: every document (of `skills`, if given)
    skills: list[str] | None = None     # limit to these skills (KB top-level folders)
    llm: bool = True                    # LLM planning + rerank (agentcyto's default)
    web: bool = False
    history: list[dict] | None = None   # optional prior turns [{role, content}] for follow-ups


@app.post("/api/retrieve")
async def retrieve(req: RetrieveRequest):
    """Stateless retrieval: the same pipeline chat uses (retrieval.py), without a session.
    Returns the prompt-ready context block plus structured passages."""
    kb = get_kb(db)
    known = [d["id"] for d in kb.db.kb_list_documents()]
    if req.skills:
        in_skills = set(kb.db.kb_doc_ids_for_skills(req.skills))
        known = [d for d in known if d in in_skills]
    doc_ids = [d for d in (req.docs or known) if d in known]
    history = [{"role": m["role"], "content": m["content"][:4000]} for m in (req.history or [])
               if isinstance(m, dict) and m.get("role") in ("user", "assistant")
               and isinstance(m.get("content"), str)][-8:]
    history.append({"role": "user", "content": req.query})
    rid = "rtv-" + uuid.uuid4().hex[:16]
    cap = _CaptureEvents(db)
    r = Retriever(db=cap, kb=kb, job_id=rid, session_id="api:retrieve", gateway_url=GATEWAY_URL,
                  master_key=MASTER_KEY, cfg=modes.get("retrieval") or {}, llm=req.llm, web=req.web,
                  price=lambda m, u: estimate_cost(m, u))
    ctx, info = await r.run(doc_ids, history)
    info = info or {}
    return {"id": rid, "context": ctx, "method": info.get("method"), "passages": info.get("hits", []),
            "queries": info.get("queries", []), "docs": doc_ids, "skills": req.skills or [],
            "trace": [e for e in cap.events if e["type"] == "trace"]}


@app.get("/favicon.svg")
async def favicon():
    return FileResponse(os.path.join(UI_DIR, "favicon.svg"))


@app.get("/icons.svg")
async def icons():
    return FileResponse(os.path.join(UI_DIR, "icons.svg"))


@app.get("/{full_path:path}")
async def spa_fallback(request: Request, full_path: str):
    """Serve index.html for any non-API path so client-side routing works."""
    if full_path.startswith("api/"):
        raise HTTPException(404, "Not Found")
    if os.path.isfile(UI_INDEX):
        return FileResponse(UI_INDEX)
    raise HTTPException(404, "UI not built")
