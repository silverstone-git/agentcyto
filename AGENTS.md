# AGENTS.md — agentcyto operational & development guide

Entry point for any agent or human working in `/home/ubuntu/cyto/agentcyto`. It holds the rules that
must never be forgotten, the current status and the repository map; everything else is in `docs/`.

---

## 0. Quick contract

**Do**
- Treat `./.env`, `cli-gateway/secrets/**`, and `cli-gateway/workspace/**` as secret or user data. Never print values.
- Invoke scripts as `bash cli-gateway/scripts/<name>.sh` (they are currently mode `0644`, not executable).
- Validate after every config change: `python3 -m py_compile`, YAML/JSON parse, `docker compose config --quiet`, then `check.sh` and `smoke.sh`.
- After any frontend change: `npm run build` in `agentcyto/frontend`, then rebuild + restart the `bff` image (the UI is baked into it).
- Keep the gateway bound to `127.0.0.1:4000`. Public exposure is only through the future BFF + nginx route.
- Preserve per-conversation workspace isolation. Agent models must never share a working directory.

**Don't**
- Don't paste API keys, OAuth tokens, htpasswd hashes, or master keys into chat, logs, commits, or docs.
- Don't add `muse`/`claude`/`agy` credentials to the Docker image; they are runtime mounts only.
- Don't give `*-agent` models an automatic fallback chain. A half-finished edit must not be handed to another model.
- Don't remove `drop_params: true` or the 900 s timeouts without understanding CLI/tool incompatibilities.
- Don't expose the gateway or BFF directly; only nginx `/agentcyto/` is public.

---

---

## 1. Scope and current status

**Date of this document:** 2026-11-22

**Completed locally (Phases 0–5 of `MASTER_PLAN.md`):**
- Root `./.env` holds all provider keys; `cli-gateway/secrets/gateway.env` is generated from it.
- Three CLI logins are staged into `cli-gateway/secrets/cli-state/` and bind-mounted into containers.
- Docker image builds cleanly; gateway is healthy on `127.0.0.1:4000`.
- Muse Code support added to the custom provider; all four CLI families work (`claude`, `agy`, `muse`, plus agent variants).
- Preference aliases `heavy`, `heavy-tool`, `light`, `light-tool` exist with ordered fallback chains.
- BFF on `127.0.0.1:8890`: SQLite session/message/job journal, durable workers, SSE replay, usage/budget guard, KB retrieval with a visible trace (details: `docs/bff-and-frontend.md`).
- **React + Vite + TypeScript + Tailwind v4 frontend** (`agentcyto/frontend` → `agentcyto/ui`): Apple-style dark UI, mobile-first drawers, streaming answers with Markdown + KaTeX, collapsible retrieval/thinking panels, clickable citations that open the source passage, KB `+` menu and chips in the composer, swipe/hover reply, per-chat rename / AI auto-name / delete, lazily created chats, system-log drawer, separate password-gated admin page for KB ingestion.
- `cli_provider.py` scopes CLI sessions and agent workspaces to a browser session via `X-Agentcyto-Session`.
- nginx route `/agentcyto/` with basic auth is live on `https://t.aryan.cfd/agentcyto/`.
- **Retrieval v2** (2026-11-22): LLM-planned, outline-aware KB search + rerank (default on, toggle
  "LLM-assisted search"), stemmed breadcrumb FTS index, optional Brave web search with page scraping
  (globe toggle, clickable web citations). Details: `docs/knowledge-base.md` §9.7–9.8.
- **Knowledge Base (KB)**: SQLite-only (`kb_*` tables + FTS5) compiled from `repo/physics/` by `kb.py`. Current verified totals: 13 documents, 103,039 nodes, 27,375 equations, 1,452 symbols (an earlier parser bug had dropped one-line `$$…$$` equations; fixed 2026-11-22 — see `docs/knowledge-base.md` §9.7). Attached KB docs are searched per chat turn (FTS5/bm25) and injected into the prompt; admin editing lives on a separate password-gated page (`apple` for now).
- Git repository initialised with a baseline commit; no secret files tracked.

**Not yet built (Phase 6 + open drills):**
- Backups, monitoring, failover/fallback drills.
- Workspace size cap + TTL, per-session/IP rate limiting.
- KB LLM enrichment stage (summaries, concepts, derivation boundaries via gateway) — implemented but not yet wired into a scheduled job.
- Real-browser reconnect test, Gemini alt-quota and Muse credit measurement (`certbot renew --dry-run` passed).

---

---

## 2. Repository map

```
/home/ubuntu/cyto/agentcyto
├── AGENTS.md                     # this file
├── MASTER_PLAN.md                # roadmap, decisions, acceptance tests
├── .env                          # root secrets (git-ignored, never printed)
├── .gitignore                    # ignores .env, secrets/, *.db, dist/, node_modules/, workspaces/, .claude/
├── TODO.md                       # work queue / verification checklist (live status)
├── workspaces/                   # per-conversation agent working dirs (created at runtime)
│   └── <hex-session-id>/
│
├── docs/                         # detailed documentation (see index below)
│
├── agentcyto/                    # BFF + React frontend (Phase 2–4)
│   ├── bff/
│   │   ├── app.py                # FastAPI routes, job worker, SSE, auth boundary + KB API
│   │   ├── db.py                 # SQLite schema + helpers, gateway session-map cleanup + KB tables
│   │   ├── kb.py                 # KB ingestion pipeline: markdown parser, LaTeX/symbol/equation extraction, FTS5 index
│   │   ├── retrieval.py          # per-turn retrieval: outline → LLM plan → FTS search → expand → LLM rerank
│   │   ├── websearch.py          # Brave search, SSRF-safe fetch, Wikipedia/HTML extraction
│   │   ├── modes.yaml            # mode → alias mapping, budget, price estimates
│   │   ├── requirements.txt
│   │   └── Dockerfile            # uid 1001, serves UI from /app/ui
│   ├── state/
│   │   ├── .keep
│   │   └── agentcyto.db          # git-ignored, WAL mode (includes kb_* tables)
│   ├── frontend/                 # React + Vite + TS + Tailwind v4 source (npm run build → ../ui)
│   │   ├── src/{App.tsx,index.css,lib/,hooks/,components/{layout,chat}/,pages/}
│   │   └── public/               # favicon.svg, icons.svg
│   ├── ui/                       # BUILT frontend (committed; baked into the bff image; do not hand-edit)
│   └── scripts/
│       └── deploy.sh             # htpasswd + nginx test/reload
│
├── repo/physics/                 # KB source of truth: 13 physics Markdown files (~26MB), read-only
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
    │   ├── opencode.template.json # native V2 config: 22 gateway aliases + opencode/big-pickle, __PORT__/__KEYFILE__ placeholders
    │   └── opencode.json          # generated, git-ignored
    │
    ├── secrets/
    │   ├── gateway.env            # runtime secrets, chmod 600, generated from root .env
    │   ├── bff.env                # BFF-only secrets (BRAVE_API_KEY), chmod 600, optional
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

## 3. Documentation index

Detailed material moved out of this file into `docs/` (section numbers like §8 are preserved in the
docs so older references still resolve):

| Document | Contents |
|---|---|
| `docs/architecture.md` | §3 runtime topology & request flow, §4 host environment, §6 containers/volumes, §10 data stores, §14 public deployment path |
| `docs/secrets-and-security.md` | §5 secrets & CLI credential staging, §12 security model |
| `docs/gateway.md` | §7 model registry & fallback chains, §8 `cli_provider.py` internals |
| `docs/knowledge-base.md` | §9 KB design, tables, API, UI, ingestion bug fixes, chat retrieval |
| `docs/bff-and-frontend.md` | BFF API/SSE events, React frontend structure, behaviour notes, build & deploy |
| `docs/operations.md` | §10 runbooks, §11 verification, §13 change procedures, §15 troubleshooting |
| `docs/reference.md` | §17 env key names, endpoints, critical paths, health one-liner |

Other documents: `MASTER_PLAN.md` (roadmap), `TODO.md` (live checklist), `cli-gateway/README.md` (upstream overview).

**Where to look first**
- Changing a model/alias/fallback → `docs/gateway.md` + `docs/operations.md` §13.2–13.3
- Changing the UI → `docs/bff-and-frontend.md` (then rebuild frontend **and** bff image)
- KB parser/ingestion → `docs/knowledge-base.md` §9.7, then reindex
- Something is broken → `docs/operations.md` §15
- Rotating secrets → `docs/secrets-and-security.md` + `docs/operations.md` §13.5

---

## 4. Roadmap ownership

`MASTER_PLAN.md` is the roadmap. Current phase status:

- [x] Phase 0 — secrets, safety, working gateway
- [x] Phase 1 — provider registry, Muse/AGY wiring, heavy/light chains
- [x] Phase 2 — continuity: session journal, durable jobs, browser-session-scoped workspaces
- [x] Phase 3 — BFF: auth, mode mapping, budget (rate limiting still backlog)
- [x] Phase 4 — React frontend (+ Knowledge Base: ingestion, search, attach, cited retrieval)
- [x] Phase 5 — nginx exposure at `t.aryan.cfd/agentcyto`
- [ ] Phase 6 — ops, backups, drills

**Knowledge Base (complete):** SQLite-only KB with FTS5 search over `repo/physics/` (13 docs, 103,039 nodes, 27,375 equations, 1,452 symbols). Full web-page control via KB API endpoints and the admin page. LLM enrichment stage implemented but not yet scheduled.

When implementing a later phase, update this file and the relevant `docs/` page in the same change: new services, ports, env keys, routes, data stores, and verification commands belong here.

---
