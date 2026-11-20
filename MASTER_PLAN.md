# MASTER_PLAN — agentcyto

Status: **Phases 0–5 shipped locally; Phase 6 (ops/backups) pending**
Updated: 2026-11-20

**Progress:** gateway healthy; BFF on `127.0.0.1:8890` with durable jobs, SSE replay and per-session isolation; static UI served by the BFF; nginx basic-auth route live at `https://t.aryan.cfd/agentcyto/`. Still open: provider fallback/quota drills, workspace size cap + TTL, rate limiting, real-browser reconnect test, backups/monitoring. `certbot renew --dry-run` passed.
Scope: turn `cli-gateway/` into a resilient, ordered, multi-provider chat/agent service with a static web UI, exposed at `https://t.aryan.cfd/agentcyto/` behind nginx password auth.

---

## 0. Goal & non-goals

**Goal**
- One chat endpoint that survives a provider dying, rate-limiting, or the client disconnecting.
- Two explicit preference lists — **heavy** (quality-first, paid/quota-backed allowed) and **light** (fast/free-first) — ordered best → worst.
- A static browser UI with a mode switch, visibility into *which model actually answered*, and working agent/CLI models.
- Public reachability at `t.aryan.cfd/agentcyto` with a password, without leaking provider keys to the browser.

**Non-goals (for now)**
- Per-user accounts beyond one shared password.
- Billing per end user; one shared budget is enough.
- Self-hosting a model on Brev GPU (see §7 — optional future phase).
- Building the frontend with a framework: **plain static HTML/CSS/JS confirmed**.

**Confirmed decisions**
- Static UI: **yes**.
- Expose agent CLIs (`claude-agent`, `agy-agent`, and new `muse-agent`) to web users: **yes** — but with mandatory per-session workspace isolation (§2.5, Phase 2).

---

## 1. Verified current state

### 1.1 Files and services

| Item | Location | Notes |
|---|---|---|
| LiteLLM proxy + custom CLI provider | `cli-gateway/gateway/config.yaml`, `cli-gateway/gateway/cli_provider.py` | 11 model aliases, partial fallback chains |
| Compose stack | `cli-gateway/docker-compose.yml` | gateway on `127.0.0.1:4000`; volumes `claude-config`, `agy-config`, `gateway-state`; `cli` tool container |
| Dockerfile | `cli-gateway/Dockerfile` | Python 3.12-slim, LiteLLM `1.110.1`, installs Claude Code + optional Antigravity only |
| Helper scripts | `cli-gateway/scripts/{login,check,smoke,sessions,opencode}.sh` | secret-safe wrappers |
| Tooling | `cli-gateway/gateway/tools/*.py` | key check, smoke test, session-map inspector |
| Secret template | `cli-gateway/secrets/gateway.env.example` | expects `LITELLM_MASTER_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `NVIDIA_NIM_API_KEY`, `GEMINI_API_KEY`, `META_API_KEY` |
| Runtime secrets | `cli-gateway/secrets/gateway.env` | **still missing** (only the example exists) |
| Root env | `./.env` | keys: `GEMINI_API_KEY`, `GEMINI_API_KEY_alt`, `NVIDIA_API_KEY`, `LITELLM_MASTER_KEY`, `AUTHKEY`, `META_API_KEY` |
| nginx vhost | `/etc/nginx/sites-available/t.aryan.cfd` | Certbot TLS active; `/p/`, `/admin`, `/cytogame/`; `location /` → `/p/`. No `/agentcyto` route yet. |
| Docker / nginx / certbot | installed | Docker `29.10.0`, nginx active, cert installed |
| Ports | `8879`, `8080`, `8090`, `4000` free-ish | gateway not running; BFF planned on `127.0.0.1:8890` |

A `cloudflared` quick tunnel on `127.0.0.1:8090` is running but is unrelated to `t.aryan.cfd` (that host is Cloudflare-fronted nginx). Ignore it.

### 1.2 CLIs now installed on the host

| CLI | Version | Role | Headless support | Credential/config state |
|---|---|---|---|---|
| `claude` | 2.1.328 | Claude Code | `-p --output-format stream-json --resume <id>` | `~/.claude` (Compose mounts this) |
| `agy` | 1.5.13 | Antigravity, free tier | `--print --output-format json --conversation <id>` | `~/.gemini/antigravity-cli` (covered by `agy-config` volume) **plus `~/.config/antigravity` and `~/.cache/antigravity` (not mounted)** |
| `muse` | 1.4.24-R9131.1 | Muse Code (Meta) | `muse exec --json --prompt-file — --session-id <uuid>` | `~/.config/muse/auth.json` (**not mounted**) |
| `brev` | v0.6.337 | NVIDIA Brev **GPU instance manager** | n/a | `~/.brev` |

`muse` is a small bash launcher (`~/.local/bin/muse`) that downloads the real binary from `api.meta.ai/muse-code/channels/muse-stable`; its credentials live at `$XDG_CONFIG_HOME/muse/auth.json` or `~/.config/muse/auth.json`. The Dockerfile currently installs neither `muse` nor `brev`, and the Compose volumes cover neither Muse nor the extra AGY dirs — both must be added before containerised CLI calls will work.

`muse usage` currently reports `No subscription allowance (no_allowance)`, so treat Muse CLI as a **credit/contributor-key path**, not a subscription entitlement; verify allowance with the newly added `META_API_KEY` before putting it high in the heavy chain.

### 1.3 Muse CLI integration details (verified by running it)

- `muse exec --list-models` → `muse-wonder-1.0`, `muse-ember-1.0`, `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`.
- `muse exec --json` emits **JSONL** events. Relevant ones:
  - `payload_type: "run.output.delta"` → `payload.text` (streaming chunk)
  - `payload_type: "run.terminal.completed"` → `payload.text`, `payload.terminal`
  - `payload_type: "run.usage"` → token counts
  - `stream: {"kind":"session","id":...}` → session id; we will supply our own via `--session-id <uuid>` and map it to browser sessions.
- Chat mode: `--preset empty` (no workspace tools). Agent mode: `--workspace /workspace` plus explicit approval posture (`--yolo` or `--approval-mode never --disable-sandbox`) — must be scoped to a per-session directory.
- Long prompts go via `--prompt-file` (avoid argv limits), mirroring the existing stdin trick in `cli_provider.py`.
- `muse resume` is interactive TUI; for headless continuity use `muse exec --session-id <same uuid>` and verify context carry-over during implementation.

`agy models` (AGY-internal IDs, distinct from the gateway's `gemini/*` API models): `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.

### 1.4 Conversation continuity today

`cli_provider.py` hashes `scope + full history`; on a hit it resumes the native CLI session (`claude --resume`, `agy --conversation`), otherwise it replays prior turns as a transcript into a fresh session. State lives in `gateway-state:/state/sessions.db`. API-backed models (NVIDIA/Gemini/Meta) are stateless and need the client to resend history every turn.

### 1.5 Current fallback chains

`claude-cli → agy-cli → nemotron-super`, `nemotron-super → gemini-flash → nemotron-lightning`, etc. CLI/agent models have `num_retries: 0`; agent models deliberately have no fallback.

---

## 2. Gaps and risks (priority order)

1. **Runtime secrets still not staged.** Keys now exist in root `./.env`, but `cli-gateway/secrets/gateway.env` does not. LiteLLM would fail to start. Need to map names (`NVIDIA_API_KEY` → `NVIDIA_NIM_API_KEY`; add `GEMINI_API_KEY_ALT`; `META_API_KEY` now populated; `LITELLM_MASTER_KEY` now populated).
2. **Gateway build still untested** (per README). Verify LiteLLM `1.110.1` custom-provider compatibility before building on it.
3. **New CLIs missing from the image and volumes.** Muse and Brev are not installed in the Dockerfile; Muse auth dir and AGY's `~/.config`/`~/.cache` dirs are not mounted. Exposed agent models will silently fail without this.
4. **Dashboard auth boundary is undecided in code.** `AUTHKEY` is intended for dashboard login. Recommend using it directly as the nginx basic-auth password (satisfies "behind nginx with a password", no JS secret handling); a cookie-based login form can be added later. BFF must never see a browser-supplied master key.
5. **Agent models are now approved for exposure, which raises the stakes.** Current `*-agent` models use one fixed `WORKSPACE_DIR`. With one shared password that means shared files. → per-session workspace directories + per-session CLI session IDs are mandatory (Phase 2).
6. **Session-map collisions.** `history_key()` is keyed only by model scope + history, not by browser session/user. → add session ID to the hash scope.
7. **Mid-stream failure is unrecoverable today.** If a provider dies after streaming tokens, fallback cannot un-send them. → job/checkpoint layer (Phase 2) marks such jobs `partial` and retries from checkpoint.
8. **Automatic fallback must not hand off half-finished agent edits.** Agent models will be **selectable explicit choices** in the UI, not members of the automatic heavy/light fallback chains. If an agent dies, its job is `blocked` and the user retries/switch models manually. Chat models keep the automatic chains.
9. **No budget guard.** `muse-spark` is paid; `muse` CLI consumes Meta credit; CLI subscriptions have separate quotas. → daily cap + paid toggle.
10. **No observability/backup.** No per-provider success/latency history, no volume backups.
11. **Model-ID drift.** `check_keys.py` flags missing IDs; re-verify NIM/Gemini/Muse IDs after key changes.
12. **Brev is not an LLM.** Do not treat `brev` as another fallback provider; see §7.
13. **ToS caveats.** README warns about Antigravity/Claude CLI account suspension risk; keep those accounts disposable.

---

## 3. Target architecture

```
Browser (https://t.aryan.cfd/agentcyto/)
   │  basic auth with AUTHKEY (nginx), no secrets in JS
   ▼
nginx  ── static UI (/agentcyto/assets/...) ──► /var/www/agentcyto/
   │  /agentcyto/api/*  (no-cache, SSE-friendly, 900s timeouts)
   ▼
BFF  (127.0.0.1:8890, FastAPI)
   │  - holds LITELLM_MASTER_KEY, never exposed
   │  - AUTHKEY login boundary (nginx basic auth, optional cookie layer)
   │  - modes.yaml: mode → alias mapping + guardrails
   │  - session transcript + durable job queue (SQLite)
   │  - per-session workspace root for agent models
   ▼
LiteLLM gateway (127.0.0.1:4000)
   ├─ "heavy" / "light" → ordered fallback chains (chat models)
   ├─ concrete API aliases (nemotron-*, gemini-*, muse-spark)
   └─ cli_provider.py → claude | agy | muse (chat + agent variants)
        ├─ chat: tools off, scratch cwd, native session resume
        └─ agent: tools on, cwd = /workspaces/<session-id>
```

Why mode aliases live in LiteLLM: ordering stays in one place, works with OpenCode (`gateway/heavy`), and failover happens before a response reaches the BFF. Dynamic per-request fallbacks are an optional later optimisation if LiteLLM `1.110.1` supports them.

---

## 4. Phases

### Phase 0 — Baseline: secrets, safety, working gateway

**Files:** `cli-gateway/secrets/gateway.env`, `./.env`, root `.gitignore`

1. Generate nothing new for LiteLLM — `LITELLM_MASTER_KEY` is already in `./.env`. Stage `cli-gateway/secrets/gateway.env` from the example, mapping root keys: `NVIDIA_API_KEY` → `NVIDIA_NIM_API_KEY`, `GEMINI_API_KEY` → `GEMINI_API_KEY`, `GEMINI_API_KEY_alt` → `GEMINI_API_KEY_ALT`, `META_API_KEY` → `META_API_KEY`, `LITELLM_MASTER_KEY` copied. `chmod 600`. Leave Claude OAuth empty until the CLI login check.
2. Add non-secret settings to root `.env`: `AGENCYTO_BFF_PORT=8890`, `AGENCYTO_BASIC_AUTH_PASSWORD` **sourced from `AUTHKEY`** (do not create a second password), `AGENCYTO_DAILY_BUDGET_USD`.
3. Add a root `.gitignore` (`.env`, `secrets/`, `*.db`, `dist/`, `workspaces/`); initialise git before editing so changes are reviewable.
4. `docker compose build gateway` → `up -d gateway` → `scripts/check.sh` → `scripts/smoke.sh`. Fix LiteLLM custom-provider or model-ID breakage here.

**Exit criteria:** gateway healthy, all configured models return `pong`, no secret values in logs or tracked files.

### Phase 1 — Provider registry, Muse/AGY wiring, ordered preference lists

**Files:** `cli-gateway/gateway/config.yaml`, `cli-gateway/gateway/cli_provider.py`, `cli-gateway/Dockerfile`, `cli-gateway/docker-compose.yml`, `cli-gateway/gateway/tools/{check_keys,smoke}.py`

1. **Image/volumes:** install the Muse CLI launcher in the Dockerfile (pin channel/version); add named volumes for `muse-config` → `/home/app/.config/muse`, `agy-config2` → `/home/app/.config/antigravity`, `agy-cache` → `/home/app/.cache/antigravity`. Keep `claude-config` and `agy-config` as-is. Do **not** bake credentials into the image.
2. **cli_provider:** extend `_MODEL_RE` to `(claude|agy|muse)(-agent)?(@...)?`; add a `build_command` branch for `muse exec --json --prompt-file <tmp> --session-id <uuid>` with `--preset empty` for chat and `--workspace <per-session dir>` + approval overrides for agent; parse JSONL events (`run.output.delta` → stream, `run.terminal.completed` → final text, `run.usage` → tokens, `terminal` → failure); map Muse auth/quota errors to 401/429 so fallback works.
3. **Key rotation:** add a second Gemini deployment under `model_name: gemini-flash` / `gemini-flash-lite` using `GEMINI_API_KEY_ALT` so an exhausted key fails over automatically.
4. **Mode aliases:** add `heavy`, `light`, `heavy-tool`, `light-tool` with `router_settings.fallbacks` chains.

   | Mode | Chain (best → worst) |
   |---|---|
   | `heavy` | `claude-cli-opus` → `muse-spark` → `nemotron-ultra` → `claude-cli` → `muse-cli` → `nemotron-super` → `gemini-flash` → `agy-cli` → `gemini-flash-lite` → `nemotron-lightning` |
   | `heavy-tool` | `nemotron-ultra` → `muse-spark` → `nemotron-super` → `gemini-flash` → `gemini-flash-lite` |
   | `light` | `nemotron-lightning` → `gemini-flash-lite` → `gemini-flash` → `nemotron-super` → `muse-cli` → `claude-cli` |
   | `light-tool` | `nemotron-lightning` → `gemini-flash-lite` → `gemini-flash` → `nemotron-super` |

   `muse-spark` stays in the chain even before we trust Muse credit — failures just advance. CLI chat models are in the chains; **agent variants are not** (§2.8).
5. **Explicit agent aliases:** `claude-agent`, `agy-agent`, `muse-agent` remain selectable concrete models with no automatic cross-model fallback. Add `muse-agent` and a Muse model selector (`@muse-spark-1.3`, `@muse-wonder-1.0`, etc.) to `config.yaml` and the OpenCode template.
6. Tune `num_retries`, `allowed_fails`, `cooldown_time`; keep `drop_params: true`; extend `check_keys.py` for both Gemini keys and Muse IDs; `smoke.py` accepts `heavy`/`light` and prints the resolved responder.

**Exit criteria:** `scripts/smoke.sh heavy light` shows distinct responders; `muse-cli`/`muse-agent` answer through the gateway; invalidating one Gemini key advances to the alt key.

### Phase 2 — Continuity and per-session agent workspaces ✅ shipped

**Files:** `cli-gateway/gateway/cli_provider.py` (patched), `agentcyto/bff/{app.py,db.py,modes.yaml,Dockerfile,requirements.txt}`, `agentcyto/state/`

**Shipped deviation:** the BFF creates and owns the workspace directories directly (hex session ID, 0700, traversal-proof allow-list); the gateway continues to use the supplied ID as `cwd` for agent specs. Workspace size cap and TTL cleanup remain backlog items.

1. Add `X-Agentcyto-Session` to `Spec.scope`/`history_key()` so two browser sessions cannot share CLI sessions. For Muse, use the same UUID as `--session-id`; for AGY/Claude keep their native session IDs in the existing map, keyed by browser session.
2. BFF SQLite (`agentcyto/state/agentcyto.db`): `sessions`, `messages`, `jobs`, `job_events`, `usage`, `health`.
3. `POST /api/chat` → durable job; worker calls gateway with full canonical history and chosen alias; checkpoint after each chunk/step. `GET /api/stream?job_id=...&after=<seq>` (SSE) resumes after tab close/reload. Full-chain failure → `blocked` with backoff; truncated stream → `partial` and retry from checkpoint.
4. **Per-session agent workspace:** mount/create `/workspaces/<session-id>/` at request time (BFF creates dir, passes it to the gateway via header/metadata which `cli_provider` uses as `cwd` for agent specs). Enforce path allow-list (`/workspaces/<uuid>` only), size cap, and TTL cleanup. No two sessions share a workspace. This is what makes exposing agents safe.
5. Session endpoints: list/create/rename/clear; clearing also drops the corresponding CLI session-map entries.

**Exit criteria:** tab closed mid-answer → reconnect continues; container restart → jobs/history survive; two sessions with identical text get different CLI sessions and different workspace dirs; an agent cannot read another session's workspace.

### Phase 3 — BFF: auth, mode mapping, budget ✅ shipped (rate limiting deferred)

**Files:** `agentcyto/bff/{app.py,db.py,modes.yaml,Dockerfile}`, `cli-gateway/docker-compose.yml`

1. FastAPI + uvicorn + httpx on `127.0.0.1:8890`, `env_file: secrets/gateway.env`, volumes for `agentcyto/state` and `/workspaces`; `restart: unless-stopped`.
2. Inject `Authorization: Bearer $LITELLM_MASTER_KEY` upstream. Require nginx's `X-Auth-User` header when behind nginx. `AUTHKEY` is the single dashboard password (nginx basic auth); no second credential store.
3. `modes.yaml`: mode → alias/role mapping, paid-model policy, context/timeouts. Editable without rebuild.
4. Guardrails: per-session/IP rate limit; daily spend counter for `muse-spark`/Muse credit; `ALLOW_PAID` flag (recommended on with cap); CLI subscriptions tracked as quota units.
5. Routes: `/api/health`, `/api/models`, `/api/modes`, `/api/sessions`, `/api/chat`, `/api/stream`, `/api/usage`, `/api/admin/reload`.

**Exit criteria:** master key appears in no response/JS bundle; direct external access to port 8890 impossible; exceeding the cap downgrades heavy rather than failing.

### Phase 4 — Static frontend at `/agentcyto/` ✅ shipped

**Files:** `agentcyto/ui/` (plain HTML/CSS/JS, no build step)

**Shipped deviation:** the BFF serves the static files itself (`StaticFiles` mounted at `/`) so nginx only needs one proxy location; no `/var/www/agentcyto` alias is used.

1. Chat: SSE streaming, heavy/light toggle, chat/agent selector, "answered by `<model>`" badge, stop/retry/regenerate, session picker, agent workspace indicator (session id + "files live here").
2. Status: provider health, current chain heads, responder history, daily usage/budget.
3. Login: browser basic-auth prompt using `AUTHKEY` (optionally a styled pre-form later). Reconnect logic resumes in-flight jobs from last seq; show `partial → retrying`.
4. Serve static files from `/var/www/agentcyto/`, all asset URLs relative to `/agentcyto/`. No provider URLs or keys in JS.

**Exit criteria:** page loads at `https://t.aryan.cfd/agentcyto/`, assets load, mode switch changes responder, agent mode works within its session workspace.

### Phase 5 — nginx exposure ✅ shipped

**Files:** `/etc/nginx/sites-available/t.aryan.cfd` (backup `.bak-agentcyto`), `/etc/nginx/.htpasswd-agentcyto`, `agentcyto/scripts/deploy.sh`

1. `apt-get install -y apache2-utils` (`htpasswd` is not installed). Generate the password file from `AUTHKEY` without echoing it:
   `printf '%s' "$AUTHKEY" | htpasswd -i -c /etc/nginx/.htpasswd-agentcyto agentcyto` then `chmod 640` / group `www-data`.
2. Insert before `location /` in the existing vhost:

```nginx
location = /agentcyto { return 301 /agentcyto/; }

location /agentcyto/ {
    auth_basic "agentcyto dashboard";
    auth_basic_user_file /etc/nginx/.htpasswd-agentcyto;

    proxy_pass http://127.0.0.1:8890/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Auth-User $remote_user;

    proxy_http_version 1.1;
    proxy_buffering off;          # SSE
    proxy_cache off;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
    add_header Cache-Control "no-store" always;
}
```

   Static assets can be served with `location /agentcyto/assets/ { alias /var/www/agentcyto/assets/; }` ahead of the API proxy.
3. `nginx -t && systemctl reload nginx`; verify Certbot renewal still works.
4. Cloudflare fronts this host — add a Cache Rule **Bypass** for `t.aryan.cfd/agentcyto/*` so auth headers and SSE are never cached.
5. `deploy.sh`: idempotent htpasswd regeneration, UI sync, nginx reload only after successful config test.

**Exit criteria:** no credentials → `401`; `AUTHKEY` → UI loads; API/SSE works through the route; `/agentcyto` redirects to `/agentcyto/`; `/p/`, `/admin`, `/cytogame/` unchanged.

### Phase 6 — Ops, backups, drills

1. Backups: cron tar of `claude-config`, `agy-config`, `muse-config`, `agy-config2`, `agy-cache`, `gateway-state`, `agentcyto/state`, and `/workspaces`; encrypted off-host; document restore.
2. Health/drills: scheduled `check.sh` + `smoke.sh heavy light`; a fallback drill that invalidates one key and confirms chain advance; alert on chain exhaustion.
3. Observability: BFF `usage` table + UI dashboard (requests, fallbacks, latency, spend by model); no prompt bodies in logs.
4. Lifecycle: systemd/`@reboot` compose start; BFF healthcheck; gateway healthcheck already present.
5. Key rotation runbook (NVIDIA key expires 20 May 2027; Gemini keys have daily caps; Muse credit to be measured).

---

## 5. Decisions (resolved + remaining)

Resolved:
1. **UI stack: static plain HTML/CSS/JS** — confirmed.
2. **Expose CLI agents: yes** — confirmed, with per-session workspaces and no automatic cross-model agent fallback.
3. **META_API_KEY: now added** — Muse API model can sit high in heavy; Muse CLI credit still needs verification.
4. **Dashboard auth: use `AUTHKEY` as nginx basic-auth password** (recommended, satisfies original requirement); styled cookie login is optional later.
5. **Muse contributor models: enabled** — user confirmed prompts may be used for training; `muse-spark-cheap` and `muse-agent-contributor` are configured.

Remaining:
5. Mode ordering location: **static aliases + fallback chains in `config.yaml`** recommended; dynamic per-request lists only if verified on LiteLLM `1.110.1`.
6. Muse CLI placement: recommend `muse-cli` mid-heavy until credit/allowance is measured; `muse-agent` explicit-only.
7. Paid models in heavy: **allowed with a daily cap and visible UI indicator** recommended.
8. Static assets: **nginx `alias` for assets, BFF for API** recommended.
9. Should `brev` get its own phase? Recommend **no for v1** — it is GPU infrastructure, not a model provider (§7).

---

## 6. Acceptance test checklist

- [x] `docker compose build gateway` succeeds; `check.sh` and `smoke.sh` pass. (NIM model id drift fixed.)
- [x] `muse-cli` and `muse-agent` answer through the gateway; Muse JSONL output parsed without leaking session logs.
- [x] `claude-agent`, `agy-agent`, `muse-agent` each work in a distinct `/workspaces/<conversation>/` (3 distinct dirs observed).
- [x] `curl -u agentcyto:"$AUTHKEY" https://t.aryan.cfd/agentcyto/api/health` → 200; without `-u` → 401.
- [ ] `heavy` and `light` produce different responders; reported `model` matches the chain head.
- [ ] Invalidating a Gemini key advances to the alt key; chain recovers after cooldown.
- [~] Browser disconnect mid-stream → reconnect resumes from checkpoint; no duplicated final message (BFF restart path verified: attempt 2, one final message).
- [x] Gateway/BFF restart → sessions, jobs, and CLI session maps survive.
- [~] `/p/` and `/cytogame/` still 200; `/admin` not re-tested; Certbot renewal dry-run passed.
- [x] No secret value in tracked files, browser devtools, or logs.

---

## 7. Optional future: Brev as self-hosted last resort

`brev` is NVIDIA's **GPU instance manager** (`brev create`, `brev launch`, `brev exec`, `brev port-forward`), not a chat/LLM CLI. It cannot be added to `cli_provider.py` directly. If external APIs all fail, a genuinely independent fallback would be: spin up a Brev GPU instance, run an OpenAI-compatible server (vLLM/TGI) on it, expose it via `brev port-forward`, and add an `openai/` deployment in LiteLLM pointing at that local endpoint. That costs GPU money and adds operational complexity, so it is deliberately **out of scope for v1**.

---

## 8. Open items

- Verify Muse CLI context carry-over with repeated `muse exec --session-id <uuid>` calls (resume semantics) and measure actual credit/allowance before finalising its chain position.
- Confirm `GEMINI_API_KEY_alt` is a distinct quota bucket; if not, replace it with another provider.
- Decide whether `nemotron-ultra` belongs in `heavy` or only as a fallback (free but slow).
- Decide whether OpenCode should default to `gateway/heavy` / `gateway/light` or keep concrete aliases.
