#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path.cwd()
sys.path.insert(0, str(REPO_ROOT / "runner"))

from auth.openai_oauth_pool import OAuthPool, OAuthProfile, save_pool  # noqa: E402


def main() -> int:
    state_dir = Path(tempfile.mkdtemp(prefix="workbench_oauth_pool_deterministic_test_"))
    auth_dir = state_dir / "auth"
    auth_dir.mkdir(parents=True, exist_ok=True)
    pool_path = auth_dir / "openai_codex_oauth_pool.json"

    now_ms = int(time.time() * 1000)

    pool = OAuthPool.empty()
    pool.selection_strategy = "sticky"
    pool.profiles = {
        "p1": OAuthProfile(profile="p1", email="b@example.com", access_token="t1", refresh_token="r1", expires_at_ms=now_ms + 86_400_000, remaining=100, reset_at_ms=now_ms + 5_000),
        "p2": OAuthProfile(profile="p2", email="a@example.com", access_token="t2", refresh_token="r2", expires_at_ms=now_ms + 86_400_000, remaining=100, reset_at_ms=now_ms + 1_000),
        "p3": OAuthProfile(profile="p3", email="c@example.com", access_token="t3", refresh_token="r3", expires_at_ms=now_ms + 86_400_000, remaining=50, reset_at_ms=now_ms + 9_000),
    }
    pool.last_used_profile = None
    save_pool(pool_path, pool)

    # Smallest remaining first.
    chosen = pool.choose_profile(at_ms=now_ms)
    assert chosen == "p3"

    # Remaining tie -> earliest resetAtMs.
    pool.profiles["p3"].remaining = 100
    chosen2 = pool.choose_profile(at_ms=now_ms)
    assert chosen2 == "p2"

    # Remaining+reset tie -> email lexicographical order.
    pool.profiles["p1"].reset_at_ms = pool.profiles["p2"].reset_at_ms
    chosen3 = pool.choose_profile(at_ms=now_ms)
    assert chosen3 == "p2"  # a@example.com

    # rotate_after chooses best candidate excluding current.
    rotated = pool.rotate_after("p2")
    assert rotated in ("p1", "p3")
    assert rotated != "p2"

    # All rate limited -> deterministic wait target surfaced.
    for p in pool.profiles.values():
        p.rate_limited_until_ms = now_ms + 10_000
    try:
        pool.choose_profile(at_ms=now_ms)
        raise AssertionError("expected choose_profile to fail when all are rate-limited")
    except RuntimeError as e:
        msg = str(e)
        assert "nextResetAtMs=" in msg
        assert "email=" in msg

    print(json.dumps({"ok": True, "stateDir": str(state_dir), "poolPath": str(pool_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
