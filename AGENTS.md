# AGENTS.md — agentcyto operational & development guide

This is the authoritative technical guide for any agent or human working in
`/home/ubuntu/cyto/agentcyto`. It describes what exists *now*, why it is shaped
this way, and the exact procedures for changing it safely.

Related documents:
- `MASTER_PLAN.md` — roadmap and acceptance criteria (Phases 0–6).
- `cli-gateway/README.md` — original upstream handout-style overview.
- This file — current implementation details, invariants, and runbooks.

---

## 0. Quick contract

**Do**
- Treat `./.env`, `cli-gateway/secrets/**`, and `cli-gateway/workspace/**` as secret or user data. Never print values.
- Invoke scripts as `bash cli-gateway/scripts/<name>.sh` (they are currently mode `0644`, not executable).
- Validate after every config change: `python3 -m py_compile`, YAML/JSON parse, `docker compose config --quiet`, then `check.sh` and `smoke.sh`.
- Keep the gateway bound to `127.0.0.1:4000`. Public exposure is only through the future BFF + nginx route.
- Preserve per-conversation workspace isolation. Agent models must never share a working directory.

**Don't**
- Don't paste API keys, OAuth tokens, htpasswd hashes, or master keys into chat, logs, commits, or docs.
- Don't add `muse`/`claude`/`agy` credentials to the Docker image; they are runtime mounts only.
- Don't give `*-agent` models an automatic fallback chain. A half-finished edit must not be handed to another model.
- Don't remove `drop_params: true` or the 900 s timeouts without understanding CLI/tool incompatibilities.
- Don't assume the nginx route, BFF, or frontend exists yet — they are planned, not deployed.

---

## 1. Scope and current status

**Date of this document:** 2026-11-20

**Completed locally (Phases 0–1 of `MASTER_PLAN.md`):**
- Root `./.env` holds all provider keys; `cli-gateway/secrets/gateway.env` is generated from it.
- Three CLI logins are staged into `cli-gateway/secrets/cli-state/` and bind-mounted into containers.
- Docker image builds cleanly; gateway is healthy on `127.0.0.1:4000`.
- Muse Code support added to the custom provider; all four CLI families work (`claude`, `agy`, `muse`, plus agent variants).
- Preference aliases `heavy`, `heavy-tool`, `light`, `light-tool` exist with ordered fallback chains.
- Per-conversation agent workspaces under `./workspaces/` are created and isolated.

**Not yet built (Phases 2–6):**
- BFF service with durable jobs, session journal, reconnect/resume, budget guard.
- Static frontend.
- nginx `/agentcyto/` route with `AUTHKEY` basic auth.
- Backups, monitoring, failover drills.

The workspace is **not yet a git repository**. Initialise git before making broad edits so changes are reviewable.

---

## 2. Repository map

```
/home/ubuntu/cyto/agentcyto
├── AGENTS.md                     # this file
├── MASTER_PLAN.md                # roadmap, decisions, acceptance tests
├── .env                          # root secrets (git-ignored, never printed)
├── .gitignore                    # ignores .env, secrets/, *.db, dist/, node_modules/, workspaces/, .claude/
├── workspaces/                   # per-conversation agent working dirs (created at runtime)
│   └── <16-hex-conversation-id>/
│
└── cli-gateway/
    ├── .env                      # non-secret Compose settings (APP_UID, WORKSPACE_DIR, timeouts…)
    ├── .env.example              # template
    ├── .gitignore                # ignores .env, secrets/*, opencode/opencode.json, workspace/*
    ├── Dockerfile                # image build: LiteLLM + Claude CLI + AGY CLI + Muse launcher
    ├── docker-compose.yml        # gateway + on-demand cli tool container, volumes, port mapping
    ├── README.md                 # upstream-style overview + 2026-11-20 additions section
    │
    ├── gateway/
    │   ├── config.yaml           # model_list, litellm_settings, router_settings fallbacks, master key
    │   ├── cli_provider.py       # custom `cli/*` LiteLLM provider (the core integration)
    │   ├── __pycache__/          # generated locally by py_compile; do not edit
    │   └── tools/
    │       ├── check_keys.py     # key lengths + provider HTTP status + model-id presence
    │       ├── smoke.py          # one tiny prompt per model; prints resolved responder
    │       └── sessions.py       # inspect/clear CLI session map
    │
    ├── scripts/
    │   ├── _lib.sh               # shared helpers: root cd, need_secrets, secret(), tool()
    │   ├── check.sh              # runs tools/check_keys.py in the tool container
    │   ├── smoke.sh              # runs tools/smoke.py (optionally with model names)
    │   ├── sessions.sh           # list/clear CLI session map
    │   ├── login.sh              # claude / agy interactive login helpers
    │   └── opencode.sh           # renders opencode/opencode.json with master key file path
    │
    ├── opencode/
    │   ├── opencode.template.json # 22-model provider template with __PORT__/__KEYFILE__ placeholders
    │   └── opencode.json          # generated, git-ignored
    │
    ├── secrets/
    │   ├── gateway.env            # runtime secrets, chmod 600, generated from root .env
    │   ├── gateway.env.example    # template
    │   ├── cli-state/             # staged host CLI credentials, chmod 700, git-ignored
    │   │   ├── claude/            # .credentials.json, settings.json
    │   │   ├── gemini/            # full ~/.gemini (contains antigravity-cli conversations/token)
    │   │   ├── muse/              # full ~/.config/muse (auth.json, settings, trust)
    │   │   ├── antigravity/       # ~/.config/antigravity/credential-user-scope
    │   │   ├── agy-cache/         # ~/.cache/antigravity
    │   │   └── muse-bin/          # Muse launcher + 417 MB self-updating binary
    │   └── opencode.key           # generated by scripts/opencode.sh (not created yet)
    │
    ├── vendor/
    │   └── muse-launcher.sh       # copy of host Muse launcher, baked into image at /opt/muse/bin/muse
    │
    └── workspace/                 # fallback WORKSPACE_DIR if env var is unset
        └── .keep
```

---

## 3. Runtime topology

```
OpenCode / future BFF / curl
        │  Authorization: Bearer <LITELLM_MASTER_KEY>
        ▼
LiteLLM proxy  (container: cli-gateway-gateway-1)
  127.0.0.1:4000  ── /health/liveliness
        │
        ├── nvidia_nim/*  ──▶ integrate.api.nvidia.com   (free tier)
        ├── gemini/*      ──▶ generativelanguage.googleapis.com (2 keys)
        ├── meta/muse-*   ──▶ Meta Model API (META_API_KEY)
        │
        └── cli/* custom provider (cli_provider.py)
              ├── cli/claude[…]   ──▶ claude -p --output-format stream-json
              ├── cli/agy[…]      ──▶ agy --print --output-format json
              └── cli/muse[…]     ──▶ muse exec --json --prompt-file … --session-id …
                    │
                    ├── chat  → cwd /scratch, tools off
                    └── agent → cwd /workspaces/<conversation-id>, tools on
```

Request flow for a CLI model:
1. LiteLLM receives `/v1/chat/completions` with a `model` name from `config.yaml`.
2. `cli_provider.CLIProvider` delegates to `run_turn(model, messages)`.
3. `split_messages()` normalises roles/text; system messages are dropped by default (`CLI_SYSTEM_PROMPT=drop`).
4. `history_key()` hashes `(scope, prior_history)`. A hit resumes the native CLI session; a miss replays prior turns as a transcript.
5. `run_cli()` spawns the CLI under a global semaphore (`CLI_MAX_PARALLEL=2`) with a `CLI_TIMEOUT_SECONDS=900` deadline.
6. Provider output is parsed into streamed deltas + one final `Result` (text, session id, tokens, error).
7. On success, `SessionStore.put()` records `hash(history + our reply) → native session id` in `/state/sessions.db`.

---

## 4. Host environment (verified)

| Item | Value |
|---|---|
| Working directory | `/home/ubuntu/cyto/agentcyto` |
| Host uid | `1001` (why `APP_UID=1001` in `cli-gateway/.env`) |
| Docker | `29.10.0` |
| nginx | installed and active; vhost `/etc/nginx/sites-available/t.aryan.cfd` |
| Certbot | installed; TLS cert for `t.aryan.cfd` already issued and active |
| `htpasswd` | **not installed** (needs `apt-get install apache2-utils` in Phase 5) |
| Python on host | 3.12 |
| Node on host | available via nvm, but frontend is plain static JS (no framework) |
| Ports already used | `8879`, `8080`, `8090`, `22`, `80`, `443` |
| Gateway port | `127.0.0.1:4000` only |
| Future BFF port | planned `127.0.0.1:8890` |
| Domain | `t.aryan.cfd`, `www.t.aryan.cfd` (Cloudflare-proxied nginx) |
| Cloudflare rule | user deployed: `http.request.full_uri wildcard r"https://t.aryan.cfd/agentcyto/*"` → Bypass |

A `cloudflared` quick tunnel on `127.0.0.1:8090` exists but is unrelated to this domain. Ignore it.

CLI versions:
| CLI | Host | Container image | Notes |
|---|---|---|---|
| `claude` | 2.1.328 | 2.1.329 | installed from `https://claude.ai/install.sh` |
| `agy` | 1.5.13 | 1.5.13 | installed from `https://antigravity.google/cli/install.sh`; free tier |
| `muse` | 1.4.24-R9131.1 | same (launcher + downloaded binary) | Meta Muse Code |
| `brev` | v0.6.337 | not installed | GPU instance manager, **not** an LLM provider; see §15 |

LiteLLM version: pinned `1.110.1` (`litellm[proxy]`).

---

## 5. Secrets and credentials

### 5.1 Root `./.env` (names only — never print values)

```
GEMINI_API_KEY
GEMINI_API_KEY_alt
NVIDIA_API_KEY
LITELLM_MASTER_KEY
AUTHKEY
META_API_KEY
```

Comments in the file note the NVIDIA key expires 20 May 2027.

### 5.2 `cli-gateway/secrets/gateway.env` (generated, chmod 600)

| Key | Source | Purpose |
|---|---|---|
| `LITELLM_MASTER_KEY` | root `LITELLM_MASTER_KEY` | client auth to LiteLLM proxy; never expose to browser |
| `NVIDIA_NIM_API_KEY` | root `NVIDIA_API_KEY` | NVIDIA NIM deployments |
| `GEMINI_API_KEY` | root `GEMINI_API_KEY` | primary Gemini quota |
| `GEMINI_API_KEY_ALT` | root `GEMINI_API_KEY_alt` | second Gemini deployment/quota |
| `META_API_KEY` | root `META_API_KEY` | `meta/muse-spark-1.3` and contributor API model |
| `CLAUDE_CODE_OAUTH_TOKEN` | empty | Claude auth is provided by the mounted `~/.claude/.credentials.json` instead |

If you must inspect a value, read it inside a tool container with a script that prints length only. `scripts/check.sh` already does this.

### 5.3 `AUTHKEY`

`AUTHKEY` is the **dashboard password**. Phase 5 will use it as the nginx basic-auth password (username `agentcyto`). It is deliberately *not* in `gateway.env` and never reaches the gateway.

### 5.4 CLI credential staging

All state lives under `cli-gateway/secrets/cli-state/` (git-ignored, mode 700 dirs / 600 files). It is bind-mounted read-write because CLIs persist sessions and tokens there.

| Host source | Container target | Purpose |
|---|---|---|
| `~/.claude/.credentials.json`, `settings.json` | `/home/app/.claude` | Claude OAuth + settings; native session resume |
| `~/.gemini/**` | `/home/app/.gemini` | AGY conversations, OAuth token, history |
| `~/.config/antigravity` | `/home/app/.config/antigravity` | AGY user-scope credential (extra dir; upstream Compose missed it) |
| `~/.cache/antigravity` | `/home/app/.cache/antigravity` | AGY staging cache |
| `~/.config/muse/**` | `/home/app/.config/muse` | Muse `auth.json`, settings, trust state |
| staged launcher + binary | `/opt/muse/bin` | Muse self-updating install dir; must be owned by uid `1001` |

**Important:** `/opt/muse/bin` started as a root-owned Docker named volume and Muse could not install its binary. It is now a host bind mount owned by the app user. Do not revert it to a named volume.

---

## 6. Container and volume layout

`docker-compose.yml` defines two services:

| Service | Purpose | Network | Notes |
|---|---|---|---|
| `gateway` | long-running LiteLLM proxy | `127.0.0.1:4000` | `restart: unless-stopped`, healthcheck every 30 s, `mem_limit: 2g` |
| `cli` | on-demand tool container | none (profile `tools`) | same image/env/volumes; used for `check.sh`, `smoke.sh`, `sessions.sh`, logins |

Shared environment anchor `x-gateway-env`:
```
CLI_STATE_DIR=/state
CLI_SCRATCH_DIR=/scratch
CLI_WORKSPACE_DIR=/workspaces
CLI_TIMEOUT_SECONDS=900
CLI_MAX_PARALLEL=2
CLI_SYSTEM_PROMPT=drop
GATEWAY_URL=http://gateway:4000
```

Shared volumes anchor `x-gateway-volumes`:
```
./gateway:/app:ro
./secrets/cli-state/claude:/home/app/.claude
./secrets/cli-state/gemini:/home/app/.gemini
./secrets/cli-state/muse:/home/app/.config/muse
./secrets/cli-state/antigravity:/home/app/.config/antigravity
./secrets/cli-state/agy-cache:/home/app/.cache/antigravity
./secrets/cli-state/muse-bin:/opt/muse/bin
gateway-state:/state
${WORKSPACE_DIR:-./workspace}:/workspaces
```

`WORKSPACE_DIR` is `/home/ubuntu/cyto/agentcyto/workspaces` in `cli-gateway/.env`.

---

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
workspace_id = sha256(json.dumps([spec.scope, first_user_text])).hexdigest()[:16]
```

Agent `cwd` becomes `/workspaces/<workspace_id>` (host: `./workspaces/<workspace_id>`). This is stable across turns of the same conversation and distinct across different first messages. Observed: three agent smoke tests created three distinct directories.

This is **not yet browser-session-scoped**: a BFF Phase 2 should inject `X-Agentcyto-Session` and include it in both `history_key` and `workspace_id` to eliminate identical-history collisions.

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

## 9. Data stores

| Store | Location | Contents | Notes |
|---|---|---|---|
| CLI session map | `gateway-state:/state/sessions.db` | hash → native session id | survives container restarts; clear via `scripts/sessions.sh clear` |
| Muse session logs | `/home/app/.config/muse` (host `secrets/cli-state/muse`) | Muse sessions, settings, trust | do not delete if resume is needed |
| Claude auth/session | `/home/app/.claude` | OAuth credentials, projects, history | only essential files staged from host; container grows its own `projects/` |
| AGY state | `/home/app/.gemini`, `~/.config/antigravity`, `~/.cache/antigravity` | OAuth, conversations, history | multiple dirs required |
| Agent workspaces | `./workspaces/<id>/` | files edited by agent models | one dir per conversation; TTL cleanup not implemented yet |
| Muse binary | `./secrets/cli-state/muse-bin/` | launcher + 417 MB binary | large; include in backup planning |
| Future BFF DB | planned `agentcyto/state/agentcyto.db` | transcripts, jobs, usage, health | Phase 2; not created yet |

---

## 10. Operations runbook

All commands run from `/home/ubuntu/cyto/agentcyto` unless noted.

### 10.1 Build / start / restart

```sh
docker compose --project-directory cli-gateway build gateway
docker compose --project-directory cli-gateway up -d gateway
docker compose --project-directory cli-gateway restart gateway
docker compose --project-directory cli-gateway up -d --force-recreate gateway   # after volume/mount changes
```

### 10.2 Health and logs

```sh
curl -sS http://127.0.0.1:4000/health/liveliness
docker compose --project-directory cli-gateway ps
docker compose --project-directory cli-gateway logs --tail 100 gateway
```

Expected: `health=200`, container status `healthy`, startup log lists all model aliases.

### 10.3 Checks and smoke tests

```sh
bash cli-gateway/scripts/check.sh
bash cli-gateway/scripts/smoke.sh                 # all non-agent models
bash cli-gateway/scripts/smoke.sh heavy light muse-cli muse-agent claude-agent agy-agent
```

`check.sh` prints key **lengths only**, provider HTTP status, and whether expected model IDs exist.

`smoke.py` prints:
```
<alias>  OK  <seconds>s  via <resolved-model>  'pong'
```
The `via` field is the actual responder after fallbacks. A healthy `heavy` smoke shows `via heavy`, meaning the primary answered.

### 10.4 Session map

```sh
bash cli-gateway/scripts/sessions.sh list
bash cli-gateway/scripts/sessions.sh clear
```

### 10.5 OpenCode config

```sh
bash cli-gateway/scripts/opencode.sh
```
Writes `cli-gateway/secrets/opencode.key` (master key) and `cli-gateway/opencode/opencode.json` from the template. Copy the JSON into a project or merge its `provider` block into `~/.config/opencode/opencode.json`.

### 10.6 Direct API call (without printing the key)

```sh
KEY=$(grep -E '^LITELLM_MASTER_KEY=' cli-gateway/secrets/gateway.env | tail -n1 | cut -d= -f2-)
curl -sS http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"heavy","messages":[{"role":"user","content":"Reply with exactly one word: pong"}]}'
```

Never echo `$KEY`.

### 10.7 Muse binary repair

If Muse reports `installed binary is missing`:

```sh
docker compose --project-directory cli-gateway exec -T gateway \
  bash -c 'export TMPDIR=/tmp; cd /scratch; MUSE_LAUNCHER_INSTALL=1 muse'
```

This writes `muse-bin-<version>` into the host bind mount. Verify ownership stays `app:app` (uid 1001).

---

## 11. Verification after changes

Run all applicable:

```sh
python3 -m py_compile cli-gateway/gateway/cli_provider.py \
  cli-gateway/gateway/tools/*.py
python3 -c 'import yaml; yaml.safe_load(open("cli-gateway/gateway/config.yaml"))'
python3 -c 'import json; json.load(open("cli-gateway/opencode/opencode.template.json"))'
docker compose --project-directory cli-gateway config --quiet
bash cli-gateway/scripts/check.sh
bash cli-gateway/scripts/smoke.sh heavy light muse-cli muse-agent claude-agent agy-agent
```

Expected smoke results from the current build:
```
muse-cli      OK  ~9s   via muse-cli
muse-agent    OK  ~8s   via muse-agent
claude-agent  OK  ~2s   via claude-agent
agy-agent     OK  ~13s  via agy-agent
heavy         OK  ~3s   via heavy
light         OK  ~2s   via light
```

Also confirm workspace isolation after agent tests:
```sh
find workspaces -mindepth 1 -maxdepth 1 -printf '%f\n' | sort
```
Three different agent smoke tests should produce three different IDs.

---

## 12. Security model

| Boundary | Current state |
|---|---|
| Provider keys | Only in root `./.env` and generated `secrets/gateway.env` (chmod 600) |
| Master key | Only in `gateway.env`; injected into LiteLLM; never sent to browser |
| Dashboard password | `AUTHKEY` in root `.env`; Phase 5 nginx basic auth, username `agentcyto` |
| Gateway network | Loopback only (`127.0.0.1:4000`) |
| CLI credentials | Host files bind-mounted at runtime; never in image layers |
| Agent file access | Scoped to `/workspaces/<conversation>`; `--yolo` only inside that dir |
| Cross-session leakage | Hash-based conversation IDs; full browser-session isolation deferred to BFF |
| Free-tier privacy | Gemini free prompts may be used by Google; Muse contributor prompts may be used for training (user approved) |
| Account risk | README warns about AGY/Claude CLI ToS; use disposable accounts |
| Cloudflare | Cache Bypass rule already deployed for `/agentcyto/*`; still add no-store/SSE headers in nginx |
| Logging | Never log request bodies or secret values; `check.sh` prints lengths only |

If a secret is ever exposed in chat or logs, rotate it immediately at the provider and regenerate `secrets/gateway.env` / htpasswd.

---

## 13. Change procedures

### 13.1 Add or change a provider key
1. Add the key to root `./.env` (name only in docs/chat).
2. Regenerate `cli-gateway/secrets/gateway.env` with the correct mapping, `chmod 600`.
3. Update `gateway/tools/check_keys.py` `WANT`/secret list if needed.
4. `docker compose restart gateway`, then `check.sh`.

### 13.2 Add a new model alias
1. Add a `model_list` entry in `gateway/config.yaml`.
2. Add fallback entries in `router_settings.fallbacks` if it participates in a chain.
3. Add expected ID to `check_keys.py` if it is a discoverable provider model.
4. Add entry to `opencode/opencode.template.json`.
5. Update `README.md`, `MASTER_PLAN.md`, and this file.
6. Validate YAML/JSON, restart gateway, run `smoke.sh <new-alias>`.

### 13.3 Change heavy/light ordering
1. Edit only `router_settings.fallbacks` in `gateway/config.yaml` (mode aliases stay the primary).
2. Keep agent variants out of the chains.
3. Restart gateway; run `smoke.sh heavy light` and confirm the `via` field for the primary; optionally break a key to verify fallback.

### 13.4 Add another CLI
1. Install the binary in the Dockerfile or stage it in `vendor/`.
2. Ensure its credential dir is staged under `secrets/cli-state/` and mounted with uid 1001 ownership.
3. Extend `_MODEL_RE`, `Spec`, `build_command()`, and output parsing in `cli_provider.py`.
4. Map its error strings in `_status_for()` so fallback works.
5. Add aliases to `config.yaml`, template, docs; test with `smoke.sh`.

### 13.5 Rotate keys
1. Generate new key at provider.
2. Update root `./.env` and regenerate `secrets/gateway.env`.
3. Recreate containers: `docker compose up -d --force-recreate gateway`.
4. Run `check.sh` and `smoke.sh`.
5. For `AUTHKEY`, regenerate htpasswd in Phase 5.

---

## 14. Deployment plan (pending, see MASTER_PLAN Phases 2–5)

Do not expose the gateway directly. Target path:

```
Browser
  │ basic auth with AUTHKEY
nginx  ── static UI at /agentcyto/assets/
  │      API at /agentcyto/api/*  (no-cache, SSE, 900s timeouts)
BFF (127.0.0.1:8890)
  │ injects LITELLM_MASTER_KEY, owns sessions/jobs/budget
LiteLLM gateway (127.0.0.1:4000)
```

nginx changes required before `location /` in `/etc/nginx/sites-available/t.aryan.cfd`:
- `location = /agentcyto { return 301 /agentcyto/; }`
- `location /agentcyto/ { auth_basic …; proxy_pass http://127.0.0.1:8890/; proxy_buffering off; proxy_read_timeout 900s; add_header Cache-Control "no-store" always; }`
- `htpasswd` must be installed first; generate with `printf '%s' "$AUTHKEY" | htpasswd -i -c /etc/nginx/.htpasswd-agentcyto agentcyto`.
- `nginx -t && systemctl reload nginx`.

Existing nginx routes (`/p/`, `/admin`, `/cytogame/`) must remain untouched.

---

## 15. Known issues, gotchas, troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `muse: command not found` inside `docker exec … bash -lc` | login shell resets `PATH` | use `bash -c`; PATH is `/opt/muse/bin:/home/app/.local/bin:…` |
| `installed binary is missing; rerun the installer` | Muse binary volume empty/root-owned | run `MUSE_LAUNCHER_INSTALL=1 muse`; keep host bind mount owned by uid 1001 |
| `TMPDIR '/tmp' produced … inside workspace` | cwd == TMPDIR | `cd /scratch` and `export TMPDIR=/tmp` |
| NIM `MISSING: nemotron-3-super-120b-a12b` | provider catalog drift | already fixed to `nemotron-3.5-super-vl-120b-a12b`; keep `check_keys.py` current |
| agent writes into another session's files | shared workspace | keep per-conversation `workspace_id`; BFF must add browser session ID |
| mid-stream provider death | tokens already sent | not recoverable by LiteLLM; future BFF marks `partial` and retries from checkpoint |
| CLI model fails and falls back unexpectedly | bad/expired login | check `sessions.sh`, staged credentials, or run `scripts/login.sh` |
| `check.sh` says key EMPTY | wrong key name in `gateway.env` | consult §5.2 mapping |
| scripts say `Permission denied` | scripts are mode 0644 | invoke with `bash …` or `chmod +x` deliberately |
| `muse usage` says `no_allowance` | Muse CLI is not subscription-backed | rely on `META_API_KEY`/contributor credit; measure before promoting in chains |
| `brev` expected as a model | it is GPU infrastructure, not an LLM | see `MASTER_PLAN.md` §7; out of scope for v1 |

Additional caveats:
- Muse binary is ~417 MB in `secrets/cli-state/muse-bin/`; account for this in backups.
- `GEMINI_API_KEY_alt` is assumed to be a separate quota bucket; not yet proven.
- Claude OAuth token env var is intentionally empty; credentials are mounted.
- OpenCode template default is still `gateway/nemotron-super`, not `heavy`/`light`.
- No `git init` yet.

---

## 16. Roadmap ownership

`MASTER_PLAN.md` is the roadmap. Current phase status:

- [x] Phase 0 — secrets, safety, working gateway
- [x] Phase 1 — provider registry, Muse/AGY wiring, heavy/light chains
- [ ] Phase 2 — continuity: session journal, durable jobs, browser-session-scoped workspaces
- [ ] Phase 3 — BFF: auth, mode mapping, budget
- [ ] Phase 4 — static frontend
- [ ] Phase 5 — nginx exposure at `t.aryan.cfd/agentcyto`
- [ ] Phase 6 — ops, backups, drills

When implementing a later phase, update this file in the same change: new services, ports, env keys, routes, data stores, and verification commands belong here.

---

## 17. Appendix — quick reference

### Env key names (values never)

```
Root .env:                 GEMINI_API_KEY, GEMINI_API_KEY_alt, NVIDIA_API_KEY,
                           LITELLM_MASTER_KEY, AUTHKEY, META_API_KEY

gateway.env:               LITELLM_MASTER_KEY, NVIDIA_NIM_API_KEY,
                           GEMINI_API_KEY, GEMINI_API_KEY_ALT,
                           META_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (empty)
```

### Key endpoints

```
GET  http://127.0.0.1:4000/health/liveliness
POST http://127.0.0.1:4000/v1/chat/completions
GET  http://127.0.0.1:4000/v1/models
GET  https://t.aryan.cfd/agentcyto/api/health        (planned)
```

### Critical file paths

```
/home/ubuntu/cyto/agentcyto/.env
/home/ubuntu/cyto/agentcyto/workspaces/<conversation-id>/
/home/ubuntu/cyto/agentcyto/cli-gateway/secrets/gateway.env
/home/ubuntu/cyto/agentcyto/cli-gateway/secrets/cli-state/
/home/ubuntu/cyto/agentcyto/cli-gateway/gateway/config.yaml
/home/ubuntu/cyto/agentcyto/cli-gateway/gateway/cli_provider.py
/etc/nginx/sites-available/t.aryan.cfd               (pending edits)
```

### One-line health check

```sh
docker compose --project-directory cli-gateway ps --status running --services | grep -qx gateway && \
curl -fsS http://127.0.0.1:4000/health/liveliness >/dev/null && echo OK
```
