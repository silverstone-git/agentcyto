# cli-gateway

A local LiteLLM gateway that puts logged-in coding CLIs (Claude Code, Antigravity) and free or cheap
API keys (NVIDIA, Gemini, Meta) behind one OpenAI-compatible endpoint, for use from OpenCode.

```
OpenCode ──HTTP──▶ LiteLLM :4000 (127.0.0.1 only)
                    ├─ cli/claude…  ──▶ `claude -p --resume <session>`   (your Claude login)
                    ├─ cli/agy…     ──▶ `agy -p --conversation <id>`     (your Antigravity login)
                    ├─ nvidia_nim/… ──▶ build.nvidia.com                 (free, ~40 req/min)
                    ├─ gemini/…     ──▶ Gemini API                       (friend's key, Flash only on free tier)
                    └─ meta/…       ──▶ Meta Model API                   ($20 starter credit)
```

It follows the same layout as the tnn handout: Docker only, secrets in git-ignored env files split by
consumer, thin wrapper scripts that never print values, and tools as `run --rm` containers behind a profile.

## Quick start

```sh
cp .env.example .env                                   # ports, uid, workspace path
cp secrets/gateway.env.example secrets/gateway.env && chmod 600 secrets/gateway.env
#   fill in LITELLM_MASTER_KEY, NVIDIA_NIM_API_KEY, GEMINI_API_KEY, META_API_KEY

docker compose build gateway                           # one build at a time on a small host
scripts/login.sh claude                                # paste the token into CLAUDE_CODE_OAUTH_TOKEN
scripts/login.sh agy                                   # sign in, then /quit
docker compose up -d gateway
scripts/check.sh                                       # key lengths + HTTP status + model ids exist
scripts/smoke.sh                                       # one "pong" per model, shows who answered
scripts/opencode.sh                                    # writes opencode/opencode.json for this machine
```

Then copy `opencode/opencode.json` into a project (or merge its `provider` block into
`~/.config/opencode/opencode.json`) and pick `gateway/<model>` in OpenCode.

## Additions (2026-11-20)

- Root `../.env` now carries all provider keys. `secrets/gateway.env` is generated from it; it also adds `GEMINI_API_KEY_ALT` for a second Gemini quota and uses `NVIDIA_API_KEY` as `NVIDIA_NIM_API_KEY`.
- Three CLI logins are staged under `secrets/cli-state/` (git-ignored): Claude, Antigravity (including `~/.config/antigravity` and `~/.cache/antigravity`), and Muse Code (`~/.config/muse` plus its self-updating binary in `muse-bin/`). They are bind-mounted into the container, never baked into the image.
- New CLI models: `muse-cli`, `muse-cli-wonder`, `muse-cli-ember`, `muse-agent`, `muse-agent-contributor`. Muse emits JSONL which `cli_provider.py` parses into streamed text, final text, session id and token usage.
- New preference aliases: `heavy`, `heavy-tool`, `light`, `light-tool`, with ordered fallback chains in `config.yaml`. Agent variants are deliberately excluded from automatic fallback.
- Agent models run in a stable per-conversation subdirectory of `/workspaces/<id>` (host: `${WORKSPACE_DIR}`), so web sessions do not share files.
- `nemotron-super` now points at `nvidia/nemotron-3.5-super-vl-120b-a12b`; the old `nemotron-3-super-120b-a12b` id no longer exists. `nemotron-bolt` was added.
- `AUTHKEY` in the root env is the dashboard password; it is not passed to the gateway.

## Models

| Name in OpenCode | Backend | Notes |
|---|---|---|
| `nemotron-super` (default) | NVIDIA Nemotron 3 Super | Free. Real tool calling, so OpenCode can edit files with it. |
| `nemotron-ultra` | NVIDIA Nemotron 3 Ultra | Free, slower. |
| `nemotron-lightning` (small model) | NVIDIA Nemotron 3.5 Lightning | Used for titles and summaries. |
| `gemini-flash`, `gemini-flash-lite` | Gemini API | Free tier has daily caps; free-tier prompts may be used by Google. |
| `muse-spark` | Meta Muse Spark 1.3 | Paid; runs on the $20 credit. |
| `claude-cli`, `claude-cli-opus` | Claude Code, tools off | Chat and planning. Text only; OpenCode can't run tools through it. |
| `claude-agent` | Claude Code with its own tools | Edits files in `WORKSPACE_DIR` itself and reports back. |
| `agy-cli`, `agy-agent` | Antigravity CLI | Same split as Claude. |

Fallbacks are set up in `gateway/config.yaml`, for example `claude-cli → agy-cli → nemotron-super` and
`nemotron-super → gemini-flash`. So when one model hits a rate limit, the request moves to the next
instead of failing. Agent models have no fallback, so a half-finished edit is never handed to another model.

There's no Microsoft entry: GitHub Models, the free option, was shut down in July 2026. Phi models are
in the NVIDIA catalog if you want them; add them to `config.yaml`.

## How the CLI models work

- **Conversations.** OpenCode resends the whole chat every turn. After each reply the gateway stores
  `hash(chat so far) → CLI session id` in `/state/sessions.db`. On the next turn it hashes everything
  except the newest message. If that hash matches, it resumes the CLI session and sends only the new
  message. Otherwise (new chat, edited history, wiped state) it replays the earlier turns as a
  transcript into a fresh session. `scripts/sessions.sh [list|clear]` shows or resets the map.
- **Tools.** The CLI never sees OpenCode's tools. Chat models run with tools off (`claude --tools ""`;
  agy in an empty sandboxed dir). Agent models use their own tools inside `/workspace`, which is your
  `WORKSPACE_DIR`. It's one fixed folder per gateway, because OpenCode doesn't send its working directory.
- **System prompt.** OpenCode's system prompt describes OpenCode's tools, which would confuse a CLI model,
  so it's dropped by default. Set `CLI_SYSTEM_PROMPT=append` to forward it.
- **Streaming.** Claude streams token by token (`stream-json`). agy replies all at once when it finishes.
- **Limits.** At most `CLI_MAX_PARALLEL` CLI processes run at once, and each is killed after
  `CLI_TIMEOUT_SECONDS`. OpenCode's timeouts in the template are raised to 15 minutes to match.
- **Billing.** Since June 2026, `claude -p` usage comes out of the subscription's separate monthly
  Agent SDK credit, not your interactive Claude Code limits.

## Files

| Path | What |
|---|---|
| `gateway/cli_provider.py` | LiteLLM custom provider (`cli/…` models) |
| `gateway/config.yaml` | Model list, fallbacks, master key |
| `gateway/tools/*.py` | check / smoke / sessions helpers (run in the `cli` tool container) |
| `secrets/gateway.env` | All secrets, runtime-only (`env_file`, never a build arg) |
| `secrets/opencode.key` | Gateway key for OpenCode, read via `{file:…}` |
| `.env` | Non-secret compose settings |

Named volumes: `claude-config` (Claude settings and sessions), `agy-config` (Antigravity login and
conversations), `gateway-state` (session map).

## Gotchas

- **Untested pieces.** The Docker build hasn't been run end to end. The Antigravity installer's target
  folder isn't documented, so the Dockerfile searches for the `agy` binary after installing. If the build
  breaks there, set `INSTALL_AGY=0`.
- **Large prompts.** Prompts over ~100 KB are piped to `agy` on stdin, because Linux limits a single argv
  string to 128 KiB. This relies on agy running non-interactively when stdin isn't a TTY.
- **Model ids drift.** `scripts/check.sh` flags missing ids. Fix them in `config.yaml`.
- **Account risk.** Google has suspended accounts for driving Antigravity logins from third-party tools,
  and Anthropic restricts subscription use outside its own apps. This uses the official CLIs, but if you
  care about an account, keep it out of the gateway.
