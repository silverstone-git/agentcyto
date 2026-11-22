# Knowledge Base (KB)

SQLite/FTS5 KB compiled from `repo/physics/`: design, tables, API, UI, verified results and chat retrieval.

> Section numbers (§N) are preserved from the former monolithic `AGENTS.md` so older references still resolve.

## 9. Knowledge Base (KB)

The KB is a BFF extension that compiles the physics Markdown sources in `repo/physics/` into a
queryable mathematical knowledge base, all inside SQLite (no vector/graph DB). It gives full
ingestion/search control from the web page.

### 9.1 Design principles

- **No user uploads.** Ingestion is admin-controlled from the KB tab in the static UI. The source
  Markdown files are never modified; they are mounted read-only into the BFF at `/kb-source`.
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
- **Admin page** (`/admin`, soft password `apple`): Ingest / Update, Rebuild from scratch, Clear all
  KB data, live counts, document list, full-text search.

Details of the frontend live in `bff-and-frontend.md`.

### 9.5 Container & env changes

- `cli-gateway/docker-compose.yml`: mounts `../repo/physics:/kb-source:ro` into the `bff` service
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

After any parser change: rebuild the BFF image and `POST /api/kb/reindex` (about 4 minutes).

### 9.8 Retrieval in chat (`retrieve_kb_context` in `app.py`)

When a chat request carries `kb_docs`, the job worker searches those docs before calling the model:

1. Extract up to 10 keywords from the latest user message (stop-word filtered).
2. Search 1: FTS5 `AND` of the first 4 terms; if fewer than 3 hits, Search 2: `OR` of all terms
   with prefix match. Each search runs `kb_search_fts` per document (bm25 rank). Heading nodes
   (`document/chapter/section/subsection/subsubsection`) are dropped in favour of real passages.
3. Top ≤ 8 passages (≤ 9,000 chars total, each ≤ 1,200 chars; equations use their LaTeX) are
   prepended to the **last user message** as `[n] (type; doc / section; lines a-b)` blocks.
   They are *not* sent as a system message because CLI-backed models drop system messages.
4. Streamed SSE events: `trace` (decision / method / search / error steps with the exact MATCH
   query) and `retrieval` (method, terms, hits with full text, node ids). The UI renders them in a
   collapsible "Knowledge-base retrieval" panel and turns `[n]` in the answer into clickable
   citation chips that open the source passage.

No shell command and no embeddings are involved. Retrieval failures never fail the job.
