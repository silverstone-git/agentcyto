# Architecture, host and data stores

Runtime topology, host facts, containers/volumes, persisted data and the public deployment path.

> Section numbers (§N) are preserved from the former monolithic `AGENTS.md` so older references still resolve.

## 3. Runtime topology

```
Browser ── basic auth (AUTHKEY) ──▶ nginx /agentcyto/
        │                              │
        │                              ├── static UI (served by BFF at /)
        │                              ▼
        │                         BFF 127.0.0.1:8890
        │                         - SQLite journal + durable jobs + SSE replay
        │                         - X-Agentcyto-Session: <hex-session-id>
        │                         - workspace /workspaces/<hex-session-id>
        ▼
OpenCode / curl ──────────────────▶ LiteLLM proxy (cli-gateway-gateway-1)
                                    127.0.0.1:4000 ── /health/liveliness
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
                    └── agent → cwd /workspaces/<session-id>, tools on
```

Request flow for a CLI model:
1. LiteLLM receives `/v1/chat/completions` with a `model` name from `config.yaml`; the BFF also sends `X-Agentcyto-Session: <hex-id>`.
2. `cli_provider.CLIProvider` extracts that header from `kwargs["litellm_params"]["metadata"]["headers"]` (verified on LiteLLM 1.110.1 — the top-level `headers` kwarg is empty) and delegates to `run_turn(model, messages, session)`.
3. `split_messages()` normalises roles/text; system messages are dropped by default (`CLI_SYSTEM_PROMPT=drop`).
4. `history_key()` hashes `(session, scope, prior_history)`. A hit resumes the native CLI session; a miss replays prior turns as a transcript. Without a header the original two-field key is kept, so OpenCode conversations still resume.
5. `run_cli()` spawns the CLI under a global semaphore (`CLI_MAX_PARALLEL=2`) with a `CLI_TIMEOUT_SECONDS=900` deadline.
6. Provider output is parsed into streamed deltas + one final `Result` (text, session id, tokens, error).
7. On success, `SessionStore.put()` records `hash(history + our reply) → native session id` in `/state/sessions.db`, with `scope = "<session>|<tool|role|model>"` so `DELETE /api/sessions/{id}` can clear it.

---

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
| BFF port | `127.0.0.1:8890` (live) |
| Domain | `t.aryan.cfd`, `www.t.aryan.cfd` (Cloudflare-proxied nginx) |
| Cloudflare rule | user deployed: `http.request.full_uri wildcard r"https://t.aryan.cfd/agentcyto/*"` → Bypass |

A `cloudflared` quick tunnel on `127.0.0.1:8090` exists but is unrelated to this domain. Ignore it.

CLI versions:
| CLI | Host | Container image | Notes |
|---|---|---|---|
| `claude` | 2.1.328 | 2.1.329 | installed from `https://claude.ai/install.sh` |
| `agy` | 1.5.13 | 1.5.13 | installed from `https://antigravity.google/cli/install.sh`; free tier |
| `muse` | 1.4.24-R9131.1 | same (launcher + downloaded binary) | Meta Muse Code |
| `brev` | v0.6.337 | not installed | GPU instance manager, **not** an LLM provider; see §16 |

LiteLLM version: pinned `1.110.1` (`litellm[proxy]`).

---

---

## 6. Container and volume layout

`docker-compose.yml` defines two services:

| Service | Purpose | Network | Notes |
|---|---|---|---|
| `gateway` | long-running LiteLLM proxy | `127.0.0.1:4000` | `restart: unless-stopped`, healthcheck every 30 s, `mem_limit: 2g` |
| `bff` | FastAPI BFF + static UI | `127.0.0.1:8890` | `restart: unless-stopped`, healthcheck, uid 1001, mounts `../agentcyto/state:/state`, `gateway-state:/gateway-state`, workspaces, plus `../repo:/kb-source` read-write (KB source of truth, one folder per skill; host folder must be writable by uid 1001). Env `OUTSIE_URL` for the admin gate |
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

---

## 10. Data stores

| Store | Location | Contents | Notes |
|---|---|---|---|
| CLI session map | `gateway-state:/state/sessions.db` | hash → native session id | survives container restarts; clear via `scripts/sessions.sh clear` |
| KB tables | `agentcyto/state/agentcyto.db` → `/state` in `bff` | `kb_*` tables incl. FTS5 | survives BFF restarts; git-ignored |
| Muse session logs | `/home/app/.config/muse` (host `secrets/cli-state/muse`) | Muse sessions, settings, trust | do not delete if resume is needed |
| Claude auth/session | `/home/app/.claude` | OAuth credentials, projects, history | only essential files staged from host; container grows its own `projects/` |
| AGY state | `/home/app/.gemini`, `~/.config/antigravity`, `~/.cache/antigravity` | OAuth, conversations, history | multiple dirs required |
| Agent workspaces | `./workspaces/<id>/` | files edited by agent models | one dir per conversation; TTL cleanup not implemented yet |
| Muse binary | `./secrets/cli-state/muse-bin/` | launcher + 417 MB binary | large; include in backup planning |
| BFF DB | `agentcyto/state/agentcyto.db` (host) → `/state` in `bff` | sessions, messages, jobs, job_events, usage, health | WAL mode; git-ignored; survives BFF restarts |
| BFF session-map access | `gateway-state:/gateway-state` in `bff` | read/write access to `sessions.db` | only used by `DELETE /api/sessions/{id}` |

---

---

## 14. Deployment topology (live, see MASTER_PLAN Phases 2–5)

Do not expose the gateway directly. Current path:

```
Browser
  │ basic auth with AUTHKEY
nginx  ── static UI at /agentcyto/assets/
  │      API at /agentcyto/api/*  (no-cache, SSE, 900s timeouts)
BFF (127.0.0.1:8890)
  │ injects LITELLM_MASTER_KEY, owns sessions/jobs/budget
LiteLLM gateway (127.0.0.1:4000)
```

nginx changes applied before `location /` in `/etc/nginx/sites-available/t.aryan.cfd` (backup `.bak-agentcyto`):
- `location = /agentcyto { return 301 /agentcyto/; }`
- `location /agentcyto/ { auth_basic …; proxy_pass http://127.0.0.1:8890/; proxy_buffering off; proxy_read_timeout 900s; add_header Cache-Control "no-store" always; }`
- Static UI is served by the BFF at `/` (React SPA with a catch-all fallback to `index.html`; assets under `/assets/`, built with Vite `base=/agentcyto/`), so no `alias` location is needed.
- `apache2-utils` installed; htpasswd generated from `AUTHKEY` via `agentcyto/scripts/deploy.sh` (never echoes it).
- `nginx -t && systemctl reload nginx`.

Existing nginx routes (`/p/`, `/admin`, `/cytogame/`) were left untouched; `/p/` and `/cytogame/` re-verified at 200.

---
