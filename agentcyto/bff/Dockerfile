# BFF image: holds the LiteLLM master key, owns sessions/jobs/usage.
FROM python:3.12-slim

ARG APP_UID=1001
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY bff/requirements.txt ./
RUN pip install -r requirements.txt

COPY bff/app.py bff/db.py bff/kb.py bff/byok.py bff/modes.yaml ./
COPY ui/ ./ui/

RUN useradd --create-home --uid "${APP_UID}" app \
 && mkdir -p /state /workspaces \
 && chown -R app:app /state /workspaces /app

USER app
ENV CLI_WORKSPACE_DIR=/workspaces \
    AGENCYTO_DB=/state/agentcyto.db \
    GATEWAY_SESSION_DB=/gateway-state/sessions.db \
    AGENCYTO_MODES=/app/modes.yaml

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
