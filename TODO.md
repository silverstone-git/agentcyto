# TODO.md — agentcyto work queue

Companion to `AGENTS.md` (current implementation details) and `MASTER_PLAN.md` (roadmap/design).
Date: 2026-11-20

Status key:
- `[x]` done and verified
- `[ ]` todo
- `[~]` in progress / partially done
- `[!]` blocker or needs a decision from the user

**Update 2026-11-20 (this session):** Phases 2–5 shipped locally: BFF with durable
jobs + SSE replay, browser-session-scoped CLI sessions/workspaces, static UI,
basic-auth nginx route at `/agentcyto/`. Git is initialised. P0 provider drills
(fallback, quota-bucket, Muse credit) are still open.

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

- [x] **Muse resume test (two turns).** Verified via two `/v1/chat/completions` calls with full history; turn 2 correctly recalled "BANANA" from turn 1.
- [ ] **Fallback drill.** Temporarily break one provider key (e.g. point `GEMINI_API_KEY` at an invalid value in a *test* env copy), restart gateway, call an alias whose chain includes it, verify `via` advances to the next model. Restore key and verify recovery after `cooldown_time=60`.
  - Do not mutate the live `secrets/gateway.env` without a backup and immediate restore.
  - Acceptance: observed fallback and recovery; log the result in this file.
- [ ] **Verify `GEMINI_API_KEY_alt` is a distinct quota bucket.** If it shares the primary quota, replace it with another provider (e.g. second NIM-like source) rather than keeping a fake redundancy.
- [ ] **Measure Muse credit/allowance.** `muse usage` says `no_allowance`. Confirm real Meta API credit via `META_API_KEY` and contributor-tier behaviour. Decide whether `muse-spark` stays second in `heavy`.
- [x] **Initialise git.** Repo exists with one baseline commit; `.env`, `secrets/`, `workspaces/`, `*.db`, `agentcyto/state/` are ignored. `git status --short --ignored` shows no tracked secrets.
- [ ] **Fix script permissions** (optional): `chmod +x cli-gateway/scripts/*.sh` so docs can stop saying `bash …`, or keep current convention and note it.

---

## P1 — Phase 2: continuity ("chat lives on and tasks don't stop") ✅ shipped

**Goal:** durable sessions/jobs, reconnect/resume, browser-session-scoped isolation.

### BFF skeleton
- [x] `agentcyto/bff/` with `app.py`, `db.py`, `modes.yaml`, `Dockerfile`, `requirements.txt`.
- [x] `bff` service on `127.0.0.1:8890`, `env_file: secrets/gateway.env`, healthcheck, `restart: unless-stopped`.
- [x] Injects `Authorization: Bearer $LITELLM_MASTER_KEY` upstream; rejects API calls without `X-Auth-User` when `REQUIRE_AUTH_HEADER=1` (nginx supplies it).
- [x] `/api/health`, `/api/models`, `/api/modes`, `/api/admin/reload`.

### Persistence and jobs
- [x] SQLite at `agentcyto/state/agentcyto.db`: `sessions`, `messages`, `jobs`, `job_events`, `usage`, `health` (WAL, git-ignored).
- [x] `POST /api/chat` with `{session_id, mode, role, message, model?, idempotency_key?}` returns a `job_id` immediately.
- [x] Worker sends canonical history + resolved alias; checkpoints each delta into `job_events`.
- [x] `GET /api/stream?job_id=…&after=<seq>` SSE replay with heartbeats; UI tracks last seq in localStorage.
- [x] States: `queued → running → done`, `partial` (retry from checkpoint, max 2 attempts), `blocked`, `cancelled`.
- [x] Session list/create/rename/clear; clear also deletes gateway CLI session-map rows for that session.

### Browser-session-scoped isolation
- [x] `cli_provider.py` reads `X-Agentcyto-Session` from `litellm_params.metadata.headers` (verified on LiteLLM 1.110.1).
- [x] Session id included in `history_key()` and used directly as the agent `workspace_id`; absent header keeps the legacy OpenCode behaviour.
- [x] BFF creates `/workspaces/<hex-session-id>/` (0700) with a hex-only allow-list so no traversal is possible.
  - Still open: workspace size cap and TTL cleanup (backlog).
- [x] Verified: two sessions with identical text produced two workspace dirs and two distinct session-scoped CLI session-map entries.

### Verification
- [~] Browser disconnect mid-answer → reconnect resumes from last seq by design (UI implemented); live browser test not yet run.
- [x] Killed BFF mid-job → restart retried at attempt 2 → exactly one assistant message (no duplicate).
- [ ] Final `check.sh` / `smoke.sh` re-run pending (see acceptance checklist).

---

## P2 — Phase 3: BFF guardrails (mostly shipped)

- [x] `modes.yaml`: mode → alias/role mapping, paid flag, budget, editable via `/api/admin/reload`.
- [x] Daily spend counter using per-model estimates in `modes.yaml`; CLI subscriptions counted as $0 quota units.
- [ ] Per-session/IP rate limiting (not implemented).
- [x] Auto-downgrade when daily cap reached or `allow_paid: false`: paid modes fall back to `light` aliases.
- [x] Usage logging: resolved model, tokens, estimated spend; no prompt bodies or secrets logged.
- [x] `/api/admin/reload`.
- [x] Master key never appears in an API response or the JS bundle.

---

## P3 — Phase 4: static frontend ✅ shipped

**Stack:** plain HTML/CSS/JS, no build step. Files: `agentcyto/ui/{index.html,app.js,styles.css}`, served by the BFF at `/` (nginx proxies `/agentcyto/` → BFF). No `/var/www` sync needed.

- [x] Chat view: SSE streaming, mode/role/model selectors, "answered by `<model>`" badge, stop/retry.
- [x] Agent view: session id + workspace indicator.
- [x] Session picker: new chat, list, rename, clear.
- [x] Status view: gateway health, mode→chain mapping, daily spend vs budget bar.
- [x] Login via nginx basic auth (`AUTHKEY`); no JS secret handling.
- [x] Reconnect: resumes in-flight jobs from persisted seq; shows `partial — retrying (attempt N)`.
- [x] All asset URLs relative to `/agentcyto/`; no provider URLs/keys in JS.
- [~] Full browser acceptance still to run via a real browser (HTTP-level checks passed: 200 for page/assets/API through nginx).

---

## P4 — Phase 5: nginx exposure ✅ shipped

**Already done by user:** Cloudflare Cache Rule bypass for `http.request.full_uri wildcard r"https://t.aryan.cfd/agentcyto/*"`.

- [x] `apache2-utils` installed; `/etc/nginx/.htpasswd-agentcyto` generated from `AUTHKEY` without echoing it, mode 640, group `www-data`.
- [x] Vhost patched before `location /` (backup: `t.aryan.cfd.bak-agentcyto`):
  - `location = /agentcyto { return 301 /agentcyto/; }`
  - `location /agentcyto/` with basic auth, `proxy_pass http://127.0.0.1:8890/`, forwarded headers, `X-Auth-User $remote_user`, `proxy_buffering off`, `proxy_cache off`, 900 s timeouts, `Cache-Control: no-store`.
  - Static assets are served by the BFF, so no separate nginx `alias` is needed.
- [x] `nginx -t && systemctl reload nginx`.
- [x] `certbot renew --dry-run` passed.
- [x] `agentcyto/scripts/deploy.sh` regenerates htpasswd, tests nginx config, reloads only on success.
- [x] Verified: no creds → 401; `AUTHKEY` → UI/API 200; SSE streams through route; `/agentcyto` → 301; `/p/` and `/cytogame/` still 200.

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

- [x] `git status --short` contains no secret files.
- [x] `docker compose --project-directory cli-gateway config --quiet`.
- [x] `python3 -m py_compile cli-gateway/gateway/cli_provider.py cli-gateway/gateway/tools/*.py agentcyto/bff/*.py`.
- [x] YAML/JSON parse for `config.yaml`, `modes.yaml` and `opencode.template.json`.
- [ ] `bash cli-gateway/scripts/check.sh` → all providers HTTP 200, expected models present.
- [ ] `bash cli-gateway/scripts/smoke.sh heavy light muse-cli muse-agent claude-agent agy-agent` → all OK.
- [x] Muse two-turn resume verified.
- [ ] Fallback drill verified and restored.
- [x] `curl -u agentcyto:"$AUTHKEY" https://t.aryan.cfd/agentcyto/api/health` → 200; without `-u` → 401.
- [~] Browser disconnect mid-stream → reconnect resumes; no duplicate final message (restart path verified, browser path not).
- [x] Agent sessions use distinct workspace dirs and session-scoped CLI session keys.
- [~] `/p/`, `/cytogame/` still 200; `/admin` not re-tested this session; `certbot renew --dry-run` passed.
- [x] No secret value in tracked files, browser devtools, or logs.
- [x] `AGENTS.md`, `MASTER_PLAN.md`, `TODO.md` updated for whatever actually shipped.

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
- [x] Git repo initialised; no secret files tracked.
