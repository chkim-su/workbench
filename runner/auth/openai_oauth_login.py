#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from urllib.error import HTTPError

from openai_oauth_pool import OAuthProfile, upsert_profile


HTML_SUCCESS = """<!doctype html>
<html>
  <head><title>Workbench OAuth Login Successful</title></head>
  <body style="font-family: system-ui, sans-serif; text-align: center; padding: 50px;">
    <h1 style="color: #10a37f;">✓ Authorization successful</h1>
    <p>You can close this window and return to your terminal.</p>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>
"""

HTML_ERROR = """<!doctype html>
<html>
  <head><title>Workbench OAuth Login Failed</title></head>
  <body style="font-family: system-ui, sans-serif; text-align: center; padding: 50px;">
    <h1 style="color: #e74c3c;">✗ Authorization failed</h1>
    <p>{error}</p>
    <p>Please close this window and try again.</p>
  </body>
</html>
"""


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def sha256_b64url(text: str) -> str:
    return b64url(hashlib.sha256(text.encode("utf-8")).digest())


def parse_jwt_claims(token: str) -> Optional[Dict[str, Any]]:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        raw = base64.urlsafe_b64decode(payload.encode("utf-8"))
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def extract_account_id(tokens: Dict[str, Any]) -> Optional[str]:
    for k in ("id_token", "access_token"):
        tok = tokens.get(k)
        if not isinstance(tok, str) or not tok:
            continue
        claims = parse_jwt_claims(tok)
        if not isinstance(claims, dict):
            continue
        if isinstance(claims.get("chatgpt_account_id"), str):
            return claims.get("chatgpt_account_id")
        nested = claims.get("https://api.openai.com/auth")
        if isinstance(nested, dict) and isinstance(nested.get("chatgpt_account_id"), str):
            return nested.get("chatgpt_account_id")
        orgs = claims.get("organizations")
        if isinstance(orgs, list) and orgs:
            first = orgs[0]
            if isinstance(first, dict) and isinstance(first.get("id"), str):
                return first.get("id")
    return None


@dataclass
class LoginConfig:
    issuer: str
    client_id: str
    port: int
    path: str
    scope: str
    token_path: Path


class CallbackHandler(BaseHTTPRequestHandler):
    server_version = "workbench-oauth/0"
    callback_state: Optional[str] = None
    callback_code: Optional[str] = None
    callback_error: Optional[str] = None
    _event: Optional[threading.Event] = None

    def do_GET(self) -> None:  # noqa: N802
        url = urllib.parse.urlparse(self.path)
        callback_path = getattr(self.server, "callback_path", "/auth/callback")
        if url.path != callback_path:
            self.send_response(404)
            self.end_headers()
            return

        qs = urllib.parse.parse_qs(url.query)
        code = (qs.get("code") or [None])[0]
        state = (qs.get("state") or [None])[0]
        err = (qs.get("error") or [None])[0]
        err_desc = (qs.get("error_description") or [None])[0]

        if err:
            CallbackHandler.callback_error = err_desc or err
        elif not code:
            CallbackHandler.callback_error = "Missing authorization code"
        elif not state or state != CallbackHandler.callback_state:
            CallbackHandler.callback_error = "Invalid state"
        else:
            CallbackHandler.callback_code = code

        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        if CallbackHandler.callback_error:
            self.wfile.write(HTML_ERROR.format(error=CallbackHandler.callback_error).encode("utf-8"))
        else:
            self.wfile.write(HTML_SUCCESS.encode("utf-8"))
        if CallbackHandler._event:
            CallbackHandler._event.set()

    def log_message(self, fmt: str, *args: object) -> None:
        return


# =============================================================================
# Device Code Flow (fallback for headless/SSH environments)
# =============================================================================

def start_device_code_flow(issuer: str, client_id: str, scope: str, timeout_s: float = 20.0) -> Dict[str, Any]:
    """
    Initiate device authorization flow.
    Returns: { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
    """
    url = f"{issuer}/oauth/device/code"
    body = urllib.parse.urlencode({
        "client_id": client_id,
        "scope": scope,
        "audience": "https://api.openai.com/v1",
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"Device code request failed (HTTP {getattr(e, 'code', '?')}): {body_txt[:500]}") from e


def poll_device_code_tokens(
    issuer: str,
    client_id: str,
    device_code: str,
    interval: int = 5,
    expires_in: int = 600,
    timeout_s: float = 20.0,
) -> Dict[str, Any]:
    """
    Poll for tokens after user completes device authorization.
    Returns tokens dict or raises on error/timeout.
    """
    url = f"{issuer}/oauth/token"
    start = time.time()
    poll_interval = max(interval, 5)

    while (time.time() - start) < expires_in:
        body = urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": device_code,
            "client_id": client_id,
        }).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")

        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            body_txt = ""
            try:
                body_txt = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass

            # Check for pending/slow_down responses
            try:
                err_data = json.loads(body_txt)
                error = err_data.get("error", "")
                if error == "authorization_pending":
                    # User hasn't completed auth yet, keep polling
                    time.sleep(poll_interval)
                    continue
                elif error == "slow_down":
                    # Increase polling interval
                    poll_interval += 5
                    time.sleep(poll_interval)
                    continue
                elif error == "expired_token":
                    raise RuntimeError("Device code expired. Please try again.")
                elif error == "access_denied":
                    raise RuntimeError("Authorization denied by user.")
            except json.JSONDecodeError:
                pass

            raise RuntimeError(f"Device token poll failed (HTTP {getattr(e, 'code', '?')}): {body_txt[:500]}") from e

        time.sleep(poll_interval)

    raise RuntimeError("Device code flow timed out. Please try again.")


def can_open_browser() -> bool:
    """Check if we can open a browser (not in SSH/headless)."""
    # Check common indicators of headless environment
    if os.environ.get("SSH_CLIENT") or os.environ.get("SSH_TTY"):
        return False
    if not os.environ.get("DISPLAY") and sys.platform != "darwin" and sys.platform != "win32":
        return False
    return True


def run_device_code_flow(cfg: LoginConfig) -> Optional[Dict[str, Any]]:
    """Run OAuth device code flow (for headless environments)."""
    print("[workbench-oauth] Starting device code flow...")

    try:
        device_resp = start_device_code_flow(cfg.issuer, cfg.client_id, cfg.scope)
    except Exception as e:
        print(f"[workbench-oauth] ERROR: Failed to start device code flow: {e}")
        print("[workbench-oauth] Note: Device code flow may not be enabled for this client.")
        print("[workbench-oauth] Try using --no-browser flag with PKCE flow instead.")
        return None

    user_code = device_resp.get("user_code", "")
    verification_uri = device_resp.get("verification_uri", "")
    verification_uri_complete = device_resp.get("verification_uri_complete", "")
    device_code = device_resp.get("device_code", "")
    expires_in = int(device_resp.get("expires_in", 600))
    interval = int(device_resp.get("interval", 5))

    print("")
    print("=" * 60)
    print("  DEVICE AUTHORIZATION")
    print("=" * 60)
    print("")
    print(f"  1. Open this URL in any browser:")
    print(f"     {verification_uri_complete or verification_uri}")
    print("")
    print(f"  2. Enter this code when prompted:")
    print(f"     >>> {user_code} <<<")
    print("")
    print(f"  3. Complete the login in your browser")
    print("")
    print("=" * 60)
    print(f"[workbench-oauth] Waiting for authorization (expires in {expires_in}s)...")
    print("[workbench-oauth] Press Ctrl+C to cancel")
    print("")

    try:
        tokens = poll_device_code_tokens(
            cfg.issuer, cfg.client_id, device_code,
            interval=interval, expires_in=expires_in
        )
        print("[workbench-oauth] Authorization successful!")
        return tokens
    except KeyboardInterrupt:
        print("\n[workbench-oauth] Cancelled by user")
        return None
    except Exception as e:
        print(f"[workbench-oauth] ERROR: {e}")
        return None


def run_pkce_flow(cfg: LoginConfig, auto_open: bool = True) -> Optional[Dict[str, Any]]:
    """Run OAuth PKCE redirect flow."""
    redirect_uri = f"http://127.0.0.1:{cfg.port}{cfg.path}"
    code_verifier = b64url(secrets.token_bytes(32)) + b64url(secrets.token_bytes(32))
    code_verifier = code_verifier[:64]
    code_challenge = sha256_b64url(code_verifier)
    state = b64url(secrets.token_bytes(24))

    event = threading.Event()
    CallbackHandler._event = event
    CallbackHandler.callback_state = state
    CallbackHandler.callback_code = None
    CallbackHandler.callback_error = None

    # Start local callback server
    try:
        httpd = HTTPServer(("127.0.0.1", cfg.port), CallbackHandler)
    except OSError as e:
        print(f"[workbench-oauth] ERROR: Could not start callback server on port {cfg.port}: {e}")
        print(f"[workbench-oauth] Try: --device-code flag or set WORKBENCH_OPENAI_OAUTH_PORT to a different port")
        return None

    httpd.callback_path = cfg.path  # type: ignore[attr-defined]

    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()

    url = build_authorize_url(cfg, redirect_uri, code_challenge, state)

    print("")
    if auto_open:
        print("[workbench-oauth] Opening browser for authentication...")
        try:
            webbrowser.open(url)
            print("[workbench-oauth] Browser opened. Complete login in your browser.")
        except Exception as e:
            print(f"[workbench-oauth] Could not open browser: {e}")
            print("[workbench-oauth] Please open this URL manually:")
            print(url)
    else:
        print("[workbench-oauth] Open this URL in your browser and complete login:")
        print(url)

    print("")
    print(f"[workbench-oauth] Waiting for callback on {redirect_uri}")
    print("[workbench-oauth] Timeout: 5 minutes. Press Ctrl+C to cancel.")
    print("")

    try:
        ok = event.wait(timeout=5 * 60)
    except KeyboardInterrupt:
        print("\n[workbench-oauth] Cancelled by user")
        httpd.shutdown()
        return None

    httpd.shutdown()

    if not ok:
        print("[workbench-oauth] ERROR: callback timeout")
        return None
    if CallbackHandler.callback_error:
        print(f"[workbench-oauth] ERROR: {CallbackHandler.callback_error}")
        return None
    if not CallbackHandler.callback_code:
        print("[workbench-oauth] ERROR: no code received")
        return None

    try:
        tokens = exchange_code_for_tokens(cfg, CallbackHandler.callback_code, redirect_uri, code_verifier)
        print("[workbench-oauth] Authorization successful!")
        return tokens
    except Exception as e:
        print(f"[workbench-oauth] ERROR: Token exchange failed: {e}")
        return None


def build_authorize_url(cfg: LoginConfig, redirect_uri: str, code_challenge: str, state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": cfg.client_id,
        "redirect_uri": redirect_uri,
        "scope": cfg.scope,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
        # OpenAI-specific hints (safe to ignore if unsupported):
        "originator": "workbench",
        "codex_cli_simplified_flow": "true",
        "id_token_add_organizations": "true",
    }
    return f"{cfg.issuer}/oauth/authorize?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(cfg: LoginConfig, code: str, redirect_uri: str, code_verifier: str, timeout_s: float = 20.0) -> Dict[str, Any]:
    url = f"{cfg.issuer}/oauth/token"
    body = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": cfg.client_id,
            "code_verifier": code_verifier,
        }
    ).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"Token exchange failed (HTTP {getattr(e, 'code', '?')}): {body_txt[:500]}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description="OpenAI OAuth login for Workbench")
    ap.add_argument("--profile", default=os.environ.get("WORKBENCH_OPENAI_OAUTH_PROFILE") or "", help="OAuth profile name to store into the token pool")
    ap.add_argument(
        "--pool",
        action="store_true",
        help="Store into OAuth pool even if --profile is not provided (auto-assigns profile name)",
    )
    ap.add_argument(
        "--pool-path",
        default=os.environ.get("WORKBENCH_OPENAI_OAUTH_POOL_PATH") or "",
        help="Path to the OAuth token pool JSON (defaults to .workbench/auth/openai_codex_oauth_pool.json)",
    )
    ap.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't auto-open browser; just print the URL",
    )
    ap.add_argument(
        "--device-code",
        action="store_true",
        help="Use device code flow instead of redirect (for headless/SSH environments)",
    )
    args = ap.parse_args()

    issuer = (os.environ.get("WORKBENCH_OPENAI_OAUTH_ISSUER") or "https://auth.openai.com").rstrip("/")
    client_id = (os.environ.get("WORKBENCH_OPENAI_OAUTH_CLIENT_ID") or "").strip()
    if not client_id:
        # Use OpenCode's public client ID as default (for Codex OAuth tokens)
        client_id = "app_EMoamEEZ73f0CkXaXp7hrann"
        print(f"[workbench-oauth] Using default OpenCode client_id: {client_id}")

    port = int((os.environ.get("WORKBENCH_OPENAI_OAUTH_PORT") or "1455").strip())
    path = "/auth/callback"
    scope = (os.environ.get("WORKBENCH_OPENAI_OAUTH_SCOPE") or "openid profile email offline_access").strip()

    repo_root = Path.cwd()
    state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
    token_path = Path(os.environ.get("WORKBENCH_OPENAI_OAUTH_TOKEN_PATH") or (state_dir / "auth" / "openai_codex_oauth.json"))
    pool_path = Path(args.pool_path) if args.pool_path else (state_dir / "auth" / "openai_codex_oauth_pool.json")

    cfg = LoginConfig(issuer=issuer, client_id=client_id, port=port, path=path, scope=scope, token_path=token_path)

    # Determine which flow to use
    use_device_code = args.device_code
    if not use_device_code and not can_open_browser() and not args.no_browser:
        print("[workbench-oauth] Headless environment detected (SSH/no display)")
        print("[workbench-oauth] Falling back to device code flow...")
        use_device_code = True

    if use_device_code:
        # Device Code Flow
        tokens = run_device_code_flow(cfg)
    else:
        # PKCE Redirect Flow
        tokens = run_pkce_flow(cfg, auto_open=not args.no_browser)

    if tokens is None:
        return 1

    account_id = extract_account_id(tokens)

    access = tokens.get("access_token")
    refresh = tokens.get("refresh_token")
    expires_in = tokens.get("expires_in") or 3600

    if not isinstance(access, str) or not isinstance(refresh, str):
        print("[workbench-oauth] ERROR: token response missing access_token/refresh_token")
        return 1

    saved = {
        "version": 1,
        "provider": "openai.codex.oauth",
        "updatedAt": now_iso(),
        "issuer": cfg.issuer,
        "clientId": cfg.client_id,
        "accountId": account_id,
        "accessToken": access,
        "refreshToken": refresh,
        "expiresAtMs": int(time.time() * 1000) + int(expires_in) * 1000,
    }
    profile_name = (args.profile or "").strip()
    store_to_pool = bool(profile_name) or bool(args.pool) or (os.environ.get("WORKBENCH_OPENAI_OAUTH_USE_POOL") or "").strip() == "1"
    if store_to_pool and not profile_name:
        # Auto-assign a stable profile name based on count.
        try:
            existing = json.loads(pool_path.read_text(encoding="utf-8")) if pool_path.exists() else {}
            profs = existing.get("profiles") if isinstance(existing, dict) else {}
            n = len(profs) if isinstance(profs, dict) else 0
            profile_name = f"account{n + 1}"
        except Exception:
            profile_name = "account1"

    if store_to_pool:
        prof = OAuthProfile(
            profile=profile_name,
            issuer=cfg.issuer,
            client_id=cfg.client_id,
            account_id=account_id,
            access_token=access,
            refresh_token=refresh,
            expires_at_ms=int(time.time() * 1000) + int(expires_in) * 1000,
        )
        upsert_profile(
            pool_path,
            prof,
            pool_fields={"issuer": cfg.issuer, "clientId": cfg.client_id, "model": os.environ.get("WORKBENCH_OPENAI_MODEL"), "codexEndpoint": os.environ.get("WORKBENCH_OPENAI_CODEX_ENDPOINT")},
        )
        print(f"[workbench-oauth] Saved token into pool: {pool_path} (profile={profile_name})")
        print("[workbench-oauth] Next: export WORKBENCH_PROVIDER=openai-oauth WORKBENCH_OPENAI_OAUTH_PROFILE=" + profile_name)
        print("[workbench-oauth] Then run: python3 runner/run_smoke.py")
    else:
        cfg.token_path.parent.mkdir(parents=True, exist_ok=True)
        cfg.token_path.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(cfg.token_path, 0o600)
        except Exception:
            pass
        print(f"[workbench-oauth] Saved token: {cfg.token_path}")
        print("[workbench-oauth] Next: export WORKBENCH_PROVIDER=openai-oauth and run: python3 runner/run_smoke.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
