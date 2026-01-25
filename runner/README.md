# Workbench Runner

Minimal runner that exercises a real end-to-end tool loop:

`LLM → tool call → MCP stdio JSON-RPC → tool result → LLM next step`

## Run (smoke scenario)

This will:
1) Ask the LLM to call `workbench.registry.scan`
2) Then call workflow tools: upload → status → update → status
3) Persist evidence to `.workbench/runs/<runId>/`

### OpenAI-compatible provider

Set:
- `WORKBENCH_PROVIDER=openai-remote` (remote, requires API key) or `WORKBENCH_PROVIDER=openai-local` (local, optional key)
- `WORKBENCH_OPENAI_BASE_URL` (e.g. `https://api.openai.com/v1` or a local OpenAI-compatible server)
- `WORKBENCH_OPENAI_API_KEY` (or `OPENAI_API_KEY`)
- `WORKBENCH_OPENAI_MODEL` (e.g. `gpt-4.1-mini`)

Run:
- `python3 runner/run_smoke.py`

### Anthropic (Claude) provider

Set:
- `WORKBENCH_PROVIDER=anthropic`
- `WORKBENCH_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`)
- `WORKBENCH_ANTHROPIC_MODEL` (e.g. `claude-3-5-sonnet-latest`)

Run:
- `python3 runner/run_smoke.py`

### OpenAI OAuth (opencode-like, no API key)

This is the OAuth flow used by OpenCode's Codex integration pattern: OAuth login first, then calls the ChatGPT Codex backend endpoint.

1) Login (starts a localhost callback server):
- `export WORKBENCH_OPENAI_OAUTH_CLIENT_ID=...`
- Single-account (legacy file): `python3 runner/auth/openai_oauth_login.py`
- Multi-account pool (recommended): `python3 runner/auth/openai_oauth_login.py --pool --profile account1`

2) Run smoke with OAuth tokens:
- `export WORKBENCH_PROVIDER=openai-oauth`
- `export WORKBENCH_OPENAI_MODEL=gpt-5.2-codex` (optional; defaults if not set)
- Optional selection:
  - `export WORKBENCH_OPENAI_OAUTH_PROFILE=account1`
  - `export WORKBENCH_OPENAI_OAUTH_STRATEGY=sticky|round-robin`
- `python3 runner/run_smoke.py`

Rotation behavior:
- If the current OAuth profile hits rate limits (HTTP 429 / `too_many_requests`), the provider marks it as rate-limited in the pool and auto-rotates to the next usable profile, continuing the same conversation.

Manage pool:
- `python3 runner/auth/openai_oauth_manage.py list`
- `python3 runner/auth/openai_oauth_manage.py pin account1` (force one profile)
- `python3 runner/auth/openai_oauth_manage.py unpin`
- `python3 runner/auth/openai_oauth_manage.py strategy round-robin`
- Import from OpenCode (reuses your existing OpenCode OAuth login): `python3 runner/auth/openai_oauth_import_opencode.py`

### Claude Code (raw via tmux, no API key)

If you have Claude Code installed and logged in (subscription/token), you can run the runner using the CLI provider:

- `export WORKBENCH_PROVIDER=claude-code`
- `export WORKBENCH_VERIFY_REAL_LLM=1`
- `python3 runner/run_smoke.py`

Optional:
- `export WORKBENCH_CLAUDE_MODEL=sonnet`

#### Optional: Local OpenAI-compatible

If you want to use a local OpenAI-compatible server, point the runner at it (this is optional; OAuth/Claude Code do not require local LLMs).
- Set: `WORKBENCH_OPENAI_BASE_URL=http://localhost:11434/v1`
- Set: `WORKBENCH_OPENAI_MODEL=<your-model>`
- Set: `WORKBENCH_OPENAI_ALLOW_NOAUTH=1` (or provide `WORKBENCH_OPENAI_API_KEY`)
- Run: `python3 runner/run_smoke.py`

### Notes

- The runner uses `mcp/servers/registry` as the initial toolset.
- After `workbench.registry.scan`, it loads `.workbench/registry/mcp.json` to route tool calls to other servers.
- Evidence is written to `.workbench/runs/<runId>/events.jsonl` and `.workbench/runs/<runId>/summary.json`.
