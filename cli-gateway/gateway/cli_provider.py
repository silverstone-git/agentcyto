"""LiteLLM custom provider: logged-in coding CLIs as chat models.

Model strings (litellm_params.model in config.yaml):

    cli/<tool>[-agent][@<cli-model>]

    cli/claude           Claude Code, all tools off -> pure chat model
    cli/claude-agent     Claude Code with its own tools, working in /workspace/<conversation>
    cli/claude@opus      same, passing `--model opus` to the CLI
    cli/agy              Antigravity CLI in an empty sandboxed dir
    cli/agy-agent@<slug> Antigravity with its tools in /workspace/<conversation>
    cli/muse             Muse Code headless (--preset empty, JSONL events)
    cli/muse-agent       Muse Code with tools in /workspace/<conversation>

Conversations
-------------
OpenAI-style clients resend the whole history on every turn. Each finished
turn is stored as  hash(history incl. our reply) -> CLI session id.  On the next
request, the history minus the newest message is hashed; on a hit the CLI
session is resumed (`claude --resume`, `agy --conversation`) and only the
newest message is sent. On a miss (edited history, new chat, wiped state) the
earlier turns are replayed as a transcript into a fresh session.

The CLI never sees the client's tool definitions. Chat models answer in text;
agent models act on /workspace themselves and report back in text.
"""


import asyncio
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Iterator

from litellm import CustomLLM
from litellm.llms.custom_llm import CustomLLMError
from litellm.types.utils import GenericStreamingChunk, ModelResponse, Usage

STATE_DIR = os.environ.get("CLI_STATE_DIR", "/state")
SCRATCH_DIR = os.environ.get("CLI_SCRATCH_DIR", "/scratch")
WORKSPACE_DIR = os.environ.get("CLI_WORKSPACE_DIR", "/workspace")
TIMEOUT = float(os.environ.get("CLI_TIMEOUT_SECONDS", "900"))
MAX_PARALLEL = int(os.environ.get("CLI_MAX_PARALLEL", "2"))
SYSTEM_MODE = os.environ.get("CLI_SYSTEM_PROMPT", "drop").lower()  # drop | append
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
AGY_BIN = os.environ.get("AGY_BIN", "agy")
MUSE_BIN = os.environ.get("MUSE_BIN", "muse")

# Browser sessions injected by the BFF as an upstream request header. LiteLLM
# exposes inbound headers under litellm_params.metadata.headers for custom
# providers (verified on 1.110.1); the top-level `headers` kwarg is empty.
SESSION_HEADER = "x-agentcyto-session"
SESSION_RE = re.compile(r"^[0-9a-fA-F]{16,64}$")

# Linux caps one argv string at 128 KiB; bigger prompts go through stdin.
ARGV_PROMPT_LIMIT = 100_000
SYSTEM_PROMPT_LIMIT = 60_000
STDOUT_LINE_LIMIT = 32 * 1024 * 1024

_MODEL_RE = re.compile(r"^(?P<tool>claude|agy|muse)(?P<agent>-agent)?(?:@(?P<cli_model>[\w.\-:/]+))?$")


# --------------------------------------------------------------------------- #
# Request spec and message handling
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Spec:
    tool: str            # "claude" | "agy"
    agent: bool          # tools on, cwd=/workspace
    cli_model: str | None

    @property
    def cwd(self) -> str:
        return WORKSPACE_DIR if self.agent else SCRATCH_DIR

    @property
    def scope(self) -> str:
        return f"{self.tool}|{'agent' if self.agent else 'chat'}|{self.cli_model or ''}"


def parse_model(model: str) -> Spec:
    name = model.split("/", 1)[1] if model.startswith("cli/") else model
    m = _MODEL_RE.match(name)
    if not m:
        raise CustomLLMError(
            status_code=400,
            message=f"unknown CLI model '{model}'; expected cli/<claude|agy>[-agent][@model]",
        )
    return Spec(m["tool"], bool(m["agent"]), m["cli_model"])


def _text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                if p.get("type") == "text" or "text" in p:
                    parts.append(str(p.get("text", "")))
                elif p.get("type") in ("image_url", "image", "input_image"):
                    parts.append("[image omitted]")
        return "\n".join(parts)
    return str(content)


def _norm(msg: dict) -> tuple[str, str]:
    """Role + text form used for hashing and transcripts."""
    role = msg.get("role", "user")
    text = _text(msg.get("content"))
    if role == "assistant" and msg.get("tool_calls"):
        calls = []
        for c in msg["tool_calls"]:
            fn = (c.get("function") or {}) if isinstance(c, dict) else {}
            calls.append(f"[called {fn.get('name', '?')}({fn.get('arguments', '')})]")
        text = (text + "\n" + "\n".join(calls)).strip()
    if role in ("tool", "function"):
        role, text = "user", f"[tool result {msg.get('name') or msg.get('tool_call_id') or ''}]\n{text}"
    return role, text.strip()


def split_messages(messages: list[dict]) -> tuple[str, list[tuple[str, str]]]:
    system = "\n\n".join(_text(m.get("content")) for m in messages if m.get("role") in ("system", "developer"))
    convo = [_norm(m) for m in messages if m.get("role") not in ("system", "developer")]
    convo = [t for t in convo if t[1]]
    if not convo:
        raise CustomLLMError(status_code=400, message="no user message to send")
    return system.strip(), convo


def browser_session(kwargs: dict) -> str | None:
    """Extract and validate the BFF's session id from LiteLLM handler kwargs.

    Returns None for OpenCode/direct callers (backward compatible). Invalid
    values are ignored rather than rejected: they must never reach a path or a
    session hash.
    """
    lp = kwargs.get("litellm_params") or {}
    sources = [kwargs.get("headers"), kwargs.get("metadata"), lp.get("metadata"),
               lp.get("litellm_metadata")]
    for src in sources:
        if not isinstance(src, dict):
            continue
        headers = src.get("headers") if src.get("headers") is not None else src
        if not isinstance(headers, dict):
            continue
        value = headers.get(SESSION_HEADER) or headers.get("X-Agentcyto-Session")
        if isinstance(value, str) and SESSION_RE.fullmatch(value):
            return value
    return None


def history_key(spec: Spec, convo: list[tuple[str, str]], session: str | None = None) -> str:
    # Session is part of the hash: two browser sessions with identical text can
    # never resume each other's native CLI session. Absent session keeps the
    # original key so OpenCode's existing conversations keep working.
    blob = json.dumps([session or "", spec.scope, convo], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def transcript_prompt(history: list[tuple[str, str]], latest: str) -> str:
    lines = [
        "You are continuing a conversation that started elsewhere. Earlier turns:",
        "",
    ]
    for role, text in history:
        lines.append(f'<turn role="{role}">\n{text}\n</turn>')
    lines += ["", "Reply to the newest message:", "", latest]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Session store (sqlite on the state volume)
# --------------------------------------------------------------------------- #

class SessionStore:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS sessions ("
            " key TEXT PRIMARY KEY, scope TEXT, session_id TEXT, turns INTEGER, updated REAL)"
        )
        self._db.commit()

    def get(self, key: str) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT session_id FROM sessions WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def put(self, key: str, scope: str, session_id: str, turns: int) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?)",
                (key, scope, session_id, turns, time.time()),
            )
            self._db.commit()


_store: SessionStore | None = None


def store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore(os.path.join(STATE_DIR, "sessions.db"))
    return _store


# --------------------------------------------------------------------------- #
# Running the CLIs
# --------------------------------------------------------------------------- #

@dataclass
class Result:
    text: str = ""
    session_id: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    error: str | None = None


def _status_for(msg: str) -> int:
    low = msg.lower()
    if any(s in low for s in ("rate limit", "usage limit", "429", "quota", "resource_exhausted", "credit",
                              "allowance", "insufficient", "billing", "payment")):
        return 429
    if any(s in low for s in ("authenticat", "not logged in", "/login", "oauth", "unauthorized",
                              "invalid api key", "401", "403", "device authorization")):
        return 401
    if "timed out" in low:
        return 408
    return 500


def build_command(spec: Spec, prompt: str, system: str, session_id: str | None,
                  cwd: str) -> tuple[list[str], str | None, str | None]:
    """Return (argv, stdin_text, cleanup_path)."""
    if spec.tool == "claude":
        argv = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        if session_id:
            argv += ["--resume", session_id]
        if spec.cli_model:
            argv += ["--model", spec.cli_model]
        if spec.agent:
            argv += ["--dangerously-skip-permissions"]
        else:
            argv += ["--tools", "", "--disable-slash-commands"]
        if system and SYSTEM_MODE == "append":
            argv += ["--append-system-prompt", system[:SYSTEM_PROMPT_LIMIT]]
        return argv, prompt, None  # prompt always via stdin

    if spec.tool == "muse":
        os.makedirs(SCRATCH_DIR, exist_ok=True)
        if system and SYSTEM_MODE == "append" and not session_id:
            prompt = f"<instructions>\n{system[:SYSTEM_PROMPT_LIMIT]}\n</instructions>\n\n{prompt}"
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=SCRATCH_DIR, prefix="muse-prompt-", suffix=".txt", delete=False
        ) as f:
            f.write(prompt)
            prompt_path = f.name
        argv = [MUSE_BIN, "exec", "--json", "--prompt-file", prompt_path,
                "--session-id", session_id or str(uuid.uuid4())]
        if spec.cli_model:
            argv += ["--model", spec.cli_model]
        if spec.agent:
            argv += ["--workspace", cwd, "--yolo"]
        else:
            argv += ["--preset", "empty"]
        return argv, None, prompt_path

    # agy
    argv = [AGY_BIN, "--output-format", "json"]
    if session_id:
        argv += ["--conversation", session_id]
    if spec.cli_model:
        argv += ["--model", spec.cli_model]
    argv += ["--dangerously-skip-permissions"] if spec.agent else ["--sandbox"]
    if TIMEOUT > 0:
        argv += ["--print-timeout", f"{int(TIMEOUT)}s"]
    if system and SYSTEM_MODE == "append" and not session_id:
        prompt = f"<instructions>\n{system[:SYSTEM_PROMPT_LIMIT]}\n</instructions>\n\n{prompt}"
    if len(prompt.encode()) <= ARGV_PROMPT_LIMIT:
        return argv + ["-p", prompt], None, None  # -p must be last: it takes the next arg
    return argv, prompt, None  # non-TTY stdin runs agy non-interactively


def _last_json(raw: str) -> dict:
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    for line in reversed(raw.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return {}


def _usage_from(u: dict | None) -> tuple[int, int]:
    u = u or {}
    prompt = int(u.get("input_tokens") or 0) + int(u.get("cache_read_input_tokens") or u.get("cache_read_tokens") or 0) \
        + int(u.get("cache_creation_input_tokens") or 0)
    return prompt, int(u.get("output_tokens") or 0)


def _muse_usage(payload: dict) -> tuple[int, int]:
    prompt = completion = 0
    for m in payload.get("models") or []:
        prompt += int(m.get("input_tokens") or 0) + int(m.get("cached_tokens") or 0) \
            + int(m.get("reasoning_tokens") or 0)
        completion += int(m.get("output_tokens") or 0)
    return prompt, completion


_sem: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(MAX_PARALLEL)
    return _sem


async def run_cli(spec: Spec, prompt: str, system: str, session_id: str | None,
                  workspace_id: str | None = None) -> AsyncIterator[str | Result]:
    """Yield text deltas (str) as they arrive, then one final Result."""
    if spec.tool == "muse" and not session_id:
        session_id = str(uuid.uuid4())
    cwd = os.path.join(WORKSPACE_DIR, workspace_id) if (spec.agent and workspace_id) else spec.cwd
    os.makedirs(cwd, exist_ok=True)
    argv, stdin_text, cleanup_path = build_command(spec, prompt, system, session_id, cwd)
    try:
        async with _semaphore():
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=cwd,
                    stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=STDOUT_LINE_LIMIT,
                )
            except FileNotFoundError:
                yield Result(error=f"{argv[0]} is not installed in the gateway image")
                return

            if stdin_text is not None:
                proc.stdin.write(stdin_text.encode())
                await proc.stdin.drain()
                proc.stdin.close()

            stderr_task = asyncio.create_task(proc.stderr.read())
            deadline = time.monotonic() + TIMEOUT if TIMEOUT > 0 else None
            res = Result()
            streamed: list[str] = []
            raw_lines: list[str] = []
            try:
                while True:
                    remaining = None if deadline is None else max(0.1, deadline - time.monotonic())
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
                    if not line:
                        break
                    s = line.decode(errors="replace").strip()
                    if not s:
                        continue

                    if spec.tool == "muse":
                        try:
                            ev = json.loads(s)
                        except json.JSONDecodeError:
                            raw_lines.append(s)
                            continue
                        pt = ev.get("payload_type") or ""
                        payload = ev.get("payload") or {}
                        if pt == "run.output.delta":
                            t = payload.get("text") or ""
                            if t:
                                streamed.append(t)
                                yield t
                        elif pt == "run.terminal.completed":
                            res.session_id = session_id or (ev.get("stream") or {}).get("id")
                            res.text = payload.get("text") or ""
                            terminal = payload.get("terminal")
                            if terminal and terminal != "completed":
                                res.error = payload.get("reason") or f"muse terminal {terminal}"
                        elif pt == "run.usage":
                            res.prompt_tokens, res.completion_tokens = _muse_usage(payload)
                        elif "fail" in pt or "error" in pt or "cancel" in pt:
                            res.error = str(payload.get("reason") or payload.get("error") or pt)
                        continue

                    if spec.tool != "claude":
                        raw_lines.append(s)
                        continue
                    try:
                        ev = json.loads(s)
                    except json.JSONDecodeError:
                        continue
                    kind = ev.get("type")
                    if kind == "system" and ev.get("session_id"):
                        res.session_id = ev["session_id"]
                    elif kind == "stream_event":
                        e = ev.get("event") or {}
                        d = e.get("delta") or {}
                        cb = e.get("content_block") or {}
                        if e.get("type") == "content_block_start" and cb.get("type") == "text" and streamed:
                            streamed.append("\n\n")
                            yield "\n\n"
                        elif e.get("type") == "content_block_delta" and d.get("type") == "text_delta" and d.get("text"):
                            streamed.append(d["text"])
                            yield d["text"]
                    elif kind == "result":
                        res.session_id = ev.get("session_id") or res.session_id
                        res.text = ev.get("result") or ""
                        res.prompt_tokens, res.completion_tokens = _usage_from(ev.get("usage"))
                        if ev.get("is_error") or (ev.get("subtype") not in (None, "success")):
                            res.error = res.text or ev.get("subtype") or "claude reported an error"
                await asyncio.wait_for(proc.wait(), timeout=30)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                res.error = f"{spec.tool} timed out after {int(TIMEOUT)}s"
            stderr = (await stderr_task).decode(errors="replace").strip()

            if spec.tool == "agy":
                env = _last_json("\n".join(raw_lines))
                res.session_id = env.get("conversation_id")
                res.text = env.get("response") or ""
                res.prompt_tokens, res.completion_tokens = _usage_from(env.get("usage"))
                status = env.get("status")
                if env.get("error") or (status and status != "SUCCESS"):
                    res.error = str(env.get("error") or f"agy status {status}")
                if not env and not res.error:
                    res.error = stderr or "\n".join(raw_lines)[-2000:] or "agy produced no output"
            if streamed and not res.error:
                # The client saw the streamed text; keep the stored view identical so
                # the next turn's history hash matches.
                res.text = "".join(streamed)

            if not res.error and proc.returncode not in (0, None):
                res.error = stderr[-2000:] or f"{spec.tool} exited with code {proc.returncode}"
            if not res.error and not res.text:
                res.error = stderr[-2000:] or f"{spec.tool} returned an empty reply"
            yield res
    finally:
        if cleanup_path:
            try:
                os.unlink(cleanup_path)
            except OSError:
                pass


# --------------------------------------------------------------------------- #
# Turn orchestration
# --------------------------------------------------------------------------- #

async def run_turn(model: str, messages: list[dict], session: str | None = None) -> AsyncIterator[str | Result]:
    spec = parse_model(model)
    system, convo = split_messages(messages)
    history, latest = convo[:-1], convo[-1][1]

    session_id = store().get(history_key(spec, history, session)) if history else None
    # Per-conversation workspace for agent models. The BFF supplies a validated
    # browser session id; without one (OpenCode/direct calls) keep the legacy
    # hash of the first user message so existing workspaces stay stable.
    if spec.agent:
        workspace_id = session or hashlib.sha256(
            json.dumps([spec.scope, convo[0][1]], ensure_ascii=False).encode()
        ).hexdigest()[:16]
    else:
        workspace_id = None
    store_scope = f"{session}|{spec.scope}" if session else spec.scope
    if session_id:
        prompt = latest
    elif history:
        prompt = transcript_prompt(history, latest)
    else:
        prompt = latest

    final: Result | None = None
    emitted = False
    async for item in run_cli(spec, prompt, system, session_id, workspace_id):
        if isinstance(item, Result):
            final = item
        else:
            emitted = True
            yield item

    # Stale session (e.g. CLI state wiped): replay once into a fresh session.
    if final and final.error and session_id and not emitted and _status_for(final.error) not in (429, 401):
        final = None
        async for item in run_cli(spec, transcript_prompt(history, latest), system, None, workspace_id):
            if isinstance(item, Result):
                final = item
            else:
                yield item

    assert final is not None
    if final.error:
        raise CustomLLMError(status_code=_status_for(final.error), message=f"{spec.tool}: {final.error}")
    if final.session_id:
        done = convo + [("assistant", final.text.strip())]
        store().put(history_key(spec, done, session), store_scope, final.session_id, len(done))
    yield final


def _run_sync(agen_factory) -> list:
    """Drive an async generator from sync code (litellm.completion path)."""
    async def collect():
        return [x async for x in agen_factory()]
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(collect())
    out: list = []
    t = threading.Thread(target=lambda: out.extend(asyncio.run(collect())))
    t.start()
    t.join()
    return out


# --------------------------------------------------------------------------- #
# LiteLLM handler
# --------------------------------------------------------------------------- #

class CLIProvider(CustomLLM):
    @staticmethod
    def _fill(model_response: ModelResponse, model: str, res: Result) -> ModelResponse:
        model_response.choices[0].message.content = res.text
        model_response.choices[0].finish_reason = "stop"
        model_response.model = model if model.startswith("cli/") else f"cli/{model}"
        setattr(model_response, "usage", Usage(
            prompt_tokens=res.prompt_tokens,
            completion_tokens=res.completion_tokens,
            total_tokens=res.prompt_tokens + res.completion_tokens,
        ))
        return model_response

    def completion(self, model, messages, api_base, custom_prompt_dict, model_response, print_verbose,
                   encoding, api_key, logging_obj, optional_params, *args, **kwargs) -> ModelResponse:
        items = _run_sync(lambda: run_turn(model, messages, browser_session(kwargs)))
        return self._fill(model_response, model, items[-1])

    async def acompletion(self, model, messages, api_base, custom_prompt_dict, model_response, print_verbose,
                          encoding, api_key, logging_obj, optional_params, *args, **kwargs) -> ModelResponse:
        session = browser_session(kwargs)
        final = None
        async for item in run_turn(model, messages, session):
            if isinstance(item, Result):
                final = item
        return self._fill(model_response, model, final)

    async def astreaming(self, model, messages, api_base, custom_prompt_dict, model_response, print_verbose,
                         encoding, api_key, logging_obj, optional_params, *args, **kwargs
                         ) -> AsyncIterator[GenericStreamingChunk]:
        session = browser_session(kwargs)
        sent = False
        async for item in run_turn(model, messages, session):
            if isinstance(item, Result):
                tail = "" if sent else item.text  # agy (or old claude) never streamed: send it all now
                yield GenericStreamingChunk(
                    text=tail, tool_use=None, is_finished=True, finish_reason="stop", index=0,
                    usage={
                        "prompt_tokens": item.prompt_tokens,
                        "completion_tokens": item.completion_tokens,
                        "total_tokens": item.prompt_tokens + item.completion_tokens,
                    },
                )
            else:
                sent = True
                yield GenericStreamingChunk(
                    text=item, tool_use=None, is_finished=False, finish_reason="", index=0, usage=None,
                )

    def streaming(self, model, messages, api_base, custom_prompt_dict, model_response, print_verbose,
                  encoding, api_key, logging_obj, optional_params, *args, **kwargs
                  ) -> Iterator[GenericStreamingChunk]:
        res = _run_sync(lambda: run_turn(model, messages, browser_session(kwargs)))[-1]
        yield GenericStreamingChunk(
            text=res.text, tool_use=None, is_finished=True, finish_reason="stop", index=0,
            usage={"prompt_tokens": res.prompt_tokens, "completion_tokens": res.completion_tokens,
                   "total_tokens": res.prompt_tokens + res.completion_tokens},
        )


handler = CLIProvider()
