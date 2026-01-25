#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from openai_oauth_pool import OAuthProfile, upsert_profile


def now_ms() -> int:
    return int(time.time() * 1000)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def detect_opencode_auth_json() -> Optional[Path]:
    env = (os.environ.get("OPENCODE_AUTH_JSON") or "").strip()
    if env:
        p = Path(env).expanduser()
        return p if p.exists() else None
    p = Path.home() / ".local" / "share" / "opencode" / "auth.json"
    return p if p.exists() else None


def detect_opencode_multi_accounts() -> Optional[Path]:
    env = (os.environ.get("OPENCODE_OPENAI_CODEX_ACCOUNTS_JSON") or "").strip()
    if env:
        p = Path(env).expanduser()
        return p if p.exists() else None
    p = Path.home() / ".opencode" / "openai-codex-accounts.json"
    return p if p.exists() else None


def default_pool_path() -> Path:
    repo_root = Path.cwd()
    state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
    return Path(os.environ.get("WORKBENCH_OPENAI_OAUTH_POOL_PATH") or (state_dir / "auth" / "openai_codex_oauth_pool.json"))


def infer_opencode_client_id() -> Optional[str]:
    env = (os.environ.get("WORKBENCH_OPENAI_OAUTH_CLIENT_ID") or "").strip()
    if env:
        return env

    # Best-effort: if the opencode-dev repo exists at the conventional path, parse CLIENT_ID.
    candidate = Path("/mnt/c/Users/chanhokim/Downloads/opencode-dev/opencode-dev/packages/opencode/src/plugin/codex.ts")
    if candidate.exists():
        try:
            txt = candidate.read_text(encoding="utf-8", errors="replace")
            m = re.search(r'const\s+CLIENT_ID\s*=\s*"([^"]+)"', txt)
            if m:
                return m.group(1)
        except Exception:
            pass

    # Fallback: OpenCode client id from upstream source (public), used for tokens minted via OpenCode.
    # This is required for refresh-token exchange when the refresh token was issued to that client.
    return "app_EMoamEEZ73f0CkXaXp7hrann"


def extract_openai_oauth_from_auth_json(data: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(data, dict):
        return None
    # Prefer explicit keys.
    for key in ("openai", "codex"):
        v = data.get(key)
        if isinstance(v, dict) and v.get("type") == "oauth":
            return v
    # Fallback: search any oauth entry (least surprising if the schema changes).
    for _, v in data.items():
        if isinstance(v, dict) and v.get("type") == "oauth":
            if isinstance(v.get("refresh"), str) and isinstance(v.get("access"), str):
                return v
    return None


def normalize_expires_ms(expires: Any) -> int:
    if isinstance(expires, int):
        return expires
    if isinstance(expires, float):
        return int(expires)
    return now_ms() + 30 * 60 * 1000


def parse_multi_accounts(data: Any) -> List[Dict[str, Any]]:
    """
    Best-effort parser for ~/.opencode/openai-codex-accounts.json from multi-account plugins.
    We support these shapes:
    - { "accounts": [ { refresh, access, expires, accountId?, profile? }, ... ] }
    - [ { refresh, access, expires, ... }, ... ]
    - { "<name>": { refresh, access, expires, ... }, ... }
    """
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        if isinstance(data.get("accounts"), list):
            return [x for x in data.get("accounts") if isinstance(x, dict)]
        # map/object of accounts
        out: List[Dict[str, Any]] = []
        for k, v in data.items():
            if isinstance(v, dict):
                out.append({"profile": k, **v})
        return out
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool-path", default=str(default_pool_path()), help="Workbench OAuth pool path")
    ap.add_argument("--profile", default="", help="Profile name for single-account import (default: opencode1)")
    ap.add_argument("--issuer", default="https://auth.openai.com", help="OAuth issuer")
    ap.add_argument("--codex-endpoint", default="https://chatgpt.com/backend-api/codex/responses", help="Codex endpoint")
    ap.add_argument("--model", default=os.environ.get("WORKBENCH_OPENAI_MODEL") or "gpt-5.2-codex", help="Default model for the pool")
    args = ap.parse_args()

    auth_json = detect_opencode_auth_json()
    multi = detect_opencode_multi_accounts()
    pool_path = Path(args.pool_path).expanduser()
    client_id = infer_opencode_client_id()

    imported: List[str] = []

    if multi and multi.exists():
        raw = read_json(multi)
        accounts = parse_multi_accounts(raw)
        if not accounts:
            print(f"[workbench] Found {multi} but could not parse any accounts", file=sys.stderr)
        for idx, a in enumerate(accounts):
            refresh = a.get("refresh") or a.get("refreshToken") or a.get("refresh_token")
            access = a.get("access") or a.get("accessToken") or a.get("access_token")
            expires = a.get("expires") or a.get("expiresAtMs") or a.get("expires_at_ms")
            if not isinstance(refresh, str) or not isinstance(access, str):
                continue
            prof = (a.get("profile") if isinstance(a.get("profile"), str) else "") or f"opencode{idx+1}"
            account_id = a.get("accountId") if isinstance(a.get("accountId"), str) else None
            profile = OAuthProfile(
                profile=prof,
                issuer=args.issuer,
                client_id=client_id,
                account_id=account_id,
                access_token=access,
                refresh_token=refresh,
                expires_at_ms=normalize_expires_ms(expires),
            )
            upsert_profile(
                pool_path,
                profile,
                pool_fields={"issuer": args.issuer, "clientId": client_id, "model": args.model, "codexEndpoint": args.codex_endpoint},
            )
            imported.append(prof)

    if not imported and auth_json and auth_json.exists():
        data = read_json(auth_json)
        entry = extract_openai_oauth_from_auth_json(data)
        if not entry:
            print(f"[workbench] No OpenAI oauth entry found in {auth_json}", file=sys.stderr)
            return 2
        refresh = entry.get("refresh")
        access = entry.get("access")
        expires = entry.get("expires")
        if not isinstance(refresh, str) or not isinstance(access, str):
            print(f"[workbench] OpenAI oauth entry in {auth_json} missing refresh/access", file=sys.stderr)
            return 2
        prof = (args.profile or "").strip() or "opencode1"
        profile = OAuthProfile(
            profile=prof,
            issuer=args.issuer,
            client_id=client_id,
            account_id=None,
            access_token=access,
            refresh_token=refresh,
            expires_at_ms=normalize_expires_ms(expires),
        )
        upsert_profile(
            pool_path,
            profile,
            pool_fields={"issuer": args.issuer, "clientId": client_id, "model": args.model, "codexEndpoint": args.codex_endpoint},
        )
        imported.append(prof)

    if not imported:
        print("[workbench] No accounts imported. Expected either:", file=sys.stderr)
        print("- ~/.opencode/openai-codex-accounts.json (multi-account plugin), or", file=sys.stderr)
        print("- ~/.local/share/opencode/auth.json with an openai oauth entry", file=sys.stderr)
        return 2

    print(
        json.dumps(
            {
                "ok": True,
                "importedProfiles": imported,
                "poolPath": str(pool_path),
                "sourceAuthJson": str(auth_json) if auth_json else None,
                "sourceMultiAccounts": str(multi) if multi else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print("\n[workbench] Next command (real Codex via OAuth pool):")
    print("export WORKBENCH_PROVIDER=openai-oauth WORKBENCH_VERIFY_REAL_LLM=1; workbench verify --full")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
