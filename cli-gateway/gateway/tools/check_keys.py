"""Check provider keys without printing them: name, length, HTTP status, model ids we use.

Run via: scripts/check.sh
"""
import json
import os
import urllib.error
import urllib.request

WANT = {
    "nvidia": ["nemotron-3.5-super-vl-120b-a12b", "nemotron-3-ultra-550b-a55b",
               "nemotron-3.5-lightning-30b-a3b", "nemotron-3.5-bolt-e4b"],
    "gemini": ["gemini-flash-latest", "gemini-flash-lite-latest"],
    "meta": ["muse-spark-1.3", "muse-spark-1.3-contributor"],
}


def call(url, headers, body=None):
    req = urllib.request.Request(url, headers=headers, data=json.dumps(body).encode() if body else None)
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:  # network errors
        return f"ERR {type(e).__name__}", {}


def ids(payload):
    rows = payload.get("data") or payload.get("models") or []
    return {str(r.get("id") or r.get("name", "")).split("/")[-1] for r in rows}


def show(label, status, have=None, want=()):
    line = f"  {label:<10} HTTP {status}"
    if have is not None:
        missing = [w for w in want if w not in have]
        line += "  models ok" if not missing else f"  MISSING: {', '.join(missing)}"
    print(line)


print("secrets (length only):")
for name in ["LITELLM_MASTER_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "NVIDIA_NIM_API_KEY", "GEMINI_API_KEY",
             "GEMINI_API_KEY_ALT", "META_API_KEY"]:
    v = os.environ.get(name, "")
    print(f"  {name:<24} {'set, ' + str(len(v)) + ' chars' if v else 'EMPTY'}")

print("providers:")
k = os.environ.get("NVIDIA_NIM_API_KEY")
if k:
    st, _ = call("https://integrate.api.nvidia.com/v1/chat/completions", {"Authorization": f"Bearer {k}"},
                 {"model": "nvidia/nemotron-3.5-lightning-30b-a3b", "max_tokens": 1,
                  "messages": [{"role": "user", "content": "hi"}]})
    _, models = call("https://integrate.api.nvidia.com/v1/models", {"Authorization": f"Bearer {k}"})
    show("nvidia", st, ids(models) if models else None, WANT["nvidia"])

for label, var in [("gemini", "GEMINI_API_KEY"), ("gemini-alt", "GEMINI_API_KEY_ALT")]:
    k = os.environ.get(var)
    if k:
        st, models = call("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
                          {"x-goog-api-key": k})
        show(label, st, ids(models) if st == 200 else None, WANT["gemini"])

k = os.environ.get("META_API_KEY")
if k:
    st, models = call("https://api.meta.ai/v1/models", {"Authorization": f"Bearer {k}"})
    show("meta", st, ids(models) if st == 200 else None, WANT["meta"])
