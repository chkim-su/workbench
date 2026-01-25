# Verification

Run the end-to-end real-test gates:

- Recommended: `./bin/workbench verify`
- Also works: `bun run verify` (or `node verify/run.js` from the repo root)

Artifacts are written under `.workbench/`.

UX v1 output:
- A machine-readable gate summary is written to `.workbench/verify/gates/<runId>/summary.json`.

Runner dogfooding:
- Gate5 runs `python3 runner/run_smoke.py` in mock mode by default (no credentials required).
- Real LLM runner is reported as OK/skipped based on configuration and opt-in.

OAuth (opencode-like):
- If you want no API keys, configure OpenAI OAuth, then rerun `node verify/run.js`.
- Multi-account pool (recommended): `python3 runner/auth/openai_oauth_login.py --pool --profile account1`
- Single-account (legacy): `python3 runner/auth/openai_oauth_login.py`
- Pool management: `python3 runner/auth/openai_oauth_manage.py list|pin|unpin|strategy`
- Import from existing OpenCode login (recommended if you already use OpenCode): `python3 runner/auth/openai_oauth_import_opencode.py`

Claude Code (raw via tmux):
- If you use Claude Code locally: `export WORKBENCH_PROVIDER=claude-code WORKBENCH_VERIFY_REAL_LLM=1; bun run verify`
