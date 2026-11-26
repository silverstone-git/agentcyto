# Operations: runbooks, verification, change procedures, troubleshooting

Everything needed to build, run, verify and safely change the stack.

> Section numbers (§N) are preserved from the former monolithic `AGENTS.md` so older references still resolve.

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
Writes `cli-gateway/secrets/opencode.key` (master key) and `cli-gateway/opencode/opencode.json` from the native V2 template (`providers` / `package` / `settings` / `capabilities`, with `agents.title.model` replacing V1 `small_model`). Copy the JSON into a project or merge its `providers` block into `~/.config/opencode/opencode.json`.

The generated config exposes two provider groups:
- `gateway/<alias>` — all 22 aliases from `config.yaml`; requires this host, the running gateway, and the absolute `{file:...}` key path baked in by the script. On another machine both the key file and `127.0.0.1:4000` must be provided again.
- `opencode/big-pickle` — the current OpenCode free-tier model, inherited from the built-in provider via `canonical: "opencode"`. It is a **separate, OpenCode-native** model, not part of `light` or any gateway fallback chain. OpenCode's Inference API rejects free-tier models from non-OpenCode clients (HTTP 403), so LiteLLM cannot proxy it. It needs an OpenCode Console sign-in (`/connect`) or `OPENCODE_API_KEY` in that project; credentials do not carry over between projects.

Verified on OpenCode v2.3.2 with a copied config: `opencode models` listed all 22 `gateway/*` entries plus `opencode/big-pickle`, and both `opencode run --model gateway/light "Reply with exactly: pong"` and `opencode run --model opencode/big-pickle "Reply with exactly: pong"` answered `pong`.

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

### 10.8 BFF build / start / API

Frontend sources live in `agentcyto/frontend`; run `npm run build` there first (see `bff-and-frontend.md`), because the image bakes in `agentcyto/ui/`.

```sh
docker compose --project-directory cli-gateway build bff
docker compose --project-directory cli-gateway up -d bff
docker compose --project-directory cli-gateway logs --tail 100 bff
```

All `/api/*` calls require the `X-Auth-User` header nginx injects (set `REQUIRE_AUTH_HEADER=0` only for local debugging). `/api/health` is exempt for the container healthcheck.

```sh
# no secrets in any of these responses
curl -sS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/health
curl -sS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/modes
curl -sS -H 'X-Auth-User: local' -H 'Content-Type: application/json' \
  -d '{"name":"probe"}' http://127.0.0.1:8890/api/sessions
curl -sS -H 'X-Auth-User: local' -H 'Content-Type: application/json' \
  -d '{"mode":"light","role":"chat","message":"Reply with exactly: pong"}' \
  http://127.0.0.1:8890/api/chat
# then: GET /api/jobs/<job_id> and GET /api/stream?job_id=<job_id>&after=0
```

### 10.9 Public route

```sh
bash agentcyto/scripts/deploy.sh            # refresh htpasswd, nginx -t, reload
KEY=$(grep -E '^AUTHKEY=' .env | tail -n1 | cut -d= -f2-)
curl -sS -o /dev/null -w '%{http_code}\n' -u "agentcyto:$KEY" \
  https://t.aryan.cfd/agentcyto/api/health   # 200
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://t.aryan.cfd/agentcyto/             # 401
```

Never echo `$KEY`.

### 10.10 Claude credentials (refresh + 5-day sync)

`claude-agent` and `heavy`'s primary (`cli/claude@opus`) read OAuth credentials from
`cli-gateway/secrets/cli-state/claude/.credentials.json`, bind-mounted at `/home/app/.claude`.
A normal `claude` login on the host writes `~/.claude/.credentials.json`; the container copy does **not**
update by itself.

Symptom of a stale copy: `smoke.sh claude-agent` returns 401 *"OAuth session expired and could not be
refreshed"*, and `heavy` silently falls back to `muse-spark` instead of answering `via heavy`.

Manual heal (either):
```sh
bash cli-gateway/scripts/login.sh claude        # interactive; prints a long-lived token
bash cli-gateway/scripts/sync-claude-creds.sh   # host ~/.claude -> staged copy
```

The sync script only copies host → staged when the staged copy has no usable refresh token **and** the
host copy is usable; it never overwrites a working token with a stale one. No gateway restart is needed
(the CLI reads the file per invocation).

Automated: `agentcyto-claude-creds-sync.timer` (in `/etc/systemd/system`) runs the sync at boot and every
5 days:
```sh
systemctl list-timers agentcyto-claude-creds-sync.timer
journalctl -u agentcyto-claude-creds-sync.service -n 20
```
A failed unit means both copies are unusable — run `login.sh claude`. For a credential that does not
depend on the ~30-day refresh window, use the long-lived token from `login.sh claude` in
`CLAUDE_CODE_OAUTH_TOKEN` (then the timer is unnecessary).

---

---

## 11. Verification after changes

Run all applicable:

```sh
python3 -m py_compile cli-gateway/gateway/cli_provider.py \
  cli-gateway/gateway/tools/*.py agentcyto/bff/*.py
python3 -c 'import yaml; yaml.safe_load(open("cli-gateway/gateway/config.yaml")); yaml.safe_load(open("agentcyto/bff/modes.yaml"))'
python3 -c 'import json; json.load(open("cli-gateway/opencode/opencode.template.json"))'
docker compose --project-directory cli-gateway config --quiet
bash cli-gateway/scripts/check.sh
bash cli-gateway/scripts/smoke.sh heavy light muse-cli muse-agent claude-agent agy-agent
curl -fsS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/health >/dev/null
curl -fsS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/kb/status >/dev/null
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

Expected KB status after a full ingestion:
```
{"source_dir":"/kb-source","source_dir_exists":true,"source_files":13,
 "documents":13,"total_nodes":103039,"total_equations":27375,"total_symbols":1452,...}
```

Also confirm workspace isolation after agent tests:
```sh
find workspaces -mindepth 1 -maxdepth 1 -printf '%f\n' | sort
```
Three different agent smoke tests should produce three different IDs.

KB-specific verification:
```sh
# KB read endpoints require X-Auth-User and return 200 after ingestion
curl -sS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/kb/status
curl -sS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/kb/documents
curl -sS -H 'X-Auth-User: local' "http://127.0.0.1:8890/api/kb/search?q=equation&limit=5"
curl -sS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/kb/equations?limit=3
curl -sS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/kb/symbols?limit=5
curl -sS -H 'X-Auth-User: local' http://127.0.0.1:8890/api/kb/stats

# Admin gate: writes without a token → 401 "Admin sign-in required"; a bogus token → 401 "…or expired"
# (that second message also proves outsie is reachable; a 503 means it is not)
curl -sS -X POST -H 'X-Auth-User: local' http://127.0.0.1:8890/api/kb/ingest
curl -sS -X POST -H 'X-Auth-User: local' -H 'X-Admin-Token: bogus' http://127.0.0.1:8890/api/kb/ingest
docker exec cli-gateway-bff-1 sh -c 'touch /kb-source/.w && rm /kb-source/.w && echo writable'
```

---

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
5. For `AUTHKEY`, regenerate htpasswd with `bash agentcyto/scripts/deploy.sh`.

### 13.6 Change a mode mapping or budget without a rebuild

1. Edit `agentcyto/bff/modes.yaml` (mode → chat/agent alias, `allow_paid`, `daily_budget_usd`, price estimates).
2. `POST /api/admin/reload` with `X-Auth-User` **and** `X-Admin-Token` (see §13.7), or restart the `bff` container.
3. Verify `GET /api/modes` and run one chat per changed mode.
4. BFF code/static UI changes require `docker compose --project-directory cli-gateway build bff && up -d bff`; DB schema changes require a migration (the current `CREATE TABLE IF NOT EXISTS` does not alter existing tables).

### 13.7 Re-ingest or rebuild the KB

Every write below needs `X-Admin-Token` (since 2026-11-23). The easy path is the admin page. From the shell,
sign in on the admin page, copy `token` from the tab's sessionStorage key `agentcyto_admin_session` (valid 2 h;
never paste it into chat or logs), then e.g.
`curl -X POST -H 'X-Auth-User: local' -H "X-Admin-Token: $TOKEN" http://127.0.0.1:8890/api/kb/ingest`.
Restarting the `bff` container needs no token and does not re-ingest.

1. `POST /api/kb/ingest` with `X-Auth-User` — ingests all `.md` files in `KB_SOURCE_DIR`; skips files whose SHA-256 is unchanged (idempotent).
2. `POST /api/kb/reindex` — wipes all KB data and re-ingests from scratch (use after parser/schema changes).
3. `DELETE /api/kb/clear` — removes all KB data.
4. `GET /api/kb/status` — confirm `files_ingested`/`files_skipped` and stable node counts.
5. After any `db.py` KB schema change, existing tables are not altered (`CREATE TABLE IF NOT EXISTS`); drop `kb_*` tables manually or run reindex if needed.
6. Rebuild BFF image if `kb.py` or parser regexes change: `docker compose --project-directory cli-gateway build bff && up -d --force-recreate bff`.

---

---

## 15. Known issues, gotchas, troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `muse: command not found` inside `docker exec … bash -lc` | login shell resets `PATH` | use `bash -c`; PATH is `/opt/muse/bin:/home/app/.local/bin:…` |
| `installed binary is missing; rerun the installer` | Muse binary volume empty/root-owned | run `MUSE_LAUNCHER_INSTALL=1 muse`; keep host bind mount owned by uid 1001 |
| `TMPDIR '/tmp' produced … inside workspace` | cwd == TMPDIR | `cd /scratch` and `export TMPDIR=/tmp` |
| NIM `MISSING: nemotron-3-super-120b-a12b` | provider catalog drift | already fixed to `nemotron-3.5-super-vl-120b-a12b`; keep `check_keys.py` current |
| agent writes into another session's files | shared workspace | keep the hex session id as `workspace_id`; BFF creates the dir and rejects non-hex ids |
| mid-stream provider death | tokens already sent | not recoverable by LiteLLM; future BFF marks `partial` and retries from checkpoint |
| CLI model fails and falls back unexpectedly | bad/expired login | check `sessions.sh`, staged credentials, or run `scripts/login.sh` |
| `claude-agent` 401 "OAuth session expired and could not be refreshed"; `heavy` answers `via muse-spark` | staged `~/.claude` copy has no usable refresh token | run `bash cli-gateway/scripts/sync-claude-creds.sh` (or `login.sh claude`); the 5-day timer usually heals it — see §10.10 |
| `check.sh` says key EMPTY | wrong key name in `gateway.env` | consult §5.2 mapping |
| scripts say `Permission denied` | scripts are mode 0644 | invoke with `bash …` or `chmod +x` deliberately |
| `muse usage` says `no_allowance` | Muse CLI is not subscription-backed | rely on `META_API_KEY`/contributor credit; measure before promoting in chains |
| `brev` expected as a model | it is GPU infrastructure, not an LLM | see `MASTER_PLAN.md` §7; out of scope for v1 |
| `opencode/big-pickle` expected in `light` | OpenCode free-tier models are OpenCode-only; other clients get HTTP 403 | keep it as a separate native `opencode/*` model; only gateway aliases belong in fallback chains |

### Frontend / KB additions (2026-11-22)

| Symptom | Cause | Fix |
|---|---|---|
| blank/black page at `/agentcyto/` | Vite built absolute `/assets/…` URLs, or Tailwind v4 plugin missing | keep `base: '/agentcyto/'` and `@tailwindcss/vite`; rebuild frontend **and** the `bff` image |
| UI classes have no effect (`Cannot apply unknown utility class`) | Tailwind v4 needs `--color-*` theme variables | see `src/index.css` `@theme` |
| attached KB had no effect on answers | BFF ignored `kb_docs` (fixed 2026-11-22) | retrieval now in `run_job`; check for `trace`/`retrieval` SSE events |
| KB context missing for `heavy`/CLI models | CLI provider drops system messages | passages are prepended to the last *user* message — keep it that way |
| Equation counts far below `grep -c '$$'` | parser dropped one-line `$$…$$` (fixed) | reindex after parser fixes (`knowledge-base.md` §9.7) |
| streaming shows one bubble per chunk | stale closure in `handleEvent` (fixed) | live turn stored in refs; do not read `attempt` state inside the SSE handler |
| `bff` restarting, log `ModuleNotFoundError: No module named 'admin_gate'` (or any new module) | Dockerfile copies BFF files by name | add the file to the `COPY` line in `agentcyto/bff/Dockerfile`, rebuild |
| admin page: "This Google account is not an admin" | email not in outsie's `OUTSIE_ADMIN_EMAILS` | add it on outsie (agentcyto keeps no list) |
| admin page bounces back to the sign-in card | admin token expired (2 h) or revoked | sign in again |
| Google sign-in returns to the wrong place or errors before `/admin` | Supabase redirect allow-list | add `https://t.aryan.cfd/agentcyto/**` to the Supabase project's Auth redirect URLs |
| KB writes return 503 "Cannot reach outsie" | outsie down or `OUTSIE_URL` wrong | fails closed by design; fix outsie / `OUTSIE_URL`, then `up -d bff` |
| upload/create skill returns 503 "mounted read-only" or 500 on write | `repo/` not writable by uid 1001 | `sudo chown -R 1001:1001 repo` (or `chmod -R u+w`); check the compose mount has no `:ro` |
| page scrolls below the footer on phones | `min-height:100vh` > visible viewport | root is `height:100%; overflow:hidden`, shell uses `100dvh` |

Additional caveats:
- Muse binary is ~417 MB in `secrets/cli-state/muse-bin/`; account for this in backups.
- `GEMINI_API_KEY_alt` is assumed to be a separate quota bucket; not yet proven.
- Claude OAuth token env var is intentionally empty; credentials are mounted.
- OpenCode template default is still `gateway/nemotron-super`, not `heavy`/`light`.
- Git repo is initialised; no secret files are tracked.

---
