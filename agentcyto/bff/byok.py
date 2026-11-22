"""Bring-your-own-key upstreams: stream a chat from a user-supplied provider.

Supported API types: ``openai`` (any OpenAI-compatible /chat/completions server),
``anthropic`` (Messages API) and ``gemini`` (Generative Language API).

The API key is only ever held in memory for the lifetime of a job; it is never
written to SQLite, logs or events. Provider URLs are validated so the BFF cannot
be pointed at loopback / private / link-local addresses (SSRF).
"""

import asyncio
import ipaddress
import json
import socket
from typing import AsyncIterator
from urllib.parse import urlsplit

import httpx

API_TYPES = ("openai", "anthropic", "gemini")
DEFAULT_BASES = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "gemini": "https://generativelanguage.googleapis.com",
}
ANTHROPIC_VERSION = "2023-06-01"


class ByokError(Exception):
    pass


async def validate_cfg(cfg: dict, need_model: bool = True) -> dict:
    """Normalise and check a user-supplied provider config. Raises ByokError."""
    api_type = str(cfg.get("api_type") or "openai").lower()
    if api_type not in API_TYPES:
        raise ByokError(f"api_type must be one of {', '.join(API_TYPES)}")
    base = str(cfg.get("base_url") or DEFAULT_BASES[api_type]).strip().rstrip("/")
    key = str(cfg.get("api_key") or "").strip()
    model = str(cfg.get("model") or "").strip()
    if not key:
        raise ByokError("api_key is required")
    if need_model and not model:
        raise ByokError("model is required")
    parts = urlsplit(base)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ByokError("base_url must be an http(s) URL")
    if parts.username or parts.password:
        raise ByokError("base_url must not contain credentials")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, parts.hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ByokError(f"cannot resolve host {parts.hostname}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ByokError("base_url must point to a public host (private/loopback addresses are blocked)")
    return {"api_type": api_type, "base_url": base, "api_key": key, "model": model,
            "label": str(cfg.get("label") or "")[:60]}


def _merge(messages: list[dict]) -> list[dict]:
    """Drop empties and merge consecutive same-role turns (strict APIs need alternation)."""
    out: list[dict] = []
    for m in messages:
        if not (m.get("content") or "").strip():
            continue
        if out and out[-1]["role"] == m["role"]:
            out[-1] = {"role": m["role"], "content": out[-1]["content"] + "\n\n" + m["content"]}
        else:
            out.append({"role": m["role"], "content": m["content"]})
    return out


def _openai_root(base: str) -> str:
    return base[: -len("/chat/completions")] if base.endswith("/chat/completions") else base


def _anthropic_root(base: str) -> str:
    return base[:-3] if base.endswith("/v1") else base


def _gemini_root(base: str) -> str:
    for suffix in ("/v1beta", "/v1"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def _redact(text: str, key: str) -> str:
    return text.replace(key, "***") if key else text


async def _sse(resp: httpx.Response) -> AsyncIterator[tuple[str, dict]]:
    event = ""
    async for line in resp.aiter_lines():
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            raw = line[5:].strip()
            if raw == "[DONE]":
                return
            try:
                yield event, json.loads(raw)
            except json.JSONDecodeError:
                continue
        elif not line:
            event = ""


async def stream_chat(cfg: dict, messages: list[dict], temperature: float | None = None,
                      max_tokens: int | None = None) -> AsyncIterator[tuple[str, object]]:
    """Yield ("delta", str), ("thinking", str), ("usage", dict) and ("model", str)."""
    api_type, base, key, model = cfg["api_type"], cfg["base_url"], cfg["api_key"], cfg["model"]
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    turns = _merge([m for m in messages if m["role"] in ("user", "assistant")])

    if api_type == "openai":
        url = f"{_openai_root(base)}/chat/completions"
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        body: dict = {"model": model, "stream": True,
                      "messages": ([{"role": "system", "content": system}] if system else []) + turns}
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens:
            body["max_tokens"] = max_tokens
    elif api_type == "anthropic":
        url = f"{_anthropic_root(base)}/v1/messages"
        headers = {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION,
                   "Content-Type": "application/json"}
        body = {"model": model, "stream": True, "max_tokens": max_tokens or 4096, "messages": turns}
        if system:
            body["system"] = system
        if temperature is not None:
            body["temperature"] = min(1.0, temperature)
    else:  # gemini
        url = f"{_gemini_root(base)}/v1beta/models/{model}:streamGenerateContent?alt=sse"
        headers = {"x-goog-api-key": key, "Content-Type": "application/json"}
        body = {"contents": [{"role": "model" if m["role"] == "assistant" else "user",
                              "parts": [{"text": m["content"]}]} for m in turns]}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        gen = {}
        if temperature is not None:
            gen["temperature"] = temperature
        if max_tokens:
            gen["maxOutputTokens"] = max_tokens
        if gen:
            body["generationConfig"] = gen

    yield "model", f"{cfg.get('label') or api_type}:{model}"
    usage = {"prompt_tokens": 0, "completion_tokens": 0}
    async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=15), follow_redirects=False) as client:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code >= 400:
                text = _redact((await resp.aread()).decode(errors="replace")[:500], key)
                raise ByokError(f"provider returned {resp.status_code}: {text}")
            async for event, data in _sse(resp):
                if api_type == "openai":
                    if data.get("error"):
                        raise ByokError(_redact(str(data["error"])[:400], key))
                    if data.get("usage"):
                        usage = {"prompt_tokens": data["usage"].get("prompt_tokens", 0),
                                 "completion_tokens": data["usage"].get("completion_tokens", 0)}
                    for ch in data.get("choices") or []:
                        d = ch.get("delta") or {}
                        think = d.get("reasoning_content") or d.get("reasoning")
                        if think:
                            yield "thinking", think
                        if d.get("content"):
                            yield "delta", d["content"]
                elif api_type == "anthropic":
                    t = data.get("type") or event
                    if t == "error":
                        raise ByokError(_redact(str(data.get("error"))[:400], key))
                    if t == "message_start":
                        usage["prompt_tokens"] = ((data.get("message") or {}).get("usage") or {}).get("input_tokens", 0)
                    elif t == "message_delta":
                        usage["completion_tokens"] = (data.get("usage") or {}).get("output_tokens", 0)
                    elif t == "content_block_delta":
                        d = data.get("delta") or {}
                        if d.get("type") == "thinking_delta" and d.get("thinking"):
                            yield "thinking", d["thinking"]
                        elif d.get("text"):
                            yield "delta", d["text"]
                else:
                    um = data.get("usageMetadata") or {}
                    if um:
                        usage = {"prompt_tokens": um.get("promptTokenCount", 0),
                                 "completion_tokens": um.get("candidatesTokenCount", 0)}
                    for cand in data.get("candidates") or []:
                        for p in (cand.get("content") or {}).get("parts") or []:
                            if p.get("text"):
                                yield ("thinking" if p.get("thought") else "delta"), p["text"]
    yield "usage", usage


async def complete(cfg: dict, messages: list[dict], **kw) -> str:
    out = []
    async for kind, val in stream_chat(cfg, messages, **kw):
        if kind == "delta":
            out.append(val)
    return "".join(out)


async def list_models(cfg: dict) -> list[str]:
    api_type, base, key = cfg["api_type"], cfg["base_url"], cfg["api_key"]
    if api_type == "openai":
        url, headers = f"{_openai_root(base)}/models", {"Authorization": f"Bearer {key}"}
    elif api_type == "anthropic":
        url = f"{_anthropic_root(base)}/v1/models?limit=100"
        headers = {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION}
    else:
        url, headers = f"{_gemini_root(base)}/v1beta/models?pageSize=200", {"x-goog-api-key": key}
    async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=10), follow_redirects=False) as client:
        r = await client.get(url, headers=headers)
    if r.status_code >= 400:
        raise ByokError(f"provider returned {r.status_code}: {_redact(r.text[:300], key)}")
    data = r.json()
    if api_type == "gemini":
        return sorted(m["name"].removeprefix("models/") for m in data.get("models", [])
                      if "generateContent" in (m.get("supportedGenerationMethods") or []))
    return sorted(m["id"] for m in data.get("data", []) if m.get("id"))
