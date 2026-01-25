#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict

REPO_ROOT = Path.cwd()
sys.path.insert(0, str(REPO_ROOT / "runner"))

from providers.openai_oauth_codex import HttpStatusError, OpenAICodexOAuthProvider  # noqa: E402
from auth.openai_oauth_pool import OAuthPool, OAuthProfile, save_pool  # noqa: E402


def fake_codex_http_post(url: str, body: bytes, headers: Dict[str, str], timeout_s: float) -> Dict[str, Any]:
    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if "tokenA" in auth:
        raise HttpStatusError(429, json.dumps({"type": "error", "error": {"type": "too_many_requests"}}), {"retry-after-ms": "50"})
    if "tokenB" in auth:
        return {"output_text": '{"tool":"workbench.registry.scan","arguments":{"timeoutMs":10000}}'}
    raise HttpStatusError(401, "unauthorized", {})


def main() -> int:
    state_dir = Path(tempfile.mkdtemp(prefix="workbench_oauth_pool_test_"))
    auth_dir = state_dir / "auth"
    auth_dir.mkdir(parents=True, exist_ok=True)
    pool_path = auth_dir / "openai_codex_oauth_pool.json"

    pool = OAuthPool.empty()
    pool.client_id = "app_test"
    pool.model = "gpt-5.2-codex"
    pool.codex_endpoint = "http://example.invalid/codex"
    pool.selection_strategy = "sticky"
    pool.profiles = {
        "a": OAuthProfile(profile="a", access_token="tokenA", refresh_token="refreshA", expires_at_ms=int(time.time() * 1000) + 86_400_000),
        "b": OAuthProfile(profile="b", access_token="tokenB", refresh_token="refreshB", expires_at_ms=int(time.time() * 1000) + 86_400_000),
    }
    pool.last_used_profile = "a"
    save_pool(pool_path, pool)

    env = os.environ.copy()
    env["WORKBENCH_STATE_DIR"] = str(state_dir)
    env["WORKBENCH_OPENAI_OAUTH_POOL_PATH"] = str(pool_path)
    env["WORKBENCH_OPENAI_OAUTH_CLIENT_ID"] = "app_test"
    env["WORKBENCH_OPENAI_MODEL"] = "gpt-5.2-codex"
    env["WORKBENCH_OPENAI_CODEX_ENDPOINT"] = "http://example.invalid/codex"
    env["WORKBENCH_OPENAI_OAUTH_ROTATE_ON_RATE_LIMIT"] = "1"
    os.environ.update(env)

    provider = OpenAICodexOAuthProvider.from_env(http_post=fake_codex_http_post)

    # First chat should rotate away from tokenA (429) to tokenB and succeed.
    resp1 = provider.chat([{"role": "user", "content": "test"}], timeout_s=2.0)
    assert isinstance(resp1, dict) and isinstance(resp1.get("output_text"), str)

    # Second chat should stay on tokenB (sticky) and also succeed without revisiting tokenA.
    resp2 = provider.chat([{"role": "user", "content": "test2"}], timeout_s=2.0)
    assert isinstance(resp2, dict) and isinstance(resp2.get("output_text"), str)

    # Pool should persist rate-limit marker for a and last-used profile b.
    data = json.loads(pool_path.read_text(encoding="utf-8"))
    assert data.get("version") == 1
    sel = data.get("selection") or {}
    assert sel.get("lastUsedProfile") == "b"
    profiles = data.get("profiles") or {}
    assert int(profiles["a"].get("rateLimitedUntilMs") or 0) > int(time.time() * 1000)

    print(json.dumps({"ok": True, "stateDir": str(state_dir), "poolPath": str(pool_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
