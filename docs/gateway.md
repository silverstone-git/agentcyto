# LiteLLM gateway: model registry and `cli_provider.py`

Preference aliases, concrete deployments, and the internals of the custom `cli/*` provider.

> Section numbers (§N) are preserved from the former monolithic `AGENTS.md` so older references still resolve.

## 7. Model registry and preference chains

Source: `cli-gateway/gateway/config.yaml`.

### 7.1 Mode aliases (what the UI/BFF should call)

| Alias | Primary deployment | Fallback chain (ordered) |
|---|---|---|
| `heavy` | `cli/claude@opus` | `muse-spark` → `nemotron-ultra` → `claude-cli` → `muse-cli` → `nemotron-super` → `gemini-flash` → `agy-cli` → `gemini-flash-lite` → `nemotron-lightning` |
| `heavy-tool` | `nvidia/nemotron-3-ultra-550b-a55b` | `muse-spark` → `nemotron-super` → `gemini-flash` → `gemini-flash-lite` → `nemotron-bolt` |
| `light` | `nvidia/nemotron-3.5-lightning-30b-a3b` | `gemini-flash-lite` → `gemini-flash` → `nemotron-super` → `muse-cli` → `claude-cli` |
| `light-tool` | `nvidia/nemotron-3.5-lightning-30b-a3b` | `gemini-flash-lite` → `gemini-flash` → `nemotron-super` → `nemotron-bolt` |

Fallbacks fire on errors mapped to 401/429/5xx by the provider or by `cli_provider._status_for()`. Router settings: `num_retries: 2`, `allowed_fails: 1`, `cooldown_time: 60`.

### 7.2 Concrete API deployments

| Alias | Provider model |
|---|---|
| `nemotron-super` | `nvidia_nim/nvidia/nemotron-3.5-super-vl-120b-a12b` |
| `nemotron-ultra` | `nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b` |
| `nemotron-lightning` | `nvidia_nim/nvidia/nemotron-3.5-lightning-30b-a3b` |
| `nemotron-bolt` | `nvidia_nim/nvidia/nemotron-3.5-bolt-e4b` |
| `gemini-flash` | `gemini/gemini-flash-latest` (two deployments: primary + alt key) |
| `gemini-flash-lite` | `gemini/gemini-flash-lite-latest` (two deployments: primary + alt key) |
| `muse-spark` | `meta/muse-spark-1.3` |
| `muse-spark-cheap` | `meta/muse-spark-1.3-contributor` (prompts may be used for training — user approved) |

The old `nemotron-3-super-120b-a12b` ID no longer exists in the NVIDIA catalog; do not reintroduce it. Super-VL and Bolt were both verified to emit real tool calls.

### 7.3 CLI deployments

| Alias | Model string | Behaviour |
|---|---|---|
| `claude-cli` | `cli/claude` | chat, tools off |
| `claude-cli-opus` | `cli/claude@opus` | chat, Opus |
| `claude-agent` | `cli/claude-agent` | tools on, per-conversation workspace |
| `agy-cli` | `cli/agy` | chat, sandboxed empty dir |
| `agy-agent` | `cli/agy-agent` | tools on, per-conversation workspace |
| `muse-cli` | `cli/muse` | chat, `--preset empty` |
| `muse-cli-wonder` | `cli/muse@muse-wonder-1.0` | chat, Muse Wonder |
| `muse-cli-ember` | `cli/muse@muse-ember-1.0` | chat, Muse Ember |
| `muse-agent` | `cli/muse-agent` | tools on, `--yolo`, per-conversation workspace |
| `muse-agent-contributor` | `cli/muse-agent@muse-spark-1.3-contributor` | contributor-tier agent |

**Agent variants intentionally have no fallback entry.** If one fails, the job should be `blocked` and the caller must decide; never silently continue in another agent.

### 7.4 LiteLLM settings

```yaml
litellm_settings:
  drop_params: true
  request_timeout: 900
  custom_provider_map:
    - {"provider": "cli", "custom_handler": cli_provider.handler}

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

`drop_params: true` is required because CLI models cannot consume OpenCode's tool schemas; without it, requests fail instead of degrading to text.

---

---

## 8. `cli_provider.py` internals

File: `cli-gateway/gateway/cli_provider.py`. This is the most delicate code in the repo.

### 8.1 Constants and environment

```
STATE_DIR=/state            CLI_SCRATCH_DIR=/scratch      CLI_WORKSPACE_DIR=/workspaces
TIMEOUT=900                 MAX_PARALLEL=2                SYSTEM_MODE=drop
CLAUDE_BIN=claude           AGY_BIN=agy                   MUSE_BIN=muse
ARGV_PROMPT_LIMIT=100000    SYSTEM_PROMPT_LIMIT=60000     STDOUT_LINE_LIMIT=32 MiB
```

`ARGV_PROMPT_LIMIT` exists because Linux caps a single argv string at 128 KiB. AGY uses stdin for large prompts; Muse uses `--prompt-file`.

### 8.2 Model parsing

```
_MODEL_RE = ^(claude|agy|muse)(-agent)?(@<cli-model>)?$
```

`parse_model("cli/muse-agent@muse-spark-1.3-contributor")` returns:
```
Spec(tool="muse", agent=True, cli_model="muse-spark-1.3-contributor")
```

`Spec.scope` is `"<tool>|agent|model"` and is part of the session hash.

### 8.3 Message normalization

- `_text()` flattens string/list content parts; image parts become `[image omitted]`.
- `_norm()` converts roles: `tool`/`function` messages become `user` with a `[tool result …]` prefix; assistant tool calls are appended as `[called fn(args)]`.
- `split_messages()` extracts system/developer text, drops it from the conversation by default, and returns `(system, convo)`.
- `transcript_prompt()` wraps earlier turns in `<turn role="…">` tags for replay into a fresh CLI session.

### 8.4 Session store

`SessionStore` is a SQLite database at `/state/sessions.db` (named volume `gateway-state`):

```sql
CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY,
  scope TEXT,
  session_id TEXT,
  turns INTEGER,
  updated REAL
)
```

- `history_key(spec, convo)` = SHA-256 of `[spec.scope, convo]` with compact JSON.
- On a turn, the gateway looks up `history_key(spec, prior_history)`. A hit resumes the native CLI session with only the newest message. A miss replays the transcript.
- After success, it stores `history_key(spec, convo + [assistant reply]) → native session id`.
- `scripts/sessions.sh list|clear` inspects/resets this map. Clearing it causes the next turn of each chat to replay its history into a fresh CLI session.

### 8.5 Per-conversation agent workspace

`run_turn()` derives:

```python
workspace_id = session or sha256(json.dumps([spec.scope, first_user_text])).hexdigest()[:16]
```

When the BFF sends `X-Agentcyto-Session`, the agent `cwd` is `/workspaces/<hex-session-id>`; the BFF creates that directory first (0700, uid 1001) with a hex-only allow-list, so no two sessions share files and traversal is impossible. Without the header (OpenCode/direct calls), the legacy first-message hash is used, keeping earlier workspaces stable. Observed: three early smoke tests created three distinct hashed directories; two identical-text BFF sessions created two distinct session-named directories.

The session id is also part of `history_key()` and is stored as the prefix of `scope` in `sessions.db`, so clearing a browser session can drop its native CLI session map.

### 8.6 Command construction — `build_command()`

Returns `(argv, stdin_text, cleanup_path)`.

**Claude**
```
claude -p --output-format stream-json --verbose --include-partial-messages
  [--resume <id>] [--model <cli_model>]
  [--dangerously-skip-permissions | --tools "" --disable-slash-commands]
  [--append-system-prompt <system>]     # only if CLI_SYSTEM_PROMPT=append
```
Prompt is always written to stdin. Final session id comes from `system.session_id` or `result.session_id` events.

**AGY**
```
agy --output-format json
  [--conversation <id>] [--model <cli_model>]
  [--dangerously-skip-permissions | --sandbox]
  [--print-timeout 900s]
  -p <prompt>          # if <= 100 KB, argv must be last
```
Large prompts go via stdin. Final JSON is parsed for `conversation_id`, `response`, `usage`, `status`, `error`.

**Muse**
```
muse exec --json --prompt-file <temp> --session-id <uuid>
  [--model <cli_model>]
  [--preset empty                                  # chat
   | --workspace /workspaces/<id> --yolo]          # agent
```
Temp prompt files are created in `/scratch`, removed in a `finally` block. `TMPDIR` must not equal the workspace root or Muse refuses to start ("tool-output root inside workspace"). When debugging inside the container use `bash -c`, not `bash -lc`: a login shell resets `PATH` and hides `/opt/muse/bin`.

Muse session logging is left enabled (do not pass `--no-session-log`) so resume and listing work.

### 8.7 Output parsing

**Claude** — newline-delimited JSON:
- `type: "system"` → `session_id`
- `type: "stream_event"` → `content_block_delta` text deltas
- `type: "result"` → final text, usage, error flags

**AGY** — one JSON object; parse last JSON-looking line via `_last_json()`.

**Muse** — JSONL event stream. Important `payload_type` values:
| `payload_type` | Handling |
|---|---|
| `run.output.delta` | `payload.text` yielded as a stream delta |
| `run.terminal.completed` | `payload.text` final text; `payload.terminal != "completed"` → error |
| `run.usage` | `payload.models[*]` → `input_tokens + cached_tokens + reasoning_tokens` / `output_tokens` |
| containing `fail`/`error`/`cancel` | error from `payload.reason` or `payload.error` |
| `stream.id` | session id (we prefer our own `--session-id` UUID) |

All other JSONL events are lifecycle noise and ignored. Non-JSON lines are collected for error fallback.

### 8.8 Error → HTTP status mapping (`_status_for`)

- 429: `rate limit`, `usage limit`, `429`, `quota`, `resource_exhausted`, `credit`, `allowance`, `insufficient`, `billing`, `payment`
- 401: `authenticat`, `not logged in`, `/login`, `oauth`, `unauthorized`, `invalid api key`, `401`, `403`, `device authorization`
- 408: `timed out`
- otherwise 500

These codes are what LiteLLM's router uses for fallback decisions.

### 8.9 Concurrency and streaming

- A single `asyncio.Semaphore(MAX_PARALLEL)` throttles all CLI subprocesses.
- `run_cli()` yields `str` chunks as they arrive, then exactly one `Result`.
- `run_turn()` tracks `emitted`; if a stale session fails before any output and the error is not 429/401, it replays once into a fresh session.
- `CLIProvider` implements `completion`, `acompletion`, `streaming`, `astreaming`; `astreaming` emits `GenericStreamingChunk` with usage on the final chunk.
- `_run_sync()` drives the async generator from sync code in a separate thread when an event loop is already running.

---
