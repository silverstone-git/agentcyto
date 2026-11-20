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
"""


class DB:
    def __init__(self, path: str = DB_PATH):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._local = threading.local()
        with self.conn() as c:
            c.executescript(SCHEMA)

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
                   model: str, idempotency_key: str | None) -> None:
        now = time.time()
        with self.conn() as c:
            c.execute(
                "INSERT INTO jobs (id,session_id,mode,role,model,status,idempotency_key,created,updated) "
                "VALUES (?,?,?,?,?,'queued',?,?,?)",
                (job_id, session_id, mode, role, model, idempotency_key, now, now),
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
