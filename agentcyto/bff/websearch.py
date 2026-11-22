"""Web search (Brave Search API) plus light, SSRF-safe page scraping.

Pages are fetched only over http(s), only when the host resolves to public
addresses (so a search result can never point the BFF at `gateway:4000` or a
cloud metadata endpoint), with a size cap and short timeouts. Wikipedia pages
use the MediaWiki API for clean plain text; other pages go through a small
stdlib HTML-to-text extractor. Nothing here raises to the caller: failures come
back as empty results so a chat turn never fails because the web was flaky.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
from html import unescape
from html.parser import HTMLParser
from urllib.parse import quote, unquote, urlparse

import httpx

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
UA = "Mozilla/5.0 (compatible; agentcyto-research/1.0)"
MAX_BYTES = 2_000_000
FETCH_TIMEOUT = httpx.Timeout(10, connect=5)


def brave_key() -> str:
    return os.environ.get("BRAVE_API_KEY", "").strip().strip('"').strip("'")


def available() -> bool:
    return bool(brave_key())


def _strip_tags(s: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", s or ""))


async def brave_search(query: str, count: int = 6) -> list[dict]:
    key = brave_key()
    if not key or not query.strip():
        return []
    async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5)) as client:
        r = await client.get(BRAVE_URL, params={"q": query[:380], "count": count, "safesearch": "moderate"},
                             headers={"X-Subscription-Token": key, "Accept": "application/json"})
        r.raise_for_status()
        data = r.json()
    out = []
    for item in (data.get("web") or {}).get("results") or []:
        url = item.get("url") or ""
        if not url.startswith(("http://", "https://")):
            continue
        out.append({
            "url": url,
            "title": _strip_tags(item.get("title") or url)[:200],
            "description": _strip_tags(item.get("description") or "")[:600],
            "extra": [_strip_tags(x)[:400] for x in (item.get("extra_snippets") or [])][:3],
            "site": urlparse(url).hostname or "",
        })
    return out


# --------------------------------------------------------------------------- #
# Safe fetching
# --------------------------------------------------------------------------- #

def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            return False
    return bool(infos)


async def _safe_get(client: httpx.AsyncClient, url: str, params: dict | None = None) -> httpx.Response | None:
    """GET following up to 4 redirects, re-checking every hop is a public host."""
    for _ in range(5):
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            return None
        if not await asyncio.to_thread(_public_host, u.hostname):
            return None
        async with client.stream("GET", url, params=params, headers={"User-Agent": UA}) as r:
            if r.is_redirect and r.headers.get("location"):
                url = str(r.url.join(r.headers["location"]))
                params = None
                continue
            if r.status_code >= 400:
                return None
            body = b""
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > MAX_BYTES:
                    break
            r._content = body  # noqa: SLF001 - keep the capped body readable via .text
            return r
    return None


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form",
            "button", "iframe", "template", "figure", "sup"}
    SKIP_CLASSES = ("mw-editsection", "reference", "navbox", "infobox", "sidebar", "metadata",
                    "mw-jump-link", "toc", "hatnote", "noprint", "mwe-math-fallback-image")
    BLOCK = {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6",
             "tr", "br", "pre", "blockquote", "dd", "dt", "table"}
    VOID = {"img", "br", "hr", "meta", "link", "input", "source", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_tag: str | None = None  # one skipped region at a time, depth-counted
        self.skip_depth = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if self.skip_tag:
            if tag == self.skip_tag:
                self.skip_depth += 1
            return
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if tag == "title":
            self._in_title = True
        elif tag == "math":
            # LaTeX source: Parsoid keeps it in data-mw.body.extsrc, other MathML in alttext.
            alt = ""
            try:
                alt = ((json.loads(a.get("data-mw") or "{}").get("body") or {}).get("extsrc") or "")
            except (ValueError, AttributeError):
                pass
            alt = (alt or a.get("alttext") or "").strip()
            alt = re.sub(r"^\{\\displaystyle\s*(.*)\}$", r"\1", alt, flags=re.S).strip()
            block = a.get("display") == "block" or "mwe-math-element-block" in classes
            if alt:
                self.parts.append(f"\n$${alt}$$\n" if block else f" ${alt}$ ")
            self.skip_tag, self.skip_depth = "math", 1
        elif tag in self.SKIP or any(c in classes for c in self.SKIP_CLASSES):
            if tag not in self.VOID:
                self.skip_tag, self.skip_depth = tag, 1
        elif tag in self.BLOCK:
            self.parts.append("\n")
            if tag in ("h1", "h2", "h3", "h4"):
                self.parts.append("## ")
        elif tag == "img":
            alt = a.get("alt")  # math images on many sites carry LaTeX in alt
            if alt and len(alt) < 300 and "\\" in alt:
                self.parts.append(f" ${alt}$ ")

    def handle_endtag(self, tag):
        if self.skip_tag:
            if tag == self.skip_tag:
                self.skip_depth -= 1
                if self.skip_depth <= 0:
                    self.skip_tag = None
            return
        if tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.skip_tag:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str]:
    p = _TextExtractor()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 - malformed HTML: keep what we got
        pass
    text = "".join(p.parts)
    # Leftover footnote markers like [12] would collide with our own [n] citations.
    text = re.sub(r"\[(?:\d{1,3}|edit|citation needed|note \d+|[a-z])\]", "", text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return _strip_tags(p.title).strip(), text.strip()


_WIKI_RE = re.compile(r"^([a-z\-]{2,12})\.(?:m\.)?wikipedia\.org$")


async def _wikipedia(client: httpx.AsyncClient, host: str, path: str) -> tuple[str, str] | None:
    m = _WIKI_RE.match(host)
    if not m or not path.startswith("/wiki/"):
        return None
    title = unquote(path[len("/wiki/"):]).split("#")[0]
    # Parsoid HTML via the REST API: clean article body, LaTeX preserved in <math alttext>.
    r = await _safe_get(client, f"https://{m.group(1)}.wikipedia.org/api/rest_v1/page/html/"
                        + quote(title.replace(" ", "_"), safe=""))
    if not r:
        return None
    page_title, text = html_to_text(r.text)
    # Reference / see-also tails only add noise.
    text = re.split(r"\n## (?:References|Notes|See also|External links|Further reading|Bibliography)\s*\n",
                    text)[0]
    return (page_title or title.replace("_", " ")), text


async def fetch_page(url: str) -> dict | None:
    """Return {url, title, text} or None. Never raises."""
    try:
        u = urlparse(url)
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT, follow_redirects=False) as client:
            wiki = await _wikipedia(client, u.hostname or "", u.path)
            if wiki:
                return {"url": url, "title": wiki[0], "text": wiki[1][:400_000], "source": "wikipedia"}
            r = await _safe_get(client, url)
            if not r:
                return None
            ctype = r.headers.get("content-type", "")
            if "html" in ctype:
                title, text = html_to_text(r.text)
            elif ctype.startswith("text/"):
                title, text = "", r.text
            else:
                return None  # PDFs, images…: rely on the search snippet instead
            return {"url": url, "title": title, "text": text[:400_000], "source": "html"}
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# Passage selection
# --------------------------------------------------------------------------- #

def _paragraphs(text: str) -> list[tuple[str, str]]:
    """Split into (heading, paragraph) pairs, merging very short lines."""
    out: list[tuple[str, str]] = []
    heading = ""
    buf = ""
    for block in re.split(r"\n\s*\n|\n(?=## )", text):
        block = block.strip()
        if not block:
            continue
        if block.startswith("## ") and len(block) < 160:
            if buf:
                out.append((heading, buf))
                buf = ""
            heading = block[3:].strip()
            continue
        buf = f"{buf}\n{block}" if buf else block
        if len(buf) > 500:
            out.append((heading, buf))
            buf = ""
    if buf:
        out.append((heading, buf))
    return out


def best_passages(text: str, terms: list[str], max_passages: int = 2, max_chars: int = 1400) -> list[dict]:
    """Score paragraphs by distinct-term overlap (heading counts too) and return windows."""
    terms = [t.lower() for t in terms if len(t) > 2][:24]
    paras = _paragraphs(text)
    if not paras:
        return []
    scored = []
    for i, (head, para) in enumerate(paras):
        low = para.lower()
        hlow = head.lower()
        if len(para) < 60 or sum(c.isalpha() for c in para) < len(para) * 0.4:
            continue  # navigation residue, tables of numbers
        hit = sum(1 for t in terms if t in low) + 0.5 * sum(1 for t in terms if t in hlow)
        if hit:
            scored.append((hit + (0.3 if i < 3 else 0), i))
    if not scored:
        scored = [(0, 0)]  # nothing matched: the lead paragraph is the best summary
    scored.sort(key=lambda x: (-x[0], x[1]))
    out, used = [], set()
    for score, i in scored:
        if len(out) >= max_passages:
            break
        if i in used:
            continue
        chunk = paras[i][1]
        j = i + 1
        while len(chunk) < max_chars * 0.6 and j < len(paras) and paras[j][0] == paras[i][0]:
            chunk += "\n\n" + paras[j][1]
            used.add(j)
            j += 1
        used.add(i)
        out.append({"heading": paras[i][0], "text": chunk[:max_chars], "score": score})
    return out


def wiki_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_"))
