# Knowledge Base (KB)

SQLite/FTS5 KB compiled from `repo/physics/`: design, tables, API, UI, verified results and chat retrieval.

> Section numbers (§N) are preserved from the former monolithic `AGENTS.md` so older references still resolve.

## 9. Knowledge Base (KB)

The KB is a BFF extension that compiles the physics Markdown sources in `repo/physics/` into a
queryable mathematical knowledge base, all inside SQLite (no vector/graph DB). It gives full
ingestion/search control from the web page.

### 9.0 Skills (one folder per subject)

The KB source is `repo/`, mounted **read-write** at `/kb-source` (since 2026-11-23, so the admin page can
create skills and upload files). Every top-level folder is a **skill**
(`repo/physics/`, `repo/history/`, `repo/geography/`, `repo/chemistry/`, ...). Markdown files inside a
skill folder are found recursively; files directly in the source root belong to `KB_DEFAULT_SKILL`
(default `physics`), so the old mount (`repo/physics` as the root) keeps working unchanged.

- `kb_documents.skill` holds the skill (added by a lightweight migration; older rows are backfilled
  with `KB_DEFAULT_SKILL` at startup).
- Document ids: the default skill keeps bare file-stem ids (existing chats and attachments still
  resolve); other skills are prefixed, e.g. `history-ncert-class7`.
- `GET /api/kb/skills` → `{skills: [{skill, title, documents, nodes, equations, source_files, updated}], default}`.
  Lists folders on disk even before they are ingested. It also accepts the server-to-server bearer
  (like `/api/retrieve`), so outstagram can show students the available skills.
- `POST /api/kb/ingest?skill=history` ingests one skill only.
- `POST /api/retrieve` takes `skills: ["history"]` to search only those skills.
- Chat: `POST /api/chat` takes `kb_skills: [...]`; every document of those skills is attached (deduplicated with
  `kb_docs`, capped at 60 documents). The KB menu in the chat composer groups documents by skill with a
  "whole skill" toggle; the admin page shows a Skills panel with per-skill ingest.

**Adding a subject:** Admin → *Create a skill* → drop the Markdown files onto the upload area. With
"Ingest automatically after upload" on (the default) the skill is ingested as soon as the upload batch
finishes. The shell route still works: `mkdir repo/history && cp *.md repo/history/`, then press *Ingest*
(or `POST /api/kb/ingest?skill=history`). No restart needed.

**Skill / file management API** (behind nginx basic auth only — none of these paths is a bearer
`SERVICE_PATH`, and the create route deliberately is *not* `POST /api/kb/skills`, which nginx exposes
without basic auth):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/kb/skills/{skill}` | POST | create the folder `repo/<skill>/` (slug `[a-z0-9-]`, 409 if it exists) |
| `/api/kb/skills/{skill}` | DELETE | drop the skill's documents from the index **and delete its folder** |
| `/api/kb/skills/{skill}/files` | GET | files on disk with state `ready / new / changed / failed / missing` |
| `/api/kb/skills/{skill}/files/{name}?offset=N[&final=true]` | PUT | chunked upload (raw body) |
| `/api/kb/skills/{skill}/files/{name}` | DELETE | delete the source file and its indexed document |

Uploads are chunked (the UI sends 512 KB per request) because nginx keeps its default 1 MB
`client_max_body_size`. Chunks are appended to a hidden `.upload-<name>.part` file (ignored by
ingestion); the final chunk is checked for UTF-8 and atomically renamed. File names must match
`[\w\-. ()&,'+]{1,150}\.md`; total size is capped by `KB_UPLOAD_MAX_MB` (default 200).
Only one ingestion runs at a time: ingest/reindex/clear/delete return 409 while one is active.
`GET /api/kb/status` reports `writable` and `active_ingestion: {id,total,done,current,failed}`
(live per-file progress, also in `GET /api/kb/ingestions/{id}` → `progress`).

**Moving to the multi-skill mount (one-time, on the agentcyto box):** the compose file now mounts `../repo`
instead of `../repo/physics`. Physics files stay in `repo/physics/`, so their ids do not change; run
`docker compose up -d bff` and nothing needs re-ingesting (the `source_path` column refreshes on the next ingest).
nginx: let outstagram's bearer reach the skills list as well as retrieval, before `location /agentcyto/`:

```nginx
location = /agentcyto/api/kb/skills {
    auth_basic off;
    proxy_pass http://127.0.0.1:8890/api/kb/skills;
    proxy_set_header X-Auth-User "";   # no basic auth here: drop spoofed headers (see bff-and-frontend.md)
    add_header Cache-Control "no-store" always;
}
```

### 9.1 Design principles

- **Admin-only uploads.** Skills and files are created, uploaded and deleted only from the
  password-gated admin page (behind nginx basic auth). Chat users never write to the source. The
  parser never modifies source files; repo/* is git-ignored, so deleting a file from the admin page
  is permanent.
- **SQLite-only.** All derived data lives in `kb_*` tables in `agentcyto/state/agentcyto.db`
  (WAL mode). Full-text search uses SQLite FTS5 (`kb_node_fts`).
- **Three provenance categories preserved independently:** source facts, extracted structure,
  inferred knowledge — each node carries `provenance` (`extracted`/`inferred`) and `confidence`
  (0–1) fields.
- **Idempotent.** Re-ingestion skips files whose SHA-256 is unchanged; `force=true` rebuilds from
  scratch.
- **Structural compiler pattern.** Documents compile into a tree of
  `document → chapter → section → subsection → paragraph` plus first-class `equation`,
  `theorem`, `proof`, `definition`, `example`, `derivation` nodes with typed edges
  (`contains`, `references`, `defines`, `uses_symbol`, `follows_step`, `derived_from`, `part_of`).

### 9.2 KB tables (in `agentcyto/bff/db.py`)

| Table | Contents |
|---|---|
| `kb_documents` | one row per ingested `.md` (id, path, hash, size, status, node/equation counts) |
| `kb_nodes` | structural nodes (id, document_id, type, title, content, latex, label, line range, parent, ordinal, provenance, confidence) |
| `kb_node_edges` | typed edges between nodes (source_id, target_id, rel_type, properties JSON) |
| `kb_symbols` | symbol inventory per document (symbol, normalized, meaning context) |
| `kb_symbol_occurrences` | where each symbol appears (node, line range, context) |
| `kb_concepts` | named concepts (symbols, section IDs JSON) |
| `kb_derivations` | derivation records (assumptions JSON) |
| `kb_derivation_steps` | ordered steps within a derivation |
| `kb_references` | equation/section/theorem references extracted from text |
| `kb_node_fts` | FTS5 virtual table over node content + title (bm25 ranking) |
| `kb_ingestions` | ingestion run log (status, files_found/ingested/skipped, nodes_created, timestamps) |

### 9.3 KB API endpoints (all require `X-Auth-User`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/kb/status` | GET | source dir, file/doc/node/equation/symbol counts, latest ingestion |
| `/api/kb/ingest` | POST | ingest all `.md` files (idempotent, runs in background) |
| `/api/kb/reindex` | POST | wipe all KB data and re-ingest from scratch |
| `/api/kb/clear` | DELETE | delete all KB data |
| `/api/kb/documents` | GET | list ingested documents |
| `/api/kb/documents/{id}` | GET | document + node tree |
| `/api/kb/documents/{id}` | DELETE | remove a document and all derived rows |
| `/api/kb/search` | GET | FTS5 full-text search (`q`, optional `type`/`doc`/`limit`) |
| `/api/kb/nodes/{id}` | GET | node + children + edges + document |
| `/api/kb/equations` | GET | list equation nodes (optional `doc`) |
| `/api/kb/symbols` | GET | list symbols with occurrence counts (optional `doc`) |
| `/api/kb/symbols/{id}/occurrences` | GET | where a symbol appears |
| `/api/kb/derivations` | GET | list derivations with steps |
| `/api/kb/concepts` | GET | list concepts |
| `/api/kb/stats` | GET | node counts by type |
| `/api/kb/enrich` | POST | LLM section summaries via gateway (optional enrichment) |
| `/api/kb/ingestions` | GET | ingestion run history |
| `/api/kb/ingestions/{id}` | GET | single ingestion run details |

### 9.4 KB UI (React frontend)

KB *editing* can never happen from the chat page:

- **Chat page:** a `+` button inside the message composer opens a checklist of ingested KB documents
  (All / None). Attached docs show as chips above the input (one row; extra ones collapse into
  "+N more"), the placeholder changes, and the doc ids are sent as `kb_docs` with each chat request.
  The sidebar also lists the docs for quick toggling.
- **Admin page** (`/admin`, soft password `apple`, remembered for the browser tab): titled
  **Knowledge Bank** — users never see "KB". There's a skills list (or a horizontal scroller on mobile)
  and a selected-skill panel with a 3-step tracker (Add documents → Ingest → Use in chat), a drag-and-drop
  upload area with per-file progress, an auto-ingest toggle, and a document list with per-file state
  badges and remove. A live ingestion banner shows progress. Create-skill and confirm dialogs replace
  `window.confirm`; deleting a skill needs its name typed. The collapsible *Tools* section has test
  search, rebuild everything, and clear index (type `clear`).

Details of the frontend live in `bff-and-frontend.md`.

### 9.5 Container & env changes

- `cli-gateway/docker-compose.yml`: mounts `../repo:/kb-source` (read-write since 2026-11-23; originally `../repo/physics:/kb-source:ro`) into the `bff` service
  and sets `KB_SOURCE_DIR=/kb-source`.
- `agentcyto/bff/Dockerfile`: copies `kb.py` into the image.
- `agentcyto/bff/requirements.txt`: no new dependencies (uses built-in `re` + existing `httpx`).

### 9.6 Verified results (after the 2026-11-22 parser fix, see 9.7)

Full reindex of the 13 physics Markdown files (~26 MB):
- 13 documents, **103,039 nodes, 27,375 equations, 1,452 symbols**
- Node types: paragraph (70,960), equation (27,375), subsection (2,496), section (1,042),
  subsubsection (857), chapter (155), example (153), theorem (1)
- Per-book equations now match the number of `$$…$$` pairs in the source: Feynman Vol. 1/2/3 =
  4,827 / 2,118 / 1,568, Shankar 3,084, Hassani 4,456, Pathria 3,058, Atkins 2,057, …
  (Atkins, Hassani and a few others are a few percent below their `$$` pair count; not yet traced.)
- Re-ingestion skips unchanged files (hash-based)

### 9.7 Ingestion bugs fixed (2026-11-22)

Symptom: Feynman Vol. 1/2/3 reported 13 / 1 / 20 equations although the sources contain thousands,
and all three volumes were titled "Feynman".

1. **Lost one-line equations.** In `kb.py` `_ParserState.parse`, a single-line `$$ … $$` filled
   `math_buffer` but never set `in_math = True`, so `flush_math()` returned early and dropped it.
   Only multi-line display math survived. Fix: set `in_math = True` before flushing.
   (Previous total of 1,320 equations across all books was caused by this.)
2. **Equation numbers on the next line.** Feynman prints `(9.5)` on the line after the equation.
   New `STANDALONE_LABEL_RE` attaches it to the preceding equation node (within 2 lines).
3. **Generic / duplicate titles.** Title was the first heading, which is "Feynman" or
   "The Feynman" in all three volumes. `KB._pick_title` now falls back to a prettified file name
   (e.g. "Feynman Vol. 3 Quantum Mechanics") when the heading is shorter than 12 chars, matches
   "lectures on physics", or is already used by another document.

4. **Headings were chained to their previous sibling.** `_add_heading` read `current_section_id()`
   *before* popping the section stack, so every heading's `parent_id` (and `contains` edge) pointed at
   the previous heading: the "tree" was a linked list ~500 deep. Fixed in the parser; existing rows
   are repaired without re-ingesting by `KB.repair_heading_parents()` (3,722 rows fixed).
5. **FTS index v2** (`kb_meta.fts_version = 2`): porter stemming (`tokenize='porter unicode61'`),
   the `title` column now holds the breadcrumb (`Doc › Chapter › Section › …`, bm25 weight 0.5) and
   back-of-book index pages, TOCs, bibliographies and symbol lists are left out (`is_junk_node`:
   nearest heading is one of those, or ≥5 page references per ~200 chars). 101,778 rows indexed.
   `DB.__init__` drops a pre-v2 FTS table and the BFF runs `KB.migrate_index()` once in the
   background at startup (~15 s; FTS rebuilds commit per 4,000 rows so the WAL stays small; a single
   transaction previously grew the WAL past 1 GB).

After any parser change: rebuild the BFF image and `POST /api/kb/reindex` (about 4 minutes).

### 9.8 Retrieval in chat (`agentcyto/bff/retrieval.py`, `websearch.py`)

Runs before the model call whenever a chat request carries `kb_docs` or `web_search: true`.
Per-turn options: `llm_search` (default **true**; UI: *LLM-assisted search* in the model menu) and
`web_search` (default false; UI: globe button + green "Web search on" chip in the composer).
Tunables live under `retrieval:` in `modes.yaml` (model, budgets, rounds, passage sizes).

1. **Probe**: stemmed FTS5 OR-search over the question terms (stop-words removed; follow-ups with
   < 3 terms inherit terms from the previous user turn). Hits are counted per enclosing heading.
2. **Plan** (LLM): the planner model (`gemini-flash-lite` by default, ~2 s) receives the question,
   the last 4 turns and a **budgeted outline** of every attached document: headings with short ids
   (`S12`), nesting by indentation, `*N hits` marks from the probe (≤ 60k chars total; deepest
   level that fits per document plus all hot headings and their ancestors). It returns JSON:
   `queries` (FTS keyword queries with synonyms), `sections` (heading ids), `equation_labels`,
   `web_queries`, `kb_needed`, `notes`. This is what makes the structure visible to the LLM.
3. **Search**: every query runs document-wide (AND, falling back to OR) and inside each target
   section's subtree (ordinal range `heading.ordinal < n.ordinal < heading.end`); each target
   section's opening passages are added; equation labels are looked up directly. Lists are fused
   with weighted reciprocal-rank fusion.
4. **Expand**: each hit becomes a passage with neighbouring paragraphs/equations from the same
   section (an equation always gets its introducing sentence), ≤ ~1,800 chars, with its breadcrumb.
5. **Web** (optional, concurrent): Brave Search → top 5 pages fetched (`websearch.fetch_page`:
   http(s) only, every redirect hop must resolve to public IPs, 2 MB cap; Wikipedia via the REST
   Parsoid HTML endpoint with LaTeX recovered from `<math data-mw>`; other pages via a stdlib HTML
   extractor that drops nav/footer/reference markers) → best paragraphs by term overlap. Brave's
   snippets are used when a page cannot be fetched.
6. **Rerank** (LLM): the model sees up to 36 KB passages + all web passages and returns the ones that
   answer the question in reading order (≤ 8 KB, ≤ 5 web) with a short reason each; it may request
   one more search round (`max_rounds: 2`).

With `llm_search: false` (or if the LLM call fails) steps 2 and 6 are skipped and fused bm25/RRF order
decides. Planner/reranker tokens are recorded in `usage` as `retrieval:plan` / `retrieval:rerank`.

Passages are prepended to the **last user message** (CLI-backed models drop system messages) as
`[n] KB · Doc › Chapter › Section [type; lines a-b]` or `[n] WEB · Title (site) › heading` + `URL:`;
web text is framed as untrusted data. SSE: `trace` steps (`decision`, `search`, `plan`, `llm`,
`rerank`, `web`, `error`) and one `retrieval` event (`hits[]` with `kind: kb|web`, `path`, `url`,
`site`, `why`; `counts`, `method`). The UI renders a "Retrieval" panel, blue chips for KB and green
chips for web citations, and a clickable "Web sources" footer under the answer.

Measured (Shankar + Atkins, "derive hydrogen energy levels"): old flow returned index fragments and
exercises; v2 lexical returns the right sections in ~0.5 s; LLM-assisted returns §13.1 in reading
order (setup → radial equation → series → quantisation → $E_n$) in ~5–7 s. `gemini-flash` gives
similar picks but takes 60 s+ per call (thinking), so it is not the default.

No shell command and no embeddings are involved. Retrieval failures never fail the job.
