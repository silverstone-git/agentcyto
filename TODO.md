# TODO.md — agentcyto work queue

Companion to `AGENTS.md` (current implementation details) and `MASTER_PLAN.md` (roadmap/design).
Date: 2026-11-20

Status key:
- `[x]` done and verified
- `[ ]` todo
- `[~]` in progress / partially done
- `[!]` blocker or needs a decision from the user

**Constraints that apply to every task:** never print secret values; invoke scripts with `bash cli-gateway/scripts/...`; keep the gateway on `127.0.0.1:4000`; preserve per-conversation agent workspace isolation; update `AGENTS.md`, `MASTER_PLAN.md`, and this file in the same change that alters architecture, ports, env keys, routes, or verification commands.

---

## Done — Phases 0 and 1

- [x] Stage root `./.env` keys into `cli-gateway/secrets/gateway.env` (`chmod 600`) with correct mapping.
- [x] Stage CLI logins into `cli-gateway/secrets/cli-state/` (Claude, AGY ×3 dirs, Muse config, Muse binary).
- [x] Add root `.gitignore` and `cli-gateway/.env` (`APP_UID=1001`, `WORKSPACE_DIR=.../workspaces`).
- [x] Install Muse launcher in Dockerfile; use a uid-1001-owned host bind mount for `/opt/muse/bin`.
- [x] Fix NIM model drift: `nemotron-3.5-super-vl-120b-a12b`, add `nemotron-bolt`.
- [x] Wire `GEMINI_API_KEY_ALT` as second Gemini deployment.
- [x] Implement Muse support in `cli_provider.py` (JSONL parse, `--prompt-file`, `--session-id`, chat/agent modes).
- [x] Add `heavy`, `heavy-tool`, `light`, `light-tool` aliases and ordered fallback chains.
- [x] Enable Muse contributor models (`muse-spark-cheap`, `muse-agent-contributor`) per user approval.
- [x] Per-conversation agent workspaces under `./workspaces/<16-hex>/`; 3 distinct dirs observed in smoke tests.
- [x] Update `README.md`, OpenCode template, `MASTER_PLAN.md`, `AGENTS.md`.
- [x] Build image, start gateway, `check.sh` and `smoke.sh` pass for `muse-cli`, `muse-agent`, `claude-agent`, `agy-agent`, `heavy`, `light`.

---

## P0 — close the immediate verification gaps

These are cheap, high-value checks before building more layers on top.

- [ ] **Muse resume test (two turns).** Send a first prompt with `model: muse-cli`, then a second prompt referencing it ("what was my first word?"). Confirm the same Muse session is resumed and context is retained. If it does not resume, fix `cli_provider.py` session handling before promising "chat lives on".
  - Command sketch: two `curl` calls to `/v1/chat/completions`, same conversation shape as OpenCode sends (full history on turn 2).
  - Acceptance: second answer demonstrates memory of turn 1 without a transcript replay.
- [ ] **Fallback drill.** Temporarily break one provider key (e.g. point `GEMINI_API_KEY` at an invalid value in a *test* env copy), restart gateway, call an alias whose chain includes it, verify `via` advances to the next model. Restore key and verify recovery after `cooldown_time=60`.
  - Do not mutate the live `secrets/gateway.env` without a backup and immediate restore.
  - Acceptance: observed fallback and recovery; log the result in this file.
- [ ] **Verify `GEMINI_API_KEY_alt` is a distinct quota bucket.** If it shares the primary quota, replace it with another provider (e.g. second NIM-like source) rather than keeping a fake redundancy.
- [ ] **Measure Muse credit/allowance.** `muse usage` says `no_allowance`. Confirm real Meta API credit via `META_API_KEY` and contributor-tier behaviour. Decide whether `muse-spark` stays second in `heavy`.
- [ ] **Initialise git.** `git init`, commit current state (ensure `.env`, `secrets/`, `workspaces/`, `*.db` are ignored). This is required before broad Phase 2 edits.
  - Verification: `git status --short` shows no secret files.
- [ ] **Fix script permissions** (optional): `chmod +x cli-gateway/scripts/*.sh` so docs can stop saying `bash …`, or keep current convention and note it.

---

## P1 — Phase 2: continuity ("chat lives on and tasks don't stop")

**Goal:** durable sessions/jobs, reconnect/resume, browser-session-scoped isolation.

### BFF skeleton
- [ ] Create `agentcyto/bff/` with `app.py`, `modes.yaml`, `Dockerfile`, `requirements.txt` (FastAPI, uvicorn, httpx).
- [ ] Add `bff` service to `cli-gateway/docker-compose.yml` on `127.0.0.1:8890` with `env_file: secrets/gateway.env`, `restart: unless-stopped`, healthcheck.
- [ ] BFF injects `Authorization: Bearer $LITELLM_MASTER_KEY` on all upstream calls; rejects requests lacking nginx's `X-Auth-User` when behind nginx.
- [ ] Add `/api/health`, `/api/models`, `/api/modes` endpoints.

### Persistence and jobs
- [ ] Create `agentcyto/state/agentcyto.db` (git-ignored). Tables: `sessions`, `messages`, `jobs`, `job_events`, `usage`, `health`.
- [ ] `POST /api/chat`: accepts `{session_id, mode, role, message, idempotency_key}`, creates a durable job, returns `job_id` immediately.
- [ ] Worker sends full canonical history + mode alias to LiteLLM; appends assistant output; checkpoints after each chunk/step.
- [ ] `GET /api/stream?job_id=...&after=<seq>`: SSE replay from last sequence number; browser can disconnect/reconnect without losing the job.
- [ ] Failure states: `blocked` (full chain exhausted, exponential backoff), `partial` (truncated stream, retry from checkpoint), `done`.
- [ ] Session endpoints: list/create/rename/clear; clearing also drops related CLI session-map entries.

### Browser-session-scoped isolation
- [ ] Patch `cli_provider.py` to read `X-Agentcyto-Session` (via LiteLLM metadata/kwargs — verify exact hook in 1.110.1).
- [ ] Include the session id in `history_key()` and `workspace_id`; keep backward compatibility when header absent (OpenCode path).
- [ ] BFF creates `/workspaces/<session-id>/...` subdirs with strict allow-list (`/workspaces/<uuid>` only), size cap, TTL cleanup.
- [ ] Acceptance: two browser sessions with identical text get different CLI session IDs and cannot read each other's files.

### Verification
- [ ] Kill browser tab mid-answer → reconnect → answer continues from checkpoint, no duplicated final message.
- [ ] Restart gateway + BFF → jobs, history, and CLI session maps survive.
- [ ] `docker compose config --quiet`, `py_compile`, `check.sh`, `smoke.sh` all pass after changes.

---

## P2 — Phase 3: BFF guardrails

- [ ] `modes.yaml`: mode → alias/role mapping, allow-paid flag, context/timeout limits. Editable without rebuild.
- [ ] Daily spend counter for `muse-spark` / Muse credit; CLI subscription usage counted as quota units.
- [ ] Per-session/IP rate limiting.
- [ ] Auto-downgrade when cap reached: `heavy` → `heavy-tool` / `light` instead of hard failure.
- [ ] Usage logging: requests, fallbacks, latency, resolved model, tokens, spend. Never log prompt bodies or secrets.
- [ ] `/api/admin/reload` (optional) to reload `modes.yaml` without restart.
- [ ] Acceptance: master key appears in no response/JS bundle; cap downgrade visible in API response.

---

## P3 — Phase 4: static frontend

**Stack:** plain HTML/CSS/JS, no build step (confirmed).

- [ ] Create `agentcyto/ui/` with `index.html`, `app.js`, `styles.css`; publish target `/var/www/agentcyto/`.
- [ ] Chat view: SSE streaming, heavy/light toggle, chat/agent selector, "answered by `<model>`" badge, stop/retry/regenerate.
- [ ] Agent view: show session id + workspace indicator; link to per-session file list if implemented.
- [ ] Session picker: new chat, list, rename, clear.
- [ ] Status view: provider health, current chain heads, recent responder history, daily usage/budget bar.
- [ ] Login: rely on nginx basic-auth prompt using `AUTHKEY` (no JS secret handling).
- [ ] Reconnect logic: on load, resume in-flight job from last seq; show `partial → retrying` state.
- [ ] All asset URLs relative to `/agentcyto/`; no provider URLs/keys in JS.
- [ ] Acceptance: page loads at `https://t.aryan.cfd/agentcyto/`, assets load, mode switch changes responder, agent mode works in its own workspace.

---

## P4 — Phase 5: nginx exposure

**Already done by user:** Cloudflare Cache Rule bypass for `http.request.full_uri wildcard r"https://t.aryan.cfd/agentcyto/*"`.

- [ ] `apt-get install -y apache2-utils` (`htpasswd` currently missing).
- [ ] Generate `/etc/nginx/.htpasswd-agentcyto` from `AUTHKEY` without echoing it:
  `printf '%s' "$AUTHKEY" | htpasswd -i -c /etc/nginx/.htpasswd-agentcyto agentcyto`
  then `chmod 640`, group `www-data`.
- [ ] Edit `/etc/nginx/sites-available/t.aryan.cfd` **before** `location /`:
  - `location = /agentcyto { return 301 /agentcyto/; }`
  - `location /agentcyto/assets/ { alias /var/www/agentcyto/assets/; }`
  - `location /agentcyto/` with `auth_basic`, `auth_basic_user_file`, `proxy_pass http://127.0.0.1:8890/`, forwarded headers, `X-Auth-User $remote_user`, `proxy_buffering off`, `proxy_cache off`, 900 s timeouts, `Cache-Control: no-store`.
- [ ] `nginx -t && systemctl reload nginx`.
- [ ] Verify Certbot renewal still works (`certbot renew --dry-run`).
- [ ] Write `agentcyto/scripts/deploy.sh`: idempotent htpasswd regeneration, UI sync, nginx reload only after successful config test.
- [ ] Acceptance: no creds → 401; `AUTHKEY` → UI loads; API/SSE works through route; `/agentcyto` redirects to `/agentcyto/`; `/p/`, `/admin`, `/cytogame/` unchanged.

---

## P5 — Phase 6: ops, backups, drills

- [ ] Backup cron: tar `gateway-state`, `secrets/cli-state/**`, `secrets/gateway.env`, `agentcyto/state`, `./workspaces` into encrypted off-host storage; document restore.
  - Note: Muse binary is ~417 MB; consider excluding/re-downloading it to save space.
- [ ] Scheduled `check.sh` + `smoke.sh heavy light`; alert on chain exhaustion.
- [ ] BFF usage dashboard wired into UI status view.
- [ ] Lifecycle: systemd unit or `@reboot` cron to `docker compose up -d`; BFF healthcheck.
- [ ] Key rotation runbook: NVIDIA expires 20 May 2027; Gemini keys have daily caps; `AUTHKEY` → regenerate htpasswd.
- [ ] Account-risk review: confirm disposable Claude/AGY accounts are acceptable given README ToS warnings.

---

## Backlog / nice-to-have

- [ ] Brev self-hosted last resort: GPU instance + vLLM/TGI + `brev port-forward` + `openai/` deployment in LiteLLM. Costs money; out of scope for v1.
- [ ] Dynamic per-request fallback lists if LiteLLM 1.110.1 supports them (replace static aliases).
- [ ] Styled cookie-based dashboard login instead of/in addition to browser basic-auth prompt.
- [ ] Local Ollama/vLLM fallback if the box ever gets a GPU.
- [ ] Per-user accounts and per-user budgets (currently one shared password/budget).
- [ ] TTL cleanup for `./workspaces/<id>/` and Muse prompt temp files.
- [ ] Structured logging/metrics export (Prometheus) instead of SQLite-only usage table.
- [ ] Automated test suite beyond `check.sh`/`smoke.sh`.

---

## Acceptance checklist before "internet live"

Do not consider deployment complete until all of these pass:

- [ ] `git status --short` contains no secret files.
- [ ] `docker compose --project-directory cli-gateway config --quiet`.
- [ ] `python3 -m py_compile cli-gateway/gateway/cli_provider.py cli-gateway/gateway/tools/*.py`.
- [ ] YAML/JSON parse for `config.yaml` and `opencode.template.json`.
- [ ] `bash cli-gateway/scripts/check.sh` → all providers HTTP 200, expected models present.
- [ ] `bash cli-gateway/scripts/smoke.sh heavy light muse-cli muse-agent claude-agent agy-agent` → all OK.
- [ ] Muse two-turn resume verified.
- [ ] Fallback drill verified and restored.
- [ ] `curl -u agentcyto:"$AUTHKEY" https://t.aryan.cfd/agentcyto/api/health` → 200; without `-u` → 401.
- [ ] Browser disconnect mid-stream → reconnect resumes; no duplicate final message.
- [ ] Agent sessions cannot see each other's workspaces.
- [ ] `/p/`, `/admin`, `/cytogame/` still work; `certbot renew --dry-run` passes.
- [ ] No secret value in tracked files, browser devtools, or logs.
- [ ] `AGENTS.md`, `MASTER_PLAN.md`, `TODO.md` updated for whatever actually shipped.

---

## Recurring maintenance

- [ ] Weekly: `check.sh`, `smoke.sh`, review usage/spend, check provider status pages.
- [ ] Monthly: rotate or verify keys, review free-tier caps, prune old `./workspaces/<id>/` dirs, verify backups restore.
- [ ] On any provider 429 spike: reorder affected chain in `config.yaml`, restart gateway, re-run smoke.
- [ ] On any key leak: rotate at provider → regenerate `secrets/gateway.env` (and htpasswd if `AUTHKEY`) → recreate containers → re-run verification.

---

## Notes / open decisions

- [!] Confirm whether `nemotron-ultra` should stay second in `heavy` (free but slow).
- [!] Decide whether OpenCode default should become `gateway/heavy` / `gateway/light` or stay `gateway/nemotron-super`.
- [!] Confirm Muse contributor credit behaviour after measurement.
- [!] No git repo yet — initialise before Phase 2.
