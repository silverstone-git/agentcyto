# BFF and React frontend

The BFF (`agentcyto/bff/`) owns sessions, durable jobs, SSE replay, budget and KB retrieval, and
serves the built UI. The UI source is `agentcyto/frontend/` (React 19 + Vite + TypeScript +
Tailwind CSS v4); the build output goes to `agentcyto/ui/` (committed) and is baked into the BFF image.

## BFF

| File | Role |
|---|---|
| `bff/app.py` | FastAPI routes, job worker (`run_job`), SSE, KB API, KB retrieval, SPA fallback |
| `bff/db.py` | SQLite schema + helpers (sessions, messages, jobs, job_events, usage, `kb_*`) |
| `bff/kb.py` | KB ingestion (see `knowledge-base.md`) |
| `bff/byok.py` | Bring-your-own-key upstreams (OpenAI-compatible, Anthropic, Gemini): streaming, model listing, SSRF guard |
| `bff/modes.yaml` | mode → alias map, budget, price estimates |

### Chat API
`POST /api/chat` body: `message`, `mode`, `role` (`chat`|`agent`), optional `session_id`, `name`,
`model`, `idempotency_key`, `kb_docs: [doc ids]`, `reply_to: {role, content}`.

- A session is created on the first message (named from it, 48 chars). The UI no longer creates
  empty sessions; "New chat" only resets local state.
- `reply_to` is folded into the stored user message as
  `[In reply to my|the assistant's earlier message: "<quote ≤600 chars>"]\n\n<text>`. The UI parses
  that wrapper to show a quote chip, so history reloads look identical.
- `jobs.kb_docs` (JSON text column) is added by a lightweight `ALTER TABLE` migration in `DB.__init__`.

`/api/chat` also accepts `system_prompt` (appended to the base prompt), `temperature`, `max_tokens`
and `byok: {api_type: openai|anthropic|gemini, base_url, api_key, model, label}`. With `byok` the BFF calls
the user's provider directly (chat only, no agent role, zero budget cost). The API key is kept **in memory
only** (`_byok_keys[job_id]`), never written to SQLite/events/logs; a restart mid-job fails it with a
"resend" message. `base_url` must resolve to public addresses (loopback/private/link-local blocked).
Non-secret options are stored in `jobs.options` (JSON).

### Search, context and BYOK API
- `GET /api/search?q=` — case-insensitive substring search over chat titles and message text.
- `POST /api/sessions/{id}/compress` `{action: summarize|clear, model?, byok?}` — marks live messages
  `archived=1` (still shown, dimmed, but excluded from `get_history`) and appends a `system` message holding
  the summary (empty for `clear`); also resets native CLI sessions. 409 while a job is running.
- `POST /api/byok/models` `{byok}` — lists the provider's models (doubles as a key test).

### Session API
`GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/{id}`, and
`POST /api/sessions/{id}/autoname` — sends the first ≤4 messages to the `light` alias
(non-streaming) and stores a 2–6 word title (HTTP 502 if the gateway fails).
`GET /api/sessions` includes a `messages` count; the UI hides sessions with 0 messages.

### SSE events (`GET /api/stream?job_id=&after=`)
`status`, `trace` (KB steps), `retrieval` (hits), `thinking` (model reasoning_content, when the
upstream exposes it — NIM models do, CLI models do not), `delta` (answer text, carries `attempt`),
`done` (final text, model, usage), `job_error`, `stream_error`. Events are journaled in
`job_events`, so a reconnect with `after=<last id>` replays them.

## Frontend

```
agentcyto/frontend
├── index.html, vite.config.ts   # base: '/agentcyto/', @tailwindcss/vite plugin, dev proxy /api → :8890
├── public/                      # favicon.svg, icons.svg (copied to ui/)
└── src
    ├── App.tsx                  # BrowserRouter; basename = PREFIX ('/agentcyto' on the public host, '' in dev)
    ├── lib/prefix.ts            # PREFIX detection (used by every fetch/SSE URL)
    ├── lib/api.ts               # typed API client
    ├── components/layout/       # Shell.tsx (nav drawer), nav.tsx (NavContext + MenuButton)
    ├── components/chat/         # MessageBubble, Markdown (+KaTeX), Trace, CitationModal
    ├── pages/                   # ChatPage, StatusPage, AdminPage
    └── index.css                # Tailwind v4 @theme tokens (--color-*), markdown + citation-chip styles
```

### Behaviour worth knowing
- **Prefix:** nginx strips `/agentcyto/`; Vite `base` is `/agentcyto/` so asset URLs resolve; at runtime
  `PREFIX` is derived from `location.pathname` so the same build also works at `/` locally.
- **Tailwind v4:** theme variables must be `--color-*` for utilities like `bg-surface-base`;
  `tailwind.config.js` is legacy and ignored by v4.
- **Streaming:** a single live "turn" (`text`, `thinking`, `trace`, `retrieval`) is kept in a ref +
  state; on `done` it is committed to `messages` with `meta` so panels persist while the page is open.
  (Retrieval/trace panels and citation chips are not persisted across a reload.)
- **Markdown/LaTeX** (`Markdown.tsx`): react-markdown + remark-gfm + remark-math + rehype-katex.
  Normalisation: `\(..\)`/`\[..\]` → `$`/`$$`; dangling odd `$$` dropped; every `$$…$$` becomes its
  own display block; bare `\begin{…}…\end{…}` blocks are wrapped. `[n]` → clickable `.cite-chip`.
- **Composer:** `+` opens the KB checklist; KB chips (one row + "+N more"); reply bar; Enter sends.
- **Reply:** swipe a bubble right (touch) or use the hover button (desktop).
- **Session menu:** per-chat `…` → Rename (inline), Auto-name with AI, Delete (confirm). Rendered in a
  portal on `<body>` (position fixed, flips upward near the bottom) so the scrolling list never clips it.
- **History panel** (left of chat): Search chats (modal, `/api/search`), chat list, "Bring your own key"
  (`ProvidersModal`). There is no KB panel here; KB attach lives in the composer `+` menu. It slides
  (transform transition) on mobile; the top-bar button is a chat-bubble icon.
- **Composer:** next to Send, a context button (compress/clear) and a model/settings button (`ModelMenu`:
  provider, mode, role, model, system instructions, temperature, max tokens). Settings persist in
  localStorage `agentcyto.settings`; BYOK providers (including keys) in `agentcyto.providers`
  (`lib/providers.ts` holds the presets: OpenAI, Anthropic, Gemini, OpenRouter, Groq, Together, Mistral,
  DeepSeek, xAI, Fireworks, Perplexity, Cerebras, NVIDIA NIM, Moonshot, Cohere, custom).
- **Layout:** the document never scrolls (`html/body/#root` are `height:100%; overflow:hidden`);
  only message list and panels scroll. Mobile: nav is an off-canvas drawer opened by the menu button
  in the top bar; sessions/KB panel is a drawer that closes when a chat is picked.

## Build and deploy

```sh
cd agentcyto/frontend && npm ci && npm run build          # writes ../ui (emptyOutDir)
cd ../.. && docker compose --project-directory cli-gateway build bff
docker compose --project-directory cli-gateway up -d bff
```

The BFF image copies `ui/` at build time, so **a frontend change is not live until the `bff` image is
rebuilt**. Debug visually with Playwright (`node_modules/playwright` in `agentcyto/frontend`),
logging in to the public URL with basic auth (`agentcyto` / `AUTHKEY`; never print the key).
