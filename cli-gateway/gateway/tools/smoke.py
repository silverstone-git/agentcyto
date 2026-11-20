"""Send one tiny prompt to each gateway model and report status, latency and who answered.

Run via: scripts/smoke.sh [model ...]     (default: every model except *-agent)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GATEWAY_URL", "http://gateway:4000").rstrip("/")
KEY = os.environ["LITELLM_MASTER_KEY"]
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def req(path, body=None, timeout=60):
    r = urllib.request.Request(BASE + path, headers=H, data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.load(resp)


models = sys.argv[1:] or [m["id"] for m in req("/v1/models")["data"] if not m["id"].endswith("-agent")]
for m in models:
    t = time.monotonic()
    try:
        out = req("/v1/chat/completions", {
            "model": m,
            "messages": [{"role": "user", "content": "Reply with exactly one word: pong"}],
        }, timeout=600)
        text = (out["choices"][0]["message"]["content"] or "").strip().replace("\n", " ")
        print(f"{m:<20} OK   {time.monotonic() - t:5.1f}s  via {out.get('model', '?'):<40} {text[:50]!r}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:160].replace("\n", " ")
        print(f"{m:<20} {e.code}  {time.monotonic() - t:5.1f}s  {detail}")
    except Exception as e:
        print(f"{m:<20} ERR  {time.monotonic() - t:5.1f}s  {type(e).__name__}: {e}")
