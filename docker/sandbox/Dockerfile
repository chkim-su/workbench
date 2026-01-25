# LLM Sandbox - isolated environment for Claude Code and Codex
#
# Supports:
# - Claude Code (Anthropic) via CLI
# - OpenAI Codex via OAuth (Python provider)
#
# Security note:
# - Credentials are passed via environment variables at runtime
# - Never bake credentials into the image

FROM alpine:3.19

LABEL description="Isolated environment for LLM sessions (Claude Code, Codex)"
LABEL version="0.2.0"

# Install system dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    curl \
    bash \
    tmux \
    jq \
    python3 \
    py3-pip \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1000 llm && \
    adduser -u 1000 -G llm -h /home/llm -s /bin/bash -D llm

# Create directories
RUN mkdir -p /work /home/llm/.claude /home/llm/.cache && \
    chown -R llm:llm /work /home/llm

USER llm
WORKDIR /home/llm

# Setup npm global
RUN mkdir -p /home/llm/.npm-global && \
    npm config set prefix '/home/llm/.npm-global'

# Setup Python user packages
RUN mkdir -p /home/llm/.local/lib/python3.11/site-packages

# Environment
ENV HOME=/home/llm
ENV PATH="/home/llm/.npm-global/bin:/home/llm/.local/bin:$PATH"
ENV PYTHONUSERBASE=/home/llm/.local
ENV CLAUDE_CONFIG_DIR=/home/llm/.claude
ENV NODE_ENV=development

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Python dependencies for Codex
RUN pip3 install --user --no-cache-dir httpx pyjwt

WORKDIR /work

# Health check - verify Claude Code is available
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD claude --version || exit 1

CMD ["bash"]

