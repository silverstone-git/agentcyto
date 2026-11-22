# agentcyto documentation

Start with `../AGENTS.md` (rules, status, repo map). Then:

- [architecture.md](architecture.md) — topology, host, containers, data stores, public path
- [secrets-and-security.md](secrets-and-security.md) — secrets (names only) and trust boundaries
- [gateway.md](gateway.md) — LiteLLM aliases, fallback chains, `cli_provider.py`
- [knowledge-base.md](knowledge-base.md) — KB ingestion, API, retrieval, bug history
- [bff-and-frontend.md](bff-and-frontend.md) — BFF API/SSE, React UI, build & deploy
- [operations.md](operations.md) — runbooks, verification, change procedures, troubleshooting
- [reference.md](reference.md) — quick reference

Rule: when a change adds services, ports, env keys, routes, data stores or verification commands,
update the relevant file here in the same commit.
