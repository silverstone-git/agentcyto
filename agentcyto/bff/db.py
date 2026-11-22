"""SQLite persistence for the agentcyto BFF.

The database lives on its own volume so transcripts, jobs and usage survive a
container restart. All access is synchronous and short; the BFF is single-user
so a plain connection per thread is sufficient.
"""

import json
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("AGENCYTO_DB", "/state/agentcyto.db")
GATEWAY_SESSION_DB = os.environ.get("GATEWAY_SESSION_DB", "/gateway-state/sessions.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created REAL NOT NULL,
  updated REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  created REAL NOT NULL,
  job_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  resolved_model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created REAL NOT NULL,
  updated REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem
  ON jobs(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, seq);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  resolved_model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0,
  created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created);

CREATE TABLE IF NOT EXISTS health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked REAL NOT NULL,
  gateway_ok INTEGER NOT NULL,
  detail TEXT
);

-- ---------------- Knowledge base (mathematical document compiler) ----------

CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,                  -- doc_id, e.g. "atkins05"
  source_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  title TEXT,
  file_hash TEXT NOT NULL,              -- SHA-256 of file content
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/ingested/failed/error
  error TEXT,
  ingested_at REAL,
  node_count INTEGER DEFAULT 0,
  equation_count INTEGER DEFAULT 0,
  created REAL NOT NULL,
  updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_status ON kb_documents(status);

CREATE TABLE IF NOT EXISTS kb_nodes (
  id TEXT PRIMARY KEY,                  -- node_id, e.g. "atkins05:section-1"
  document_id TEXT NOT NULL,
  type TEXT NOT NULL,                   -- document, chapter, section, subsection, paragraph, equation, theorem, proof, definition, example, derivation
  title TEXT,
  content TEXT,                         -- raw text content
  latex TEXT,                           -- original LaTeX for equation nodes
  label TEXT,                           -- equation/theorem number, e.g. "3.1"
  line_start INTEGER,
  line_end INTEGER,
  parent_id TEXT,
  ordinal INTEGER,                      -- order among siblings
  provenance TEXT DEFAULT 'extracted',  -- extracted / inferred
  confidence REAL DEFAULT 1.0,
  created REAL NOT NULL,
  FOREIGN KEY (document_id) REFERENCES kb_documents(id),
  FOREIGN KEY (parent_id) REFERENCES kb_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_doc ON kb_nodes(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_parent ON kb_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_type ON kb_nodes(type);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_label ON kb_nodes(label);

CREATE TABLE IF NOT EXISTS kb_node_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,               -- contains, references, defines, uses_symbol, follows_step, derived_from, part_of
  properties TEXT,                      -- JSON
  FOREIGN KEY (source_id) REFERENCES kb_nodes(id),
  FOREIGN KEY (target_id) REFERENCES kb_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_edges_source ON kb_node_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_kb_edges_target ON kb_node_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_kb_edges_type ON kb_node_edges(rel_type);

CREATE TABLE IF NOT EXISTS kb_symbols (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,                 -- e.g. "\phi", "H", "\hbar"
  document_id TEXT NOT NULL,
  normalized TEXT,                      -- normalized search form
  meaning_context TEXT,                 -- section-specific meaning hint
  occurrence_count INTEGER DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES kb_documents(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_symbols_doc ON kb_symbols(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_symbols_symbol ON kb_symbols(symbol);

CREATE TABLE IF NOT EXISTS kb_symbol_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  context TEXT,
  line_start INTEGER,
  line_end INTEGER,
  FOREIGN KEY (symbol_id) REFERENCES kb_symbols(id),
  FOREIGN KEY (node_id) REFERENCES kb_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_sym_occ_symbol ON kb_symbol_occurrences(symbol_id);
CREATE INDEX IF NOT EXISTS idx_kb_sym_occ_node ON kb_symbol_occurrences(node_id);

CREATE TABLE IF NOT EXISTS kb_concepts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  associated_symbols TEXT,              -- JSON array of symbol ids
  section_ids TEXT,                     -- JSON array of section node ids
  provenance TEXT DEFAULT 'inferred',   -- extracted / inferred
  confidence REAL DEFAULT 0.0,
  FOREIGN KEY (document_id) REFERENCES kb_documents(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_concepts_doc ON kb_concepts(document_id);

CREATE TABLE IF NOT EXISTS kb_derivations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  title TEXT,
  result_node_id TEXT,
  assumptions TEXT,                     -- JSON array of assumption node ids
  provenance TEXT DEFAULT 'inferred',
  confidence REAL DEFAULT 0.0,
  FOREIGN KEY (document_id) REFERENCES kb_documents(id),
  FOREIGN KEY (section_id) REFERENCES kb_nodes(id),
  FOREIGN KEY (result_node_id) REFERENCES kb_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_derivations_section ON kb_derivations(section_id);

CREATE TABLE IF NOT EXISTS kb_derivation_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  derivation_id TEXT NOT NULL,
  step_ordinal INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT,
  FOREIGN KEY (derivation_id) REFERENCES kb_derivations(id),
  FOREIGN KEY (node_id) REFERENCES kb_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_deriv_steps_deriv ON kb_derivation_steps(derivation_id);

CREATE TABLE IF NOT EXISTS kb_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,               -- equation, section, theorem
  ref_target TEXT,                      -- e.g. "3.1", "Section 2.4"
  resolved_node_id TEXT,
  FOREIGN KEY (document_id) REFERENCES kb_documents(id),
  FOREIGN KEY (source_node_id) REFERENCES kb_nodes(id),
  FOREIGN KEY (resolved_node_id) REFERENCES kb_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_kb_refs_source ON kb_references(source_node_id);

-- Standalone FTS5 index over node content (managed manually on ingest/reindex).
CREATE VIRTUAL TABLE IF NOT EXISTS kb_node_fts USING fts5(node_id, content, title);

-- Ingestion run log (one row per ingestion trigger).
CREATE TABLE IF NOT EXISTS kb_ingestions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                 -- queued/running/done/blocked
  started_at REAL NOT NULL,
  finished_at REAL,
  files_found INTEGER DEFAULT 0,
  files_ingested INTEGER DEFAULT 0,
  files_skipped INTEGER DEFAULT 0,
  nodes_created INTEGER DEFAULT 0,
  error TEXT,
  created REAL NOT NULL
);
"""


class DB:
    def __init__(self, path: str = DB_PATH):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._local = threading.local()
        with self.conn() as c:
            c.executescript(SCHEMA)
            try:  # lightweight migration: KB docs attached to a job
                c.execute("ALTER TABLE jobs ADD COLUMN kb_docs TEXT")
            except sqlite3.OperationalError:
                pass

    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA busy_timeout=30000")
            self._local.conn = c
        return c

    # -- sessions --------------------------------------------------------- #
    def create_session(self, session_id: str, name: str = "") -> dict:
        now = time.time()
        with self.conn() as c:
            c.execute("INSERT INTO sessions (id,name,created,updated) VALUES (?,?,?,?)",
                      (session_id, name, now, now))
        return self.get_session(session_id)

    def list_sessions(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS messages "
                "FROM sessions s ORDER BY s.updated DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_session(self, session_id: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        return dict(row) if row else None

    def touch_session(self, session_id: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE sessions SET updated=? WHERE id=?", (time.time(), session_id))

    def rename_session(self, session_id: str, name: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE sessions SET name=?, updated=? WHERE id=?",
                      (name[:200], time.time(), session_id))

    def delete_session(self, session_id: str) -> None:
        with self.conn() as c:
            for table in ("job_events", "usage", "jobs", "messages", "sessions"):
                c.execute(f"DELETE FROM {table} WHERE " + (
                    "job_id IN (SELECT id FROM jobs WHERE session_id=?)" if table == "job_events"
                    else "session_id=?" if table in ("usage", "jobs", "messages")
                    else "id=?"), (session_id,))

    # -- messages --------------------------------------------------------- #
    def add_message(self, session_id: str, role: str, content: str,
                    model: str | None = None, job_id: str | None = None) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO messages (session_id,role,content,model,created,job_id) VALUES (?,?,?,?,?,?)",
                (session_id, role, content, model, time.time(), job_id),
            )
            c.execute("UPDATE sessions SET updated=? WHERE id=?", (time.time(), session_id))

    def get_history(self, session_id: str) -> list[dict]:
        """Canonical history sent upstream: system prompts are added by BFF."""
        with self.conn() as c:
            rows = c.execute(
                "SELECT role, content FROM messages WHERE session_id=? ORDER BY id", (session_id,)
            ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in rows]

    def get_messages(self, session_id: str) -> list[dict]:
        with self.conn() as c:
            rows = c.execute("SELECT * FROM messages WHERE session_id=? ORDER BY id", (session_id,)).fetchall()
        return [dict(r) for r in rows]

    # -- jobs ------------------------------------------------------------- #
    def create_job(self, job_id: str, session_id: str, mode: str, role: str,
                   model: str, idempotency_key: str | None,
                   kb_docs: list[str] | None = None) -> None:
        now = time.time()
        with self.conn() as c:
            c.execute(
                "INSERT INTO jobs (id,session_id,mode,role,model,status,idempotency_key,created,updated,kb_docs) "
                "VALUES (?,?,?,?,?,'queued',?,?,?,?)",
                (job_id, session_id, mode, role, model, idempotency_key, now, now,
                 json.dumps(kb_docs) if kb_docs else None),
            )

    def get_job(self, job_id: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return dict(row) if row else None

    def find_idempotent_job(self, session_id: str, key: str) -> dict | None:
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM jobs WHERE session_id=? AND idempotency_key=?", (session_id, key)
            ).fetchone()
        return dict(row) if row else None

    def update_job(self, job_id: str, **fields) -> None:
        allowed = {"status", "error", "resolved_model", "attempts", "model"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return
        updates["updated"] = time.time()
        sql = ", ".join(f"{k}=?" for k in updates)
        with self.conn() as c:
            c.execute(f"UPDATE jobs SET {sql} WHERE id=?", (*updates.values(), job_id))

    def jobs_for_session(self, session_id: str, limit: int = 50) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM jobs WHERE session_id=? ORDER BY created DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def recoverable_jobs(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM jobs WHERE status IN ('queued','running','partial') ORDER BY created"
            ).fetchall()
        return [dict(r) for r in rows]

    # -- events ----------------------------------------------------------- #
    def add_event(self, job_id: str, event_type: str, data: dict) -> int:
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO job_events (job_id,type,data,created) VALUES (?,?,?,?)",
                (job_id, event_type, json.dumps(data), time.time()),
            )
            return int(cur.lastrowid)

    def get_events_after(self, job_id: str, seq: int) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 500",
                (job_id, seq),
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["data"] = json.loads(d["data"])
            out.append(d)
        return out

    # -- usage / health --------------------------------------------------- #
    def record_usage(self, job_id: str, session_id: str, model: str, resolved_model: str | None,
                     prompt_tokens: int, completion_tokens: int, estimated_usd: float) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO usage (job_id,session_id,model,resolved_model,prompt_tokens,"
                "completion_tokens,estimated_usd,created) VALUES (?,?,?,?,?,?,?,?)",
                (job_id, session_id, model, resolved_model, prompt_tokens,
                 completion_tokens, estimated_usd, time.time()),
            )

    def spend_since(self, since: float) -> float:
        with self.conn() as c:
            row = c.execute("SELECT COALESCE(SUM(estimated_usd),0) FROM usage WHERE created>=?",
                            (since,)).fetchone()
        return float(row[0])

    def usage_recent(self, limit: int = 100) -> list[dict]:
        with self.conn() as c:
            rows = c.execute("SELECT * FROM usage ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    def record_health(self, ok: bool, detail: str) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO health (checked,gateway_ok,detail) VALUES (?,?,?)",
                      (time.time(), int(ok), detail[:500]))


    # -- knowledge base ----------------------------------------------------- #

    def kb_set_ingestion(self, ingestion_id: str, status: str, **fields) -> None:
        allowed = {"files_found", "files_ingested", "files_skipped",
                   "nodes_created", "error", "finished_at"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        updates["status"] = status
        sql = ", ".join(f"{k}=?" for k in updates)
        with self.conn() as c:
            c.execute(f"UPDATE kb_ingestions SET {sql} WHERE id=?", (*updates.values(), ingestion_id))

    def kb_create_ingestion(self, ingestion_id: str, files_found: int = 0) -> None:
        now = time.time()
        with self.conn() as c:
            c.execute(
                "INSERT INTO kb_ingestions (id,status,started_at,files_found,created) "
                "VALUES (?,?,?,?,?)",
                (ingestion_id, "queued", now, files_found, now),
            )

    def kb_get_ingestion(self, ingestion_id: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM kb_ingestions WHERE id=?", (ingestion_id,)).fetchone()
        return dict(row) if row else None

    def kb_list_ingestions(self, limit: int = 50) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM kb_ingestions ORDER BY created DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def kb_upsert_document(self, doc: dict) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO kb_documents (id,source_path,file_name,title,file_hash,file_size,"
                "status,error,ingested_at,node_count,equation_count,created,updated) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "source_path=excluded.source_path, file_name=excluded.file_name, "
                "title=excluded.title, file_hash=excluded.file_hash, "
                "file_size=excluded.file_size, status=excluded.status, "
                "error=excluded.error, ingested_at=excluded.ingested_at, "
                "node_count=excluded.node_count, equation_count=excluded.equation_count, "
                "updated=excluded.updated",
                (doc["id"], doc["source_path"], doc["file_name"], doc.get("title"),
                 doc["file_hash"], doc["file_size"], doc.get("status", "ingested"),
                 doc.get("error"), doc.get("ingested_at"),
                 doc.get("node_count", 0), doc.get("equation_count", 0),
                 doc.get("created", time.time()), time.time()),
            )

    def kb_get_document(self, doc_id: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM kb_documents WHERE id=?", (doc_id,)).fetchone()
        return dict(row) if row else None

    def kb_list_documents(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT d.*, (SELECT COUNT(*) FROM kb_nodes n WHERE n.document_id=d.id) AS actual_nodes "
                "FROM kb_documents d ORDER BY d.updated DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def kb_delete_document(self, doc_id: str) -> int:
        """Remove a document and all its nodes, edges, symbols, refs, derivations, FTS rows."""
        with self.conn() as c:
            c.execute("DELETE FROM kb_node_fts WHERE node_id IN "
                      "(SELECT id FROM kb_nodes WHERE document_id=?)", (doc_id,))
            c.execute("DELETE FROM kb_derivation_steps WHERE derivation_id IN "
                      "(SELECT id FROM kb_derivations WHERE document_id=?)", (doc_id,))
            c.execute("DELETE FROM kb_derivations WHERE document_id=?", (doc_id,))
            c.execute("DELETE FROM kb_concepts WHERE document_id=?", (doc_id,))
            c.execute("DELETE FROM kb_symbol_occurrences WHERE symbol_id IN "
                      "(SELECT id FROM kb_symbols WHERE document_id=?)", (doc_id,))
            c.execute("DELETE FROM kb_symbols WHERE document_id=?", (doc_id,))
            c.execute("DELETE FROM kb_references WHERE document_id=?", (doc_id,))
            c.execute("DELETE FROM kb_node_edges WHERE source_id IN "
                      "(SELECT id FROM kb_nodes WHERE document_id=?) "
                      "OR target_id IN (SELECT id FROM kb_nodes WHERE document_id=?)",
                      (doc_id, doc_id))
            cur = c.execute("DELETE FROM kb_nodes WHERE document_id=?", (doc_id,))
            nodes_removed = cur.rowcount
            cur = c.execute("DELETE FROM kb_documents WHERE id=?", (doc_id,))
            docs_removed = cur.rowcount
        return docs_removed, nodes_removed

    def kb_upsert_node(self, node: dict) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO kb_nodes (id,document_id,type,title,content,latex,label,"
                "line_start,line_end,parent_id,ordinal,provenance,confidence,created) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "title=excluded.title, content=excluded.content, latex=excluded.latex, "
                "label=excluded.label, line_start=excluded.line_start, "
                "line_end=excluded.line_end, parent_id=excluded.parent_id, "
                "ordinal=excluded.ordinal, provenance=excluded.provenance, "
                "confidence=excluded.confidence",
                (node["id"], node["document_id"], node["type"], node.get("title"),
                 node.get("content"), node.get("latex"), node.get("label"),
                 node.get("line_start"), node.get("line_end"),
                 node.get("parent_id"), node.get("ordinal"),
                 node.get("provenance", "extracted"),
                 node.get("confidence", 1.0), node.get("created", time.time())),
            )

    def kb_add_edge(self, source_id: str, target_id: str, rel_type: str,
                    properties: dict | None = None) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO kb_node_edges (source_id,target_id,rel_type,properties) "
                "VALUES (?,?,?,?)",
                (source_id, target_id, rel_type, json.dumps(properties or {})),
            )

    def kb_get_node(self, node_id: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM kb_nodes WHERE id=?", (node_id,)).fetchone()
        return dict(row) if row else None

    def kb_get_node_tree(self, doc_id: str) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM kb_nodes WHERE document_id=? ORDER BY ordinal, id",
                (doc_id,)).fetchall()
        nodes = [dict(r) for r in rows]
        by_id = {n["id"]: n for n in nodes}
        for n in nodes:
            n["children"] = []
        roots = []
        for n in nodes:
            if n["parent_id"] and n["parent_id"] in by_id:
                by_id[n["parent_id"]]["children"].append(n)
            else:
                roots.append(n)
        return roots

    def kb_node_children(self, node_id: str) -> list[dict]:
        with self.conn() as c:
            node = c.execute("SELECT * FROM kb_nodes WHERE id=?", (node_id,)).fetchone()
            if not node:
                return []
            rows = c.execute(
                "SELECT * FROM kb_nodes WHERE parent_id=? ORDER BY ordinal", (node_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    def kb_get_edges(self, node_id: str) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM kb_node_edges WHERE source_id=? OR target_id=? ORDER BY id",
                (node_id, node_id)).fetchall()
        return [dict(r) for r in rows]

    def kb_search_fts(self, query: str, limit: int = 50,
                      doc_id: str | None = None,
                      node_type: str | None = None) -> list[dict]:
        sql = ("SELECT n.*, bm25(kb_node_fts) AS rank "
               "FROM kb_node_fts f JOIN kb_nodes n ON n.id=f.node_id "
               "WHERE kb_node_fts MATCH ?")
        params: list = [query]
        if doc_id:
            sql += " AND n.document_id=?"
            params.append(doc_id)
        if node_type:
            sql += " AND n.type=?"
            params.append(node_type)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)
        with self.conn() as c:
            rows = c.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def kb_search_symbols(self, query: str, limit: int = 50,
                          doc_id: str | None = None) -> list[dict]:
        sql = ("SELECT s.*, COUNT(o.id) AS occ_count "
               "FROM kb_symbols s LEFT JOIN kb_symbol_occurrences o ON o.symbol_id=s.id "
               "WHERE s.symbol LIKE ?")
        params: list = [f"%{query}%"]
        if doc_id:
            sql += " AND s.document_id=?"
            params.append(doc_id)
        sql += " GROUP BY s.id ORDER BY occ_count DESC, s.symbol LIMIT ?"
        params.append(limit)
        with self.conn() as c:
            rows = c.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def kb_get_symbol_occurrences(self, symbol_id: str) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT o.*, n.title AS node_title, n.type AS node_type, n.label "
                "FROM kb_symbol_occurrences o "
                "JOIN kb_nodes n ON n.id=o.node_id "
                "WHERE o.symbol_id=? ORDER BY o.id",
                (symbol_id,)).fetchall()
        return [dict(r) for r in rows]

    def kb_get_equations(self, doc_id: str | None = None,
                         limit: int = 200) -> list[dict]:
        sql = "SELECT * FROM kb_nodes WHERE type='equation'"
        params: list = []
        if doc_id:
            sql += " AND document_id=?"
            params.append(doc_id)
        sql += " ORDER BY id LIMIT ?"
        params.append(limit)
        with self.conn() as c:
            rows = c.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def kb_get_symbols(self, doc_id: str | None = None,
                       limit: int = 200) -> list[dict]:
        sql = ("SELECT s.*, COUNT(o.id) AS occ_count "
               "FROM kb_symbols s LEFT JOIN kb_symbol_occurrences o ON o.symbol_id=s.id")
        params: list = []
        if doc_id:
            sql += " WHERE s.document_id=?"
            params.append(doc_id)
        sql += " GROUP BY s.id ORDER BY occ_count DESC, s.symbol LIMIT ?"
        params.append(limit)
        with self.conn() as c:
            rows = c.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def kb_get_derivations(self, doc_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM kb_derivations"
        params: list = []
        if doc_id:
            sql += " WHERE document_id=?"
            params.append(doc_id)
        sql += " ORDER BY id"
        with self.conn() as c:
            rows = c.execute(sql, params).fetchall()
        derivations = [dict(r) for r in rows]
        for d in derivations:
            d["assumptions"] = json.loads(d["assumptions"] or "[]")
            steps = c.execute(
                "SELECT step_ordinal,node_id,node_type FROM kb_derivation_steps "
                "WHERE derivation_id=? ORDER BY step_ordinal", (d["id"],))
            d["steps"] = [dict(s) for s in steps.fetchall()]
        return derivations

    def kb_get_concepts(self, doc_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM kb_concepts"
        params: list = []
        if doc_id:
            sql += " WHERE document_id=?"
            params.append(doc_id)
        sql += " ORDER BY id"
        with self.conn() as c:
            rows = c.execute(sql, params).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["associated_symbols"] = json.loads(d["associated_symbols"] or "[]")
            d["section_ids"] = json.loads(d["section_ids"] or "[]")
            out.append(d)
        return out

    def kb_upsert_symbol(self, symbol: dict) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO kb_symbols (id,symbol,document_id,normalized,meaning_context,occurrence_count) "
                "VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "symbol=excluded.symbol, normalized=excluded.normalized, "
                "meaning_context=excluded.meaning_context",
                (symbol["id"], symbol["symbol"], symbol["document_id"],
                 symbol.get("normalized"), symbol.get("meaning_context"),
                 symbol.get("occurrence_count", 0)),
            )

    def kb_add_symbol_occurrence(self, symbol_id: str, node_id: str,
                                 context: str | None,
                                 line_start: int | None,
                                 line_end: int | None) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO kb_symbol_occurrences (symbol_id,node_id,context,line_start,line_end) "
                "VALUES (?,?,?,?,?)",
                (symbol_id, node_id, context, line_start, line_end),
            )

    def kb_add_reference(self, document_id: str, source_node_id: str,
                         ref_type: str, ref_target: str,
                         resolved_node_id: str | None = None) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO kb_references (document_id,source_node_id,ref_type,ref_target,resolved_node_id) "
                "VALUES (?,?,?,?,?)",
                (document_id, source_node_id, ref_type, ref_target, resolved_node_id),
            )

    def kb_count_by_type(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT type, COUNT(*) AS cnt FROM kb_nodes GROUP BY type ORDER BY cnt DESC"
            ).fetchall()
        return [dict(r) for r in rows]


def clear_gateway_sessions(session_id: str) -> int:
    """Drop native CLI session-map rows belonging to a browser session."""
    if not os.path.exists(GATEWAY_SESSION_DB):
        return 0
    try:
        conn = sqlite3.connect(GATEWAY_SESSION_DB, timeout=10)
        with conn:
            cur = conn.execute("DELETE FROM sessions WHERE scope LIKE ?", (f"{session_id}|%",))
            count = cur.rowcount
        conn.close()
        return max(0, count)
    except sqlite3.Error:
        return 0
