from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.request
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from urllib.error import HTTPError

from auth.openai_oauth_pool import OAuthPool, OAuthProfile, load_pool, now_ms, save_pool


def _now_ms() -> int:
    return int(time.time() * 1000)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _parse_jwt_claims(token: str) -> Optional[Dict[str, Any]]:
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


def _extract_account_id(tokens: Dict[str, Any]) -> Optional[str]:
    for k in ("id_token", "access_token"):
        tok = tokens.get(k)
        if not isinstance(tok, str) or not tok:
            continue
        claims = _parse_jwt_claims(tok)
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
class OpenAICodexOAuthConfig:
    issuer: str
    client_id: str
    model: str
    codex_endpoint: str
    token_path: Path
    pool_path: Path
    selection_profile: Optional[str]
    selection_strategy: str


class HttpStatusError(RuntimeError):
    def __init__(self, status: int, body: str, headers: Optional[Dict[str, str]] = None):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body
        self.headers = headers or {}


HttpPostFn = Callable[[str, bytes, Dict[str, str], float], Dict[str, Any]]


class OpenAICodexOAuthProvider:
    """
    OpenAI OAuth (PKCE) tokens + ChatGPT Codex backend endpoint.

    This follows the same high-level pattern as opencode's Codex OAuth plugin:
    - OAuth tokens from https://auth.openai.com
    - Use Bearer access token + optional ChatGPT-Account-Id header
    - Call https://chatgpt.com/backend-api/codex/responses
    """

    def __init__(self, cfg: OpenAICodexOAuthConfig, http_post: Optional[HttpPostFn] = None):
        self.cfg = cfg
        self._http_post = http_post

    @staticmethod
    def from_env(http_post: Optional[HttpPostFn] = None) -> "OpenAICodexOAuthProvider":
        issuer = (os.environ.get("WORKBENCH_OPENAI_OAUTH_ISSUER") or "https://auth.openai.com").rstrip("/")
        client_id_env = (os.environ.get("WORKBENCH_OPENAI_OAUTH_CLIENT_ID") or "").strip()
        model_env = (os.environ.get("WORKBENCH_OPENAI_MODEL") or "").strip()
        codex_endpoint = (os.environ.get("WORKBENCH_OPENAI_CODEX_ENDPOINT") or "https://chatgpt.com/backend-api/codex/responses").strip()

        repo_root = Path.cwd()
        state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
        token_path = Path(os.environ.get("WORKBENCH_OPENAI_OAUTH_TOKEN_PATH") or (state_dir / "auth" / "openai_codex_oauth.json"))
        pool_path = Path(os.environ.get("WORKBENCH_OPENAI_OAUTH_POOL_PATH") or (state_dir / "auth" / "openai_codex_oauth_pool.json"))

        selection_profile = (os.environ.get("WORKBENCH_OPENAI_OAUTH_PROFILE") or "").strip() or None
        selection_strategy = (os.environ.get("WORKBENCH_OPENAI_OAUTH_STRATEGY") or "sticky").strip()

        # Avoid manual guesswork: allow client_id/model to be sourced from saved pool/token files.
        client_id = client_id_env
        model = model_env

        if (not client_id or not model) and pool_path.exists():
            try:
                pool = load_pool(pool_path)
                client_id = client_id or (pool.client_id or "")
                model = model or (pool.model or "")
                codex_endpoint = (pool.codex_endpoint or "").strip() or codex_endpoint
            except Exception:
                pass

        if (not client_id or not model) and token_path.exists():
            try:
                data = json.loads(token_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    client_id = client_id or str(data.get("clientId") or "")
                    model = model or str(data.get("model") or "")
                    codex_endpoint = str(data.get("codexEndpoint") or "").strip() or codex_endpoint
            except Exception:
                pass

        if not client_id:
            raise RuntimeError(
                "Missing OpenAI OAuth client id. Set WORKBENCH_OPENAI_OAUTH_CLIENT_ID and rerun: python3 runner/auth/openai_oauth_login.py"
            )
        if not model:
            # Default to a common Codex model string; users can override via WORKBENCH_OPENAI_MODEL.
            model = "gpt-5.2-codex"

        return OpenAICodexOAuthProvider(
            OpenAICodexOAuthConfig(
                issuer=issuer,
                client_id=client_id,
                model=model,
                codex_endpoint=codex_endpoint,
                token_path=token_path,
                pool_path=pool_path,
                selection_profile=selection_profile,
                selection_strategy=selection_strategy,
            )
        , http_post=http_post)

    def doctor(self, timeout_s: float = 2.0) -> Dict[str, Any]:
        try:
            pool, origin = self._load_pool_or_single()
            selected = pool.choose_profile(explicit=self.cfg.selection_profile)
            p = pool.profiles[selected]
            return {
                "ok": True,
                "mode": "openai-oauth-codex",
                "issuer": self.cfg.issuer,
                "clientId": self.cfg.client_id,
                "model": self.cfg.model,
                "codexEndpoint": self.cfg.codex_endpoint,
                "origin": origin,
                "poolPath": str(self.cfg.pool_path),
                "tokenPath": str(self.cfg.token_path),
                "profilesCount": len(pool.profiles),
                "profiles": pool.list_profiles(),
                "selectionStrategy": self.cfg.selection_strategy,
                "explicitProfile": self.cfg.selection_profile,
                "pinnedProfile": pool.pinned_profile,
                "lastUsedProfile": pool.last_used_profile,
                "selectedProfile": selected,
                "selectedAccountId": p.account_id,
                "expired": p.is_expired(),
            }
        except Exception as e:
            return {
                "ok": False,
                "mode": "openai-oauth-codex",
                "error": str(e),
                "poolPath": str(self.cfg.pool_path),
                "tokenPath": str(self.cfg.token_path),
            }

    def chat(self, messages: List[Dict[str, Any]], timeout_s: float = 60.0) -> Dict[str, Any]:
        pool, origin = self._load_pool_or_single()
        pool.selection_strategy = self.cfg.selection_strategy

        rotate_on_rate_limit = (os.environ.get("WORKBENCH_OPENAI_OAUTH_ROTATE_ON_RATE_LIMIT") or "1").strip() != "0"
        max_rotations = int((os.environ.get("WORKBENCH_OPENAI_OAUTH_MAX_ROTATIONS") or "0").strip() or "0")
        if max_rotations <= 0:
            max_rotations = max(1, len(pool.profiles))

        instructions, input_messages = self._messages_to_instructions_and_input(messages)
        body = json.dumps({"model": self.cfg.model, "instructions": instructions, "input": input_messages, "store": False, "stream": True}).encode("utf-8")

        attempted: List[str] = []
        selected = pool.choose_profile(explicit=self.cfg.selection_profile)

        for attempt in range(max_rotations):
            if selected in attempted:
                selected = pool.rotate_after(selected, explicit=self.cfg.selection_profile)
            attempted.append(selected)

            profile = pool.profiles.get(selected)
            if not profile:
                raise RuntimeError(f"Selected OAuth profile missing: {selected}")

            try:
                profile = self._ensure_fresh_profile(profile, pool, timeout_s=min(timeout_s, 10.0))
            except Exception as e:
                if self._is_refresh_invalid(e):
                    profile.disabled = True
                    profile.updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    pool.profiles[selected] = profile
                    self._persist_pool(pool, origin)
                    self._emit_event(
                        {
                            "type": "openai_oauth.rotate",
                            "atMs": now_ms(),
                            "fromProfile": selected,
                            "reason": "refresh_invalid",
                            "attempt": attempt + 1,
                            "attemptedProfiles": attempted,
                        }
                    )
                    if len(set(attempted)) >= len(pool.profiles):
                        raise RuntimeError(
                            "OpenAI OAuth refresh token invalid for all profiles. Next action: run `opencode auth login`, "
                            "then rerun `python3 runner/auth/openai_oauth_import_opencode.py` (or use Workbench TUI option 4)."
                        ) from e
                    selected = pool.rotate_after(selected, explicit=self.cfg.selection_profile)
                    continue
                raise
            try:
                resp = self._chat_once(profile, body, timeout_s=timeout_s)
                pool.mark_used(selected)
                self._persist_pool(pool, origin)
                return resp
            except HttpStatusError as e:
                if rotate_on_rate_limit and self._is_rate_limit(e.status, e.body):
                    retry_after_ms = self._retry_after_ms(e.headers) or 10_000
                    pool.mark_rate_limited(selected, until_ms=now_ms() + int(retry_after_ms))
                    self._persist_pool(pool, origin)
                    self._emit_event(
                        {
                            "type": "openai_oauth.rotate",
                            "atMs": now_ms(),
                            "fromProfile": selected,
                            "reason": "rate_limit",
                            "status": e.status,
                            "retryAfterMs": int(retry_after_ms),
                            "attempt": attempt + 1,
                            "attemptedProfiles": attempted,
                        }
                    )
                    if len(set(attempted)) >= len(pool.profiles):
                        raise RuntimeError(f"Rate limited and no alternate OAuth profiles available: {pool.list_profiles()}") from e
                    selected = pool.rotate_after(selected, explicit=self.cfg.selection_profile)
                    continue
                raise RuntimeError(f"LLM request failed (HTTP {e.status}): {e.body[:500]}") from e

        raise RuntimeError(f"Failed after rotating OAuth profiles: attempted={attempted}")

    def extract_text(self, response: Dict[str, Any]) -> str:
        if isinstance(response.get("output_text"), str):
            return response.get("output_text") or ""

        # Try common response-shapes.
        if isinstance(response.get("choices"), list):
            choices = response.get("choices") or []
            if choices:
                msg = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                    return msg.get("content") or ""

        output = response.get("output")
        if isinstance(output, list):
            texts: List[str] = []
            for item in output:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for c in content:
                    if isinstance(c, dict) and isinstance(c.get("text"), str):
                        texts.append(c["text"])
            if texts:
                return "".join(texts)

        return ""

    def _messages_to_prompt(self, messages: List[Dict[str, Any]]) -> str:
        parts: List[str] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if not isinstance(content, str):
                continue
            if role == "system":
                parts.append(f"[system]\n{content}")
            elif role == "user":
                parts.append(f"[user]\n{content}")
            elif role == "assistant":
                parts.append(f"[assistant]\n{content}")
        return "\n\n".join(parts).strip()

    def _messages_to_instructions_and_input(self, messages: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, str]]]:
        """Convert messages to Codex API format: instructions (str) and input (list of message objects)."""
        sys_parts: List[str] = []
        input_messages: List[Dict[str, str]] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if not isinstance(content, str):
                continue
            if role == "system":
                sys_parts.append(content)
            elif role in ("user", "assistant"):
                input_messages.append({"role": role, "content": content})
        instructions = "\n\n".join(sys_parts).strip() or "Workbench session."
        return instructions, input_messages

    def _load_pool_or_single(self) -> Tuple[OAuthPool, str]:
        """
        Returns (pool, origin) where origin is "pool" or "single".

        - Prefer pool file if present.
        - Fall back to legacy single-token file as a 1-profile pool.
        """
        if self.cfg.pool_path.exists():
            pool = load_pool(self.cfg.pool_path)
            if pool.version != 1:
                raise RuntimeError("Invalid OAuth pool file (expected version=1)")
            if not pool.profiles:
                raise RuntimeError(f"OAuth pool file has no profiles: {self.cfg.pool_path}")
            pool.issuer = pool.issuer or self.cfg.issuer
            pool.client_id = pool.client_id or self.cfg.client_id
            pool.model = pool.model or self.cfg.model
            pool.codex_endpoint = pool.codex_endpoint or self.cfg.codex_endpoint
            return pool, "pool"

        if not self.cfg.token_path.exists():
            raise RuntimeError(f"OAuth token file not found: {self.cfg.token_path}")
        data = json.loads(self.cfg.token_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("version") != 1:
            raise RuntimeError("Invalid token file (expected version=1)")
        access = str(data.get("accessToken") or "")
        refresh = str(data.get("refreshToken") or "")
        expires_at_ms = int(data.get("expiresAtMs") or 0)
        if not access or not refresh:
            raise RuntimeError("OAuth token file missing accessToken/refreshToken")

        p = OAuthProfile(
            profile="default",
            access_token=access,
            refresh_token=refresh,
            expires_at_ms=expires_at_ms,
            account_id=(data.get("accountId") if isinstance(data.get("accountId"), str) else None),
            issuer=(data.get("issuer") if isinstance(data.get("issuer"), str) else self.cfg.issuer),
            client_id=(data.get("clientId") if isinstance(data.get("clientId"), str) else self.cfg.client_id),
        )
        pool = OAuthPool.empty()
        pool.issuer = p.issuer
        pool.client_id = p.client_id
        pool.model = str(data.get("model") or "") or self.cfg.model
        pool.codex_endpoint = str(data.get("codexEndpoint") or "") or self.cfg.codex_endpoint
        pool.selection_strategy = self.cfg.selection_strategy
        pool.profiles[p.profile] = p
        pool.last_used_profile = p.profile
        return pool, "single"

    def _persist_pool(self, pool: OAuthPool, origin: str) -> None:
        if origin == "pool":
            save_pool(self.cfg.pool_path, pool)
            return

        # Keep legacy token file updated for compatibility when using single-token mode.
        p = pool.profiles.get("default")
        if not p:
            return
        updated = {
            "version": 1,
            "provider": "openai.codex.oauth",
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "issuer": p.issuer or self.cfg.issuer,
            "clientId": p.client_id or self.cfg.client_id,
            "model": pool.model or self.cfg.model,
            "codexEndpoint": pool.codex_endpoint or self.cfg.codex_endpoint,
            "accountId": p.account_id,
            "accessToken": p.access_token,
            "refreshToken": p.refresh_token,
            "expiresAtMs": p.expires_at_ms,
        }
        self.cfg.token_path.parent.mkdir(parents=True, exist_ok=True)
        self.cfg.token_path.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(self.cfg.token_path, 0o600)
        except Exception:
            pass

    def _ensure_fresh_profile(self, profile: OAuthProfile, pool: OAuthPool, timeout_s: float) -> OAuthProfile:
        if not profile.is_expired():
            return profile
        if not profile.refresh_token:
            raise RuntimeError("OAuth refresh token missing; rerun login")

        client_id = profile.client_id or self.cfg.client_id
        tokens = self._refresh(profile.refresh_token, client_id=client_id, timeout_s=timeout_s)
        access = tokens.get("access_token")
        refresh2 = tokens.get("refresh_token") or profile.refresh_token
        expires_in = tokens.get("expires_in") or 3600

        if not isinstance(access, str) or not access:
            raise RuntimeError("Token refresh did not return access_token")

        profile.access_token = access
        profile.refresh_token = str(refresh2)
        profile.expires_at_ms = now_ms() + int(expires_in) * 1000
        profile.account_id = _extract_account_id(tokens) or profile.account_id
        profile.updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        pool.profiles[profile.profile] = profile
        return profile

    def _refresh(self, refresh_token: str, client_id: str, timeout_s: float) -> Dict[str, Any]:
        url = f"{self.cfg.issuer}/oauth/token"
        body = urllib.parse.urlencode(
            {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id}
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
            raise RuntimeError(f"OAuth refresh failed (HTTP {getattr(e, 'code', '?')}): {body_txt[:500]}") from e

    def _chat_once(self, profile: OAuthProfile, body: bytes, timeout_s: float) -> Dict[str, Any]:
        headers = {"Content-Type": "application/json", "authorization": f"Bearer {profile.access_token}"}
        if isinstance(profile.account_id, str) and profile.account_id:
            headers["ChatGPT-Account-Id"] = profile.account_id

        if self._http_post:
            return self._http_post(self.cfg.codex_endpoint, body, headers, timeout_s)

        req = urllib.request.Request(self.cfg.codex_endpoint, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                # Handle streaming response (SSE format)
                text_parts: List[str] = []
                last_event: Optional[Dict[str, Any]] = None

                for line in resp:
                    line_str = line.decode("utf-8").strip()
                    if not line_str:
                        continue
                    if line_str.startswith("data: "):
                        data_str = line_str[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            event = json.loads(data_str)
                            last_event = event
                            # Extract text from various response formats
                            if event.get("type") == "response.output_text.delta":
                                delta = event.get("delta", "")
                                if isinstance(delta, str):
                                    text_parts.append(delta)
                            elif event.get("type") == "response.completed":
                                # Final response - extract output_text if available
                                response = event.get("response", {})
                                if isinstance(response.get("output_text"), str):
                                    return {"output_text": response["output_text"]}
                        except json.JSONDecodeError:
                            continue

                # Combine accumulated text
                if text_parts:
                    return {"output_text": "".join(text_parts)}
                if last_event:
                    return last_event
                return {}
        except HTTPError as e:
            body_txt = ""
            try:
                body_txt = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            headers_out: Dict[str, str] = {}
            try:
                for k, v in (getattr(e, "headers", None) or {}).items():
                    headers_out[str(k).lower()] = str(v)
            except Exception:
                pass
            raise HttpStatusError(status=int(getattr(e, "code", 0) or 0), body=body_txt, headers=headers_out) from e

    def _is_rate_limit(self, status: int, body: str) -> bool:
        if status == 429:
            return True
        try:
            data = json.loads(body) if body else None
            if isinstance(data, dict) and data.get("type") == "error":
                err = data.get("error") if isinstance(data.get("error"), dict) else None
                if err and isinstance(err.get("type"), str) and err.get("type") in ("too_many_requests", "rate_limit"):
                    return True
                if err and isinstance(err.get("code"), str) and "rate_limit" in err.get("code"):
                    return True
        except Exception:
            pass
        return False

    def _retry_after_ms(self, headers: Dict[str, str]) -> Optional[int]:
        if not headers:
            return None
        ra_ms = headers.get("retry-after-ms")
        if ra_ms:
            try:
                return max(0, int(float(ra_ms)))
            except Exception:
                pass
        ra = headers.get("retry-after")
        if ra:
            try:
                return max(0, int(float(ra) * 1000))
            except Exception:
                pass
            try:
                parsed = int((time.mktime(time.strptime(ra, "%a, %d %b %Y %H:%M:%S %Z")) - time.time()) * 1000)
                return max(0, parsed)
            except Exception:
                pass
        return None

    def _is_refresh_invalid(self, err: Exception) -> bool:
        msg = str(err)
        return "refresh_token_reused" in msg or "invalid_grant" in msg

    def _emit_event(self, obj: Dict[str, Any]) -> None:
        run_dir = (os.environ.get("WORKBENCH_RUN_DIR") or "").strip()
        if not run_dir:
            return
        try:
            path = Path(run_dir) / "provider.openai_oauth.events.jsonl"
            line = json.dumps(obj, ensure_ascii=False) + "\n"
            with path.open("a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            pass
