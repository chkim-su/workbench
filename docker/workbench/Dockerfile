# My LLM Workbench - Dockerized execution environment
#
# Run the workbench in an isolated container for:
# - Reproducible LLM sessions
# - Controlled tool execution
# - Safe code generation and testing
#
# Supports both Claude Code and Codex OAuth providers

FROM node:20-alpine

LABEL description="My LLM Workbench - Dockerized LLM execution environment"
LABEL version="0.1.0"

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    tmux \
    jq \
    python3 \
    py3-pip \
    docker-cli \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Create workbench user
RUN addgroup -g 1000 workbench && \
    adduser -u 1000 -G workbench -h /home/workbench -s /bin/bash -D workbench && \
    addgroup workbench docker 2>/dev/null || true

# Create directories
RUN mkdir -p /app /work /home/workbench/.claude /home/workbench/.workbench && \
    chown -R workbench:workbench /app /work /home/workbench

# Setup npm global for workbench user
USER workbench
WORKDIR /home/workbench

RUN mkdir -p /home/workbench/.npm-global && \
    npm config set prefix '/home/workbench/.npm-global'

# Environment
ENV HOME=/home/workbench
ENV PATH="/home/workbench/.npm-global/bin:$PATH"
ENV CLAUDE_CONFIG_DIR=/home/workbench/.claude
ENV WORKBENCH_STATE_DIR=/home/workbench/.workbench
ENV NODE_ENV=production

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Python dependencies for Codex OAuth
RUN pip3 install --user --no-cache-dir --break-system-packages httpx pyjwt

# Copy workbench application
WORKDIR /app
COPY --chown=workbench:workbench . .

# Install workbench dependencies
RUN npm install --omit=dev 2>/dev/null || true

# Expose port for potential web UI
EXPOSE 3000

# Mount points:
# /work - Project directory to work on
# /home/workbench/.workbench - Persistent state
# /var/run/docker.sock - Docker socket (optional, for nested containers)

WORKDIR /work

# Default command - start the TUI
CMD ["node", "/app/ui/tui/index.js"]
