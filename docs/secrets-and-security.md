# Secrets, credentials and security model

Which secrets exist (names only), how CLI credentials are staged, and the trust boundaries.

> Section numbers (§N) are preserved from the former monolithic `AGENTS.md` so older references still resolve.

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

### 5.2a `cli-gateway/secrets/bff.env` (generated, chmod 600, optional)

BFF-only secrets, loaded via a second `env_file` (`required: false`) on the `bff` service so the
gateway never sees them. Currently `BRAVE_API_KEY` (root `BRAVE_API_KEY`) for web search. Without
it the web-search toggle is disabled in the UI. Web fetches from search results are restricted to
public IPs on every redirect hop (no access to `gateway:4000`, loopback or metadata endpoints).

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

---

## 12. Security model

| Boundary | Current state |
|---|---|
| Provider keys | Only in root `./.env` and generated `secrets/gateway.env` (chmod 600) |
| Master key | Only in `gateway.env`; injected into LiteLLM; never sent to browser |
| Dashboard password | `AUTHKEY` in root `.env`; nginx basic auth (username `agentcyto`) → `.htpasswd-agentcyto` |
| Gateway network | Loopback only (`127.0.0.1:4000`) |
| BFF network | Loopback only (`127.0.0.1:8890`); rejects API calls without nginx's `X-Auth-User` |
| CLI credentials | Host files bind-mounted at runtime; never in image layers |
| Agent file access | Scoped to `/workspaces/<hex-session-id>` (0700); `--yolo` only inside that dir |
| Cross-session leakage | Session id in both `history_key()` and workspace path; no two browser sessions share CLI sessions or files |
| Free-tier privacy | Gemini free prompts may be used by Google; Muse contributor prompts may be used for training (user approved) |
| Account risk | README warns about AGY/Claude CLI ToS; use disposable accounts |
| Cloudflare | Cache Bypass rule for `/agentcyto/*` plus nginx `Cache-Control: no-store`, `proxy_buffering off`, SSE timeouts |
| Logging | Never log request bodies or secret values; `check.sh` prints lengths only |

If a secret is ever exposed in chat or logs, rotate it immediately at the provider and regenerate `secrets/gateway.env` / htpasswd.

---
