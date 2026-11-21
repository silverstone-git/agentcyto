"""Knowledge base: mathematical document compiler + search.

Stage A (deterministic, runs locally):
  * Markdown structural parsing (headings, display math, paragraphs,
    theorems/proofs/definitions/examples, line-number mapping)
  * LaTeX block extraction + equation labelling
  * Symbol tokenization from LaTeX commands
  * Reference extraction (eqn/section/theorem)
  * Node tree + typed edges + FTS5 index

Stage B (semantic enrichment, optional):
  * LLM-generated summaries, concepts, derivation boundaries via the gateway.

All derived data lives in the `kb_*` tables of the BFF SQLite DB. The source
Markdown files are never modified; ingestion is idempotent (skips files whose
SHA-256 is unchanged) and can be re-run from scratch.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from db import DB

KB_SOURCE_DIR = Path(os.environ.get("KB_SOURCE_DIR", "/kb-source"))
DB_PATH = os.environ.get("AGENCYTO_DB", "/state/agentcyto.db")

# --------------------------------------------------------------------------- #
# Regexes for the deterministic parser
# --------------------------------------------------------------------------- #

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
# A display-math line: starts with $$ (optionally with leading content before $$)
DISPLAY_MATH_LINE = re.compile(r"^(.*?)\$\$(.*?)\$\s*$")
DISPLAY_MATH_OPEN_ONLY = re.compile(r"^(.*?)\$\$(.*)$")
DISPLAY_MATH_CLOSE_ONLY = re.compile(r"^(.*?)\$\$\s*$")
INLINE_MATH_RE = re.compile(r"\$(.+?)\$")
TAG_LABEL_RE = re.compile(r"\\tag\s*\{([^}]+)\}")
# Label like (3.1) or (0.5a) at end of a line
INLINE_LABEL_RE = re.compile(r"\((\d+(?:\.\d+)*[a-z]?)\)\s*$")
# LaTeX commands: \phi, \hbar, \lambda, etc.
LATEX_COMMAND_RE = re.compile(r"\\([A-Za-z]+)")
# Bold theorem/proof/etc markers: **Theorem 3.1.**, **Proof 1.1**, **Example 1.2**
THEOREM_MARKER_RE = re.compile(
    r"\*\*(Theorem|Proof|Definition|Example|Lemma|Corollary|Proposition|Method|Self-test|Exercise)\s*"
    r"([\d.]+)?\.\*\*",
    re.IGNORECASE,
)
# References
REF_EQN_RE = re.compile(r"\beqn\s+(\d+(?:\.\d+)*[a-z]?)", re.IGNORECASE)
REF_SECTION_RE = re.compile(r"\b[Ss]ection\s+(\d+(?:\.\d+)*)", re.IGNORECASE)
REF_THEOREM_RE = re.compile(
    r"\b(Theorem|Lemma|Corollary|Proposition|Definition)\s+(\d+(?:\.\d+)*)", re.IGNORECASE,
)

NODE_TYPES = {
    "document", "chapter", "section", "subsection", "paragraph", "equation",
    "theorem", "proof", "definition", "example", "derivation",
}

# Heading level -> node type
HEADING_TYPE = {1: "chapter", 2: "section", 3: "subsection", 4: "subsubsection"}

MAX_NODE_CONTENT = 200_000


def _doc_id_from_path(path: Path) -> str:
    """Stable doc id derived from the file name (stem, lowercased, alnum+dash)."""
    stem = path.stem
    stem = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return stem or "document"


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _node_id(doc_id: str, kind: str, ordinal: int) -> str:
    return f"{doc_id}:{kind}-{ordinal}"


def _strip_markers(text: str) -> str:
    """Remove bold markers and other inline markup from plain text."""
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"__(.*?)__", r"\1", text)
    text = re.sub(r"\*(.*?)\*", r"\1", text)
    text = re.sub(r"_(.*?)_", r"\1", text)
    return text.strip()


def _extract_label(latex_or_line: str) -> str | None:
    """Extract an equation/theorem label from \tag{...} or a trailing (n.n)."""
    m = TAG_LABEL_RE.search(latex_or_line)
    if m:
        return m.group(1).strip()
    m = INLINE_LABEL_RE.search(latex_or_line.rstrip())
    if m:
        return m.group(1)
    return None


def _symbols_from_latex(latex: str) -> list[str]:
    """Tokenize LaTeX commands into symbols. De-dupe, preserve order."""
    seen: set[str] = set()
    out: list[str] = []
    for m in LATEX_COMMAND_RE.finditer(latex):
        sym = "\\" + m.group(1)
        if sym not in seen:
            seen.add(sym)
            out.append(sym)
    return out


# --------------------------------------------------------------------------- #
# Stage A: deterministic markdown parser
# --------------------------------------------------------------------------- #

class _ParserState:
    def __init__(self, doc_id: str, source_path: str):
        self.doc_id = doc_id
        self.source_path = source_path
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[tuple[str, str, str, dict | None]] = []
        self.symbols: dict[str, dict[str, Any]] = {}  # symbol -> {id, occurrences}
        self.symbol_counter = 0
        self.references: list[dict[str, Any]] = []
        self.ordinal_counter = 0

        # Document root node
        self.doc_node_id = f"{doc_id}:document"
        self.nodes.append({
            "id": self.doc_node_id,
            "document_id": doc_id,
            "type": "document",
            "title": None,
            "content": None,
            "latex": None,
            "label": None,
            "line_start": 1,
            "line_end": None,
            "parent_id": None,
            "ordinal": 0,
            "provenance": "extracted",
            "confidence": 1.0,
        })
        self.ordinal_counter += 1

        # Section stack: list of (level, node_id)
        self.section_stack: list[tuple[int, str]] = [(0, self.doc_node_id)]

        # Pending buffers
        self.pending_para: list[str] = []
        self.pending_para_start: int | None = None
        self.in_math = False
        self.math_buffer: list[str] = []
        self.math_start_line: int | None = None
        self.math_prefix = ""  # text before $$ on the opening line

    # -- buffer management ------------------------------------------------- #

    def _next_ordinal(self) -> int:
        self.ordinal_counter += 1
        return self.ordinal_counter

    def flush_paragraph(self, line_end: int) -> None:
        if not self.pending_para:
            return
        text = "\n".join(self.pending_para).strip()
        self.pending_para = []
        if not text:
            self.pending_para_start = None
            return
        start = self.pending_para_start or line_end
        self.pending_para_start = None
        self._add_paragraph(text, start, line_end)

    def flush_math(self, line_end: int) -> None:
        if not self.in_math or not self.math_buffer:
            self.in_math = False
            self.math_buffer = []
            self.math_start_line = None
            self.math_prefix = ""
            return
        latex = "\n".join(self.math_buffer).strip()
        self.in_math = False
        start = self.math_start_line or line_end
        self.math_start_line = None
        self.math_buffer = []
        prefix = self.math_prefix
        self.math_prefix = ""
        if not latex:
            return
        # Combine any text before $$ with the latex for label extraction
        label_source = (prefix + " " + latex).strip() if prefix else latex
        label = _extract_label(label_source) or _extract_label(latex)
        node_type = "equation"
        title = None
        content = latex
        node_id = _node_id(self.doc_id, node_type, self._next_ordinal())
        self.nodes.append({
            "id": node_id,
            "document_id": self.doc_id,
            "type": node_type,
            "title": title,
            "content": content[:MAX_NODE_CONTENT],
            "latex": latex,
            "label": label,
            "line_start": start,
            "line_end": line_end,
            "parent_id": self.current_section_id(),
            "ordinal": self._next_ordinal(),
            "provenance": "extracted",
            "confidence": 1.0,
        })
        self._attach_to_section(node_id)
        # Symbols from this equation
        for sym in _symbols_from_latex(latex):
            self._register_symbol(sym, node_id, latex, start, line_end)

    def current_section_id(self) -> str:
        return self.section_stack[-1][1] if self.section_stack else self.doc_node_id

    def _attach_to_section(self, node_id: str) -> None:
        parent = self.current_section_id()
        if parent and parent != self.doc_node_id:
            self.edges.append((parent, node_id, "contains", None))
        else:
            self.edges.append((self.doc_node_id, node_id, "contains", None))

    # -- node creation ---------------------------------------------------- #

    def _add_heading(self, level: int, text: str, line_no: int) -> str:
        node_type = HEADING_TYPE.get(level, "section")
        title = _strip_markers(text).strip()
        node_id = _node_id(self.doc_id, node_type, self._next_ordinal())
        self.nodes.append({
            "id": node_id,
            "document_id": self.doc_id,
            "type": node_type,
            "title": title,
            "content": title,
            "latex": None,
            "label": None,
            "line_start": line_no,
            "line_end": line_no,
            "parent_id": self.current_section_id(),
            "ordinal": self._next_ordinal(),
            "provenance": "extracted",
            "confidence": 1.0,
        })
        # Rebuild section stack: pop deeper or equal levels
        while len(self.section_stack) > 1 and self.section_stack[-1][0] >= level:
            self.section_stack.pop()
        self.section_stack.append((level, node_id))
        self._attach_to_section(node_id)
        return node_id

    def _add_paragraph(self, text: str, start: int, end: int) -> str:
        # Check for theorem/proof/definition/etc marker at start
        m = THEOREM_MARKER_RE.match(text)
        if m:
            kind = m.group(1).lower()
            num = m.group(2) or ""
            node_type = {
                "theorem": "theorem",
                "proof": "proof",
                "definition": "definition",
                "example": "example",
                "lemma": "theorem",
                "corollary": "theorem",
                "proposition": "theorem",
                "method": "example",
                "self-test": "example",
                "exercise": "example",
            }.get(kind, "paragraph")
            title = f"{kind.capitalize()} {num}".strip() if num else kind.capitalize()
            content = _strip_markers(text)
        else:
            node_type = "paragraph"
            title = None
            content = text
        node_id = _node_id(self.doc_id, node_type, self._next_ordinal())
        self.nodes.append({
            "id": node_id,
            "document_id": self.doc_id,
            "type": node_type,
            "title": title,
            "content": content[:MAX_NODE_CONTENT],
            "latex": None,
            "label": None,
            "line_start": start,
            "line_end": end,
            "parent_id": self.current_section_id(),
            "ordinal": self._next_ordinal(),
            "provenance": "extracted",
            "confidence": 1.0,
        })
        self._attach_to_section(node_id)
        # Inline math symbols
        for im in INLINE_MATH_RE.finditer(text):
            for sym in _symbols_from_latex(im.group(1)):
                self._register_symbol(sym, node_id, im.group(1), start, end)
        # References in this paragraph
        self._extract_references(text, node_id)
        return node_id

    def _register_symbol(self, symbol: str, node_id: str, context: str,
                         line_start: int, line_end: int) -> None:
        if symbol not in self.symbols:
            self.symbol_counter += 1
            self.symbols[symbol] = {
                "id": f"{self.doc_id}:symbol-{self.symbol_counter}",
                "symbol": symbol,
                "document_id": self.doc_id,
                "normalized": symbol.lower(),
                "meaning_context": None,
                "occurrences": [],
            }
        self.symbols[symbol]["occurrences"].append({
            "node_id": node_id,
            "context": context[:200],
            "line_start": line_start,
            "line_end": line_end,
        })

    def _extract_references(self, text: str, source_node_id: str) -> None:
        for m in REF_EQN_RE.finditer(text):
            self.references.append({
                "source_node_id": source_node_id,
                "ref_type": "equation",
                "ref_target": m.group(1),
            })
        for m in REF_SECTION_RE.finditer(text):
            self.references.append({
                "source_node_id": source_node_id,
                "ref_type": "section",
                "ref_target": m.group(1),
            })
        for m in REF_THEOREM_RE.finditer(text):
            self.references.append({
                "source_node_id": source_node_id,
                "ref_type": "theorem",
                "ref_target": f"{m.group(1)} {m.group(2)}",
            })

    # -- main parse ------------------------------------------------------- #

    def parse(self, lines: list[str]) -> None:
        for idx, raw in enumerate(lines, start=1):
            line = raw.rstrip("\n")

            if self.in_math:
                # Still inside a display math block
                close_m = DISPLAY_MATH_CLOSE_ONLY.match(line)
                if close_m:
                    tail = close_m.group(1)
                    if tail.strip():
                        self.math_buffer.append(tail)
                    self.flush_math(idx)
                else:
                    self.math_buffer.append(line)
                continue

            # Not in math: check for display math opening
            open_m = DISPLAY_MATH_OPEN_ONLY.match(line)
            if open_m:
                self.flush_paragraph(idx - 1)
                prefix, rest = open_m.group(1), open_m.group(2)
                self.math_prefix = prefix.strip()
                close_m = DISPLAY_MATH_CLOSE_ONLY.match(rest)
                if close_m:
                    # Single-line display math: $$ ... $$
                    self.math_buffer = [close_m.group(1)]
                    self.math_start_line = idx
                    self.flush_math(idx)
                else:
                    self.math_buffer = [rest]
                    self.math_start_line = idx
                    self.in_math = True
                continue

            # Heading
            h = HEADING_RE.match(line)
            if h:
                self.flush_paragraph(idx - 1)
                level = len(h.group(1))
                text = h.group(2).strip()
                self._add_heading(level, text, idx)
                continue

            # Blank line -> paragraph boundary
            if not line.strip():
                self.flush_paragraph(idx - 1)
                continue

            # Regular text line -> accumulate into paragraph
            if self.pending_para_start is None:
                self.pending_para_start = idx
            self.pending_para.append(line)

        # End of file: flush remaining buffers
        self.flush_paragraph(len(lines))
        self.flush_math(len(lines))


# DISPLAY_MATCH_CLOSE_ONLY typo guard: define the real one used above.
DISPLAY_MATH_CLOSE_ONLY = re.compile(r"^(.*?)\$\$\s*$")


def parse_document(doc_id: str, source_path: str, text: str) -> _ParserState:
    state = _ParserState(doc_id, source_path)
    state.parse(text.splitlines())
    return state


# --------------------------------------------------------------------------- #
# Ingestion orchestration
# --------------------------------------------------------------------------- #

class KB:
    def __init__(self, db: DB):
        self.db = db

    def source_files(self) -> list[Path]:
        if not KB_SOURCE_DIR.exists():
            return []
        return sorted(p for p in KB_SOURCE_DIR.iterdir()
                      if p.is_file() and p.suffix.lower() == ".md")

    def ingest_all(self, ingestion_id: str, force: bool = False) -> dict:
        """Ingest every .md file in KB_SOURCE_DIR. Idempotent unless force."""
        files = self.source_files()
        self.db.kb_create_ingestion(ingestion_id, files_found=len(files))
        self.db.kb_set_ingestion(ingestion_id, "running")

        nodes_created = 0
        ingested = 0
        skipped = 0
        error = None

        try:
            for path in files:
                try:
                    result = self.ingest_file(path, force=force)
                    if result == "skipped":
                        skipped += 1
                    elif result == "ingested":
                        ingested += 1
                        doc = self.db.kb_get_document(_doc_id_from_path(path))
                        nodes_created += int(doc["node_count"]) if doc else 0
                    # "failed" handled inside
                except Exception as exc:  # noqa: BLE001
                    self.db.kb_upsert_document({
                        "id": _doc_id_from_path(path),
                        "source_path": str(path),
                        "file_name": path.name,
                        "title": None,
                        "file_hash": "",
                        "file_size": path.stat().st_size,
                        "status": "failed",
                        "error": str(exc)[:500],
                        "ingested_at": time.time(),
                    })
                    error = (error or "") + f"{path.name}: {exc}; "

            self.db.kb_set_ingestion(
                ingestion_id, "done",
                files_ingested=ingested, files_skipped=skipped,
                nodes_created=nodes_created, finished_at=time.time(),
            )
        except Exception as exc:  # noqa: BLE001
            self.db.kb_set_ingestion(
                ingestion_id, "blocked", error=str(exc)[:1000],
                finished_at=time.time(),
            )
            raise

        return {
            "ingestion_id": ingestion_id,
            "status": "done",
            "files_found": len(files),
            "files_ingested": ingested,
            "files_skipped": skipped,
            "nodes_created": nodes_created,
            "error": error,
        }

    def ingest_file(self, path: Path, force: bool = False) -> str:
        """Ingest a single file. Returns 'ingested', 'skipped', or 'failed'."""
        doc_id = _doc_id_from_path(path)
        text = path.read_text(encoding="utf-8", errors="replace")
        file_hash = _file_hash(path)
        file_size = path.stat().st_size

        existing = self.db.kb_get_document(doc_id)
        if existing and not force and existing.get("file_hash") == file_hash \
                and existing.get("status") == "ingested":
            return "skipped"

        # Remove previous version if re-ingesting
        if existing:
            self.db.kb_delete_document(doc_id)

        # Parse
        state = parse_document(doc_id, str(path), text)

        # Detect document title from first chapter heading or filename
        title = None
        for n in state.nodes:
            if n["type"] == "chapter" and n["title"]:
                title = n["title"]
                break
        if not title:
            title = path.stem

        now = time.time()
        # Upsert document
        self.db.kb_upsert_document({
            "id": doc_id,
            "source_path": str(path),
            "file_name": path.name,
            "title": title,
            "file_hash": file_hash,
            "file_size": file_size,
            "status": "ingested",
            "error": None,
            "ingested_at": now,
            "created": now,
        })

        # Insert nodes
        equation_count = 0
        for n in state.nodes:
            if n["id"] == state.doc_node_id:
                continue  # document root already inserted via upsert
            self.db.kb_upsert_node(n)
            if n["type"] == "equation":
                equation_count += 1

        # Insert edges
        for source_id, target_id, rel_type, props in state.edges:
            self.db.kb_add_edge(source_id, target_id, rel_type, props)

        # Insert symbols + occurrences
        for sym in state.symbols.values():
            self.db.kb_upsert_symbol(sym)
            for occ in sym["occurrences"]:
                self.db.kb_add_symbol_occurrence(
                    sym["id"], occ["node_id"], occ.get("context"),
                    occ.get("line_start"), occ.get("line_end"))

        # Insert references
        for ref in state.references:
            self.db.kb_add_reference(doc_id, ref["source_node_id"],
                                     ref["ref_type"], ref["ref_target"])

        # Populate FTS5 for this document's nodes
        self._rebuild_fts_for_document(doc_id)

        # Update document counts
        with self.db.conn() as c:
            c.execute(
                "UPDATE kb_documents SET node_count=?, equation_count=?, updated=? WHERE id=?",
                (len(state.nodes) - 1, equation_count, time.time(), doc_id))

        return "ingested"

    def reindex_all(self, ingestion_id: str) -> dict:
        """Drop all KB data and re-ingest from scratch."""
        with self.db.conn() as c:
            c.execute("DELETE FROM kb_derivation_steps")
            c.execute("DELETE FROM kb_derivations")
            c.execute("DELETE FROM kb_concepts")
            c.execute("DELETE FROM kb_symbol_occurrences")
            c.execute("DELETE FROM kb_symbols")
            c.execute("DELETE FROM kb_references")
            c.execute("DELETE FROM kb_node_edges")
            c.execute("DELETE FROM kb_node_fts")
            c.execute("DELETE FROM kb_nodes")
            c.execute("DELETE FROM kb_documents")
        return self.ingest_all(ingestion_id, force=True)

    def clear_all(self) -> dict:
        with self.db.conn() as c:
            c.execute("DELETE FROM kb_derivation_steps")
            c.execute("DELETE FROM kb_derivations")
            c.execute("DELETE FROM kb_concepts")
            c.execute("DELETE FROM kb_symbol_occurrences")
            c.execute("DELETE FROM kb_symbols")
            c.execute("DELETE FROM kb_references")
            c.execute("DELETE FROM kb_node_edges")
            c.execute("DELETE FROM kb_node_fts")
            c.execute("DELETE FROM kb_nodes")
            c.execute("DELETE FROM kb_documents")
            c.execute("DELETE FROM kb_ingestions")
        return {"status": "cleared"}

    # -- FTS5 ------------------------------------------------------------ #

    def _rebuild_fts_for_document(self, doc_id: str) -> None:
        with self.db.conn() as c:
            c.execute("DELETE FROM kb_node_fts WHERE node_id IN "
                      "(SELECT id FROM kb_nodes WHERE document_id=?)", (doc_id,))
            rows = c.execute(
                "SELECT id, content, title FROM kb_nodes WHERE document_id=? "
                "AND content IS NOT NULL AND trim(content)!=''", (doc_id,)
            ).fetchall()
            for r in rows:
                c.execute(
                    "INSERT INTO kb_node_fts (node_id, content, title) VALUES (?,?,?)",
                    (r["id"], r["content"], r["title"] or ""))

    def _rebuild_all_fts(self) -> None:
        with self.db.conn() as c:
            c.execute("DELETE FROM kb_node_fts")
            rows = c.execute(
                "SELECT id, content, title FROM kb_nodes WHERE content IS NOT NULL "
                "AND trim(content)!=''").fetchall()
            for r in rows:
                c.execute(
                    "INSERT INTO kb_node_fts (node_id, content, title) VALUES (?,?,?)",
                    (r["id"], r["content"], r["title"] or ""))

    # -- Stage B: LLM enrichment ---------------------------------------- #

    async def enrich_section_summaries(self, gateway_url: str, master_key: str,
                                       model: str = "heavy") -> dict:
        """Use the LLM to write one-paragraph summaries for each section."""
        import httpx
        sections = []
        with self.db.conn() as c:
            rows = c.execute(
                "SELECT id, title, content FROM kb_nodes "
                "WHERE type IN ('section','subsection','chapter') AND content IS NOT NULL"
            ).fetchall()
            sections = [dict(r) for r in rows]

        updated = 0
        for s in sections:
            prompt = (
                "Write a concise 2-3 sentence summary of this section for a "
                "mathematical knowledge base. Return only the summary text, no markup.\n\n"
                f"Section: {s['title']}\n\n{s['content'][:4000]}"
            )
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    r = await client.post(
                        f"{gateway_url}/v1/chat/completions",
                        json={"model": model, "messages": [
                            {"role": "user", "content": prompt}],
                            "stream": False},
                        headers={"Authorization": f"Bearer {master_key}"},
                    )
                    r.raise_for_status()
                    summary = r.json()["choices"][0]["message"]["content"].strip()
                with self.db.conn() as c:
                    c.execute(
                        "UPDATE kb_nodes SET content = content || CHAR(10) || "
                        "'[SUMMARY] ' || ? WHERE id=?",
                        (summary, s["id"]))
                    c.execute(
                        "UPDATE kb_node_fts SET content = content || CHAR(10) || "
                        "'[SUMMARY] ' || ? WHERE node_id=?",
                        (summary, s["id"]))
                updated += 1
            except Exception:  # noqa: BLE001
                continue
        return {"sections": len(sections), "updated": updated}


# Module-level singleton (created lazily by app.py)
_kb: KB | None = None


def get_kb(db: DB) -> KB:
    global _kb
    if _kb is None:
        _kb = KB(db)
    return _kb
