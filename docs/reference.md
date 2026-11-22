# Quick reference

Env key names, endpoints, critical paths and the one-line health check.

> Section numbers (§N) are preserved from the former monolithic `AGENTS.md` so older references still resolve.

## 17. Appendix — quick reference

### Env key names (values never)

```
Root .env:                 GEMINI_API_KEY, GEMINI_API_KEY_alt, NVIDIA_API_KEY,
                           LITELLM_MASTER_KEY, AUTHKEY, META_API_KEY

gateway.env:               LITELLM_MASTER_KEY, NVIDIA_NIM_API_KEY,
                           GEMINI_API_KEY, GEMINI_API_KEY_ALT,
                           META_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (empty)
```

### Key endpoints

```
GET  http://127.0.0.1:4000/health/liveliness
POST http://127.0.0.1:4000/v1/chat/completions
GET  http://127.0.0.1:4000/v1/models
GET  http://127.0.0.1:8890/api/health                 (BFF, needs X-Auth-User)
POST http://127.0.0.1:8890/api/chat                   (durable job)
GET  http://127.0.0.1:8890/api/stream?job_id=…&after=0  (SSE replay)
GET  http://127.0.0.1:8890/api/kb/status              (KB: source dir, counts, latest ingestion)
POST http://127.0.0.1:8890/api/kb/ingest              (KB: ingest all .md files, idempotent)
GET  http://127.0.0.1:8890/api/kb/documents           (KB: list documents)
GET  http://127.0.0.1:8890/api/kb/search?q=…          (KB: FTS5 full-text search)
GET  http://127.0.0.1:8890/api/kb/equations           (KB: list equations)
GET  http://127.0.0.1:8890/api/kb/symbols             (KB: list symbols)
POST http://127.0.0.1:8890/api/sessions/{id}/autoname (BFF: AI-generated chat title)
GET  https://t.aryan.cfd/agentcyto/api/health        (live, basic auth)
POST https://t.aryan.cfd/agentcyto/api/v1/chat/completions  (OpenAI-compatible; Authorization: Bearer <LITELLM_MASTER_KEY>)
GET  https://t.aryan.cfd/agentcyto/api/v1/models     (OpenAI-compatible model list; same bearer auth)
```

### Critical file paths

```
/home/ubuntu/cyto/agentcyto/.env
/home/ubuntu/cyto/agentcyto/workspaces/<hex-session-id>/
/home/ubuntu/cyto/agentcyto/repo/physics/          (KB source of truth: 13 physics .md files, read-only)
/home/ubuntu/cyto/agentcyto/agentcyto/bff/app.py
/home/ubuntu/cyto/agentcyto/agentcyto/bff/db.py
/home/ubuntu/cyto/agentcyto/agentcyto/bff/kb.py    (KB ingestion pipeline)
/home/ubuntu/cyto/agentcyto/agentcyto/bff/modes.yaml
/home/ubuntu/cyto/agentcyto/agentcyto/state/agentcyto.db
/home/ubuntu/cyto/agentcyto/agentcyto/ui/
/home/ubuntu/cyto/agentcyto/cli-gateway/secrets/gateway.env
/home/ubuntu/cyto/agentcyto/cli-gateway/secrets/cli-state/
/home/ubuntu/cyto/agentcyto/cli-gateway/gateway/config.yaml
/home/ubuntu/cyto/agentcyto/cli-gateway/gateway/cli_provider.py
/etc/nginx/sites-available/t.aryan.cfd               (route live)
/etc/nginx/.htpasswd-agentcyto                       (generated from AUTHKEY)
```

### One-line health check

```sh
docker compose --project-directory cli-gateway ps --status running --services | grep -qx gateway && \
curl -fsS http://127.0.0.1:4000/health/liveliness >/dev/null && echo OK
```
