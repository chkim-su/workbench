# My LLM Workbench - Dockerized execution environment
#
# Run the workbench in an isolated container for:
# - Reproducible LLM sessions
# - Controlled tool execution
# - Safe code generation and testing
#
# Supports both Claude Code and Codex OAuth providers

FROM node:20-slim

LABEL description="My LLM Workbench - Dockerized LLM execution environment"
LABEL version="0.1.0"

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bash \
    tmux \
    jq \
    python3 \
    python3-pip \
    ca-certificates \
    unzip \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Create workbench user
RUN useradd -m -s /bin/bash -u 1001 workbench

# Create directories
RUN mkdir -p /app /work /home/workbench/.claude /home/workbench/.workbench && \
    chown -R workbench:workbench /app /work /home/workbench

# Install Bun for workbench user
USER workbench
ENV HOME=/home/workbench
ENV BUN_INSTALL="/home/workbench/.bun"
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/workbench/.bun/bin:/home/workbench/.npm-global/bin:$PATH"

WORKDIR /home/workbench

RUN mkdir -p /home/workbench/.npm-global && \
    npm config set prefix '/home/workbench/.npm-global'

# Environment
ENV HOME=/home/workbench
ENV CLAUDE_CONFIG_DIR=/home/workbench/.claude
ENV WORKBENCH_STATE_DIR=/home/workbench/.workbench
ENV NODE_ENV=production

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Python dependencies for Codex OAuth
RUN pip3 install --user --no-cache-dir --break-system-packages httpx pyjwt 2>/dev/null || \
    pip3 install --user --no-cache-dir httpx pyjwt

# Copy workbench application
WORKDIR /app
COPY --chown=workbench:workbench . .

# Install workbench dependencies with Bun
RUN bun install --production

# Expose port for potential web UI
EXPOSE 3000

# Mount points:
# /work - Project directory to work on
# /home/workbench/.workbench - Persistent state
# /var/run/docker.sock - Docker socket (optional, for nested containers)

WORKDIR /work

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD bun --version && node --version || exit 1

# Default command - start the TUI
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["node /app/ui/tui/index.js"]
