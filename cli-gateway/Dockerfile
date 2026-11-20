# Gateway image: LiteLLM proxy + the Claude Code and Antigravity CLIs.
# Runs as a non-root user (Claude Code refuses --dangerously-skip-permissions as root).
FROM python:3.12-slim

ARG LITELLM_VERSION=1.110.1
ARG APP_UID=1000
ARG INSTALL_AGY=1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep tini \
 && rm -rf /var/lib/apt/lists/*

RUN pip install "litellm[proxy]==${LITELLM_VERSION}"

RUN useradd --create-home --uid "${APP_UID}" app \
 && mkdir -p /scratch /workspace /workspaces /state /opt/muse/bin \
 && chown app:app /scratch /workspace /workspaces /state /opt/muse

# Muse Code launcher (self-updating binary lives in the mounted /opt/muse/bin volume).
COPY vendor/muse-launcher.sh /opt/muse/bin/muse
RUN chmod 755 /opt/muse/bin/muse

USER app
ENV HOME=/home/app \
    PATH=/opt/muse/bin:/home/app/.local/bin:${PATH} \
    CLAUDE_CONFIG_DIR=/home/app/.claude \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
WORKDIR /home/app

# Claude Code (native installer -> ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && claude --version

# Antigravity CLI. The installer's target dir isn't documented, so find the
# binary afterwards and link it onto PATH. Build with INSTALL_AGY=0 to skip.
RUN if [ "${INSTALL_AGY}" = "1" ]; then \
      curl -fsSL https://antigravity.google/cli/install.sh | bash \
      && mkdir -p "$HOME/.local/bin" \
      && if ! command -v agy >/dev/null 2>&1; then \
           bin="$(find "$HOME" /usr/local/bin -type f -name agy -perm -u+x 2>/dev/null | head -n1)"; \
           [ -n "$bin" ] || { echo "agy binary not found after install" >&2; exit 1; }; \
           ln -sf "$bin" "$HOME/.local/bin/agy"; \
         fi \
      && agy --version; \
    fi

# Login state lives in named volumes mounted over these dirs.
RUN mkdir -p "$HOME/.claude" "$HOME/.gemini"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["litellm", "--config", "/app/config.yaml", "--host", "0.0.0.0", "--port", "4000"]
