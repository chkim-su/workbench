from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def now_ms() -> int:
    return int(time.time() * 1000)


def _safe_chmod_0600(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


@dataclass
class OAuthProfile:
    profile: str
    access_token: str
    refresh_token: str
    expires_at_ms: int
    email: Optional[str] = None
    account_id: Optional[str] = None
    issuer: Optional[str] = None
    client_id: Optional[str] = None
    remaining: Optional[float] = None
    reset_at_ms: Optional[int] = None
    provider: Optional[str] = None
    last_seen_at: Optional[str] = None
    rate_limited_until_ms: Optional[int] = None
    disabled: bool = False
    updated_at: Optional[str] = None

    def is_usable(self, at_ms: Optional[int] = None) -> bool:
        if self.disabled:
            return False
        at = now_ms() if at_ms is None else at_ms
        until = self.rate_limited_until_ms or 0
        return until <= at

    def is_expired(self, at_ms: Optional[int] = None) -> bool:
        at = now_ms() if at_ms is None else at_ms
        return self.expires_at_ms <= at + 30_000

    def to_json(self) -> Dict[str, Any]:
        return {
            "profile": self.profile,
            "email": self.email,
            "accountId": self.account_id,
            "issuer": self.issuer,
            "clientId": self.client_id,
            "accessToken": self.access_token,
            "refreshToken": self.refresh_token,
            "expiresAtMs": self.expires_at_ms,
            "remaining": self.remaining,
            "resetAtMs": self.reset_at_ms,
            "provider": self.provider,
            "lastSeenAt": self.last_seen_at,
            "rateLimitedUntilMs": self.rate_limited_until_ms,
            "disabled": self.disabled,
            "updatedAt": self.updated_at or now_iso(),
        }

    @staticmethod
    def from_json(obj: Dict[str, Any]) -> "OAuthProfile":
        return OAuthProfile(
            profile=str(obj.get("profile") or ""),
            email=(obj.get("email") if isinstance(obj.get("email"), str) and obj.get("email") else None),
            account_id=(obj.get("accountId") if isinstance(obj.get("accountId"), str) else None),
            issuer=(obj.get("issuer") if isinstance(obj.get("issuer"), str) else None),
            client_id=(obj.get("clientId") if isinstance(obj.get("clientId"), str) else None),
            access_token=str(obj.get("accessToken") or ""),
            refresh_token=str(obj.get("refreshToken") or ""),
            expires_at_ms=int(obj.get("expiresAtMs") or 0),
            remaining=(float(obj.get("remaining")) if isinstance(obj.get("remaining"), (int, float)) else None),
            reset_at_ms=(int(obj.get("resetAtMs")) if isinstance(obj.get("resetAtMs"), int) else None),
            provider=(obj.get("provider") if isinstance(obj.get("provider"), str) and obj.get("provider") else None),
            last_seen_at=(obj.get("lastSeenAt") if isinstance(obj.get("lastSeenAt"), str) and obj.get("lastSeenAt") else None),
            rate_limited_until_ms=(int(obj.get("rateLimitedUntilMs")) if isinstance(obj.get("rateLimitedUntilMs"), int) else None),
            disabled=bool(obj.get("disabled") or False),
            updated_at=(obj.get("updatedAt") if isinstance(obj.get("updatedAt"), str) else None),
        )

    def effective_email(self) -> str:
        return self.email or self.profile

    def effective_remaining(self) -> float:
        if self.remaining is None:
            return 1e18
        try:
            return float(self.remaining)
        except Exception:
            return 1e18

    def effective_reset_at_ms(self) -> int:
        if isinstance(self.reset_at_ms, int) and self.reset_at_ms > 0:
            return int(self.reset_at_ms)
        if isinstance(self.rate_limited_until_ms, int) and self.rate_limited_until_ms > 0:
            return int(self.rate_limited_until_ms)
        return 10**18


@dataclass
class OAuthPool:
    version: int
    provider: str
    updated_at: str
    selection_strategy: str
    pinned_profile: Optional[str]
    last_used_profile: Optional[str]
    profiles: Dict[str, OAuthProfile]

    issuer: Optional[str] = None
    client_id: Optional[str] = None
    model: Optional[str] = None
    codex_endpoint: Optional[str] = None

    @staticmethod
    def empty() -> "OAuthPool":
        return OAuthPool(
            version=1,
            provider="openai.codex.oauth.pool",
            updated_at=now_iso(),
            selection_strategy="sticky",
            pinned_profile=None,
            last_used_profile=None,
            profiles={},
        )

    def to_json(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "provider": self.provider,
            "updatedAt": self.updated_at,
            "issuer": self.issuer,
            "clientId": self.client_id,
            "model": self.model,
            "codexEndpoint": self.codex_endpoint,
            "selection": {
                "strategy": self.selection_strategy,
                "pinnedProfile": self.pinned_profile,
                "lastUsedProfile": self.last_used_profile,
            },
            "profiles": {k: v.to_json() for k, v in self.profiles.items()},
        }

    @staticmethod
    def from_json(obj: Dict[str, Any]) -> "OAuthPool":
        selection = obj.get("selection") if isinstance(obj.get("selection"), dict) else {}
        profs = obj.get("profiles") if isinstance(obj.get("profiles"), dict) else {}
        profiles: Dict[str, OAuthProfile] = {}
        for k, v in profs.items():
            if not isinstance(k, str) or not isinstance(v, dict):
                continue
            p = OAuthProfile.from_json({"profile": k, **v})
            if p.profile:
                profiles[p.profile] = p
        return OAuthPool(
            version=int(obj.get("version") or 1),
            provider=str(obj.get("provider") or "openai.codex.oauth.pool"),
            updated_at=str(obj.get("updatedAt") or now_iso()),
            issuer=(obj.get("issuer") if isinstance(obj.get("issuer"), str) else None),
            client_id=(obj.get("clientId") if isinstance(obj.get("clientId"), str) else None),
            model=(obj.get("model") if isinstance(obj.get("model"), str) else None),
            codex_endpoint=(obj.get("codexEndpoint") if isinstance(obj.get("codexEndpoint"), str) else None),
            selection_strategy=str(selection.get("strategy") or "sticky"),
            pinned_profile=(selection.get("pinnedProfile") if isinstance(selection.get("pinnedProfile"), str) else None),
            last_used_profile=(selection.get("lastUsedProfile") if isinstance(selection.get("lastUsedProfile"), str) else None),
            profiles=profiles,
        )

    def list_profiles(self) -> List[str]:
        return sorted(self.profiles.keys())

    def choose_profile(self, explicit: Optional[str] = None, at_ms: Optional[int] = None) -> str:
        at = now_ms() if at_ms is None else at_ms
        if explicit:
            if explicit not in self.profiles:
                raise RuntimeError(f"OAuth profile not found in pool: {explicit}")
            return explicit
        if self.pinned_profile:
            if self.pinned_profile not in self.profiles:
                raise RuntimeError(f"OAuth pinnedProfile not found in pool: {self.pinned_profile}")
            return self.pinned_profile

        strategy = (self.selection_strategy or "sticky").strip().lower()
        if strategy == "sticky":
            if self.last_used_profile and self.last_used_profile in self.profiles:
                p = self.profiles[self.last_used_profile]
                if p.is_usable(at):
                    return p.profile

        usable = [p for p in self.profiles.values() if p.is_usable(at)]
        if not usable:
            allp = ", ".join(self.list_profiles())
            disabled = [p.profile for p in self.profiles.values() if p.disabled]
            limited = [p.profile for p in self.profiles.values() if (p.rate_limited_until_ms or 0) > at]
            if disabled and len(disabled) == len(self.profiles):
                raise RuntimeError(
                    f"No usable OAuth profiles available (all disabled). Profiles: {allp}. "
                    "Next action: re-login (e.g. `opencode auth login`) and re-import into the workbench pool."
                )
            if limited and len(limited) == len(self.profiles):
                wait_target = min(self.profiles.values(), key=lambda p: (p.effective_reset_at_ms(), p.effective_email()))
                raise RuntimeError(
                    f"No usable OAuth profiles available (all rate-limited). Profiles: {allp}. "
                    f"Wait and retry (nextResetAtMs={wait_target.effective_reset_at_ms()}, email={wait_target.effective_email()})."
                )
            raise RuntimeError(f"No usable OAuth profiles available (all rate-limited or disabled). Profiles: {allp}")

        usable_sorted = sorted(
            usable,
            key=lambda p: (
                p.effective_remaining(),
                p.effective_reset_at_ms(),
                p.effective_email(),
            ),
        )
        if strategy == "round-robin" and self.last_used_profile:
            # Preserve round-robin intent, but keep ordering deterministic.
            usable_profiles = [p.profile for p in usable_sorted]
            if self.last_used_profile in usable_profiles:
                i = usable_profiles.index(self.last_used_profile)
                return usable_profiles[(i + 1) % len(usable_profiles)]
        return usable_sorted[0].profile

    def rotate_after(self, current: str, explicit: Optional[str] = None) -> str:
        if explicit:
            return explicit
        usable = [p for p in self.profiles.values() if p.is_usable()]
        if not usable:
            raise RuntimeError("No usable OAuth profiles available to rotate to")
        ranked = sorted(
            usable,
            key=lambda p: (
                p.effective_remaining(),
                p.effective_reset_at_ms(),
                p.effective_email(),
            ),
        )
        ranked_profiles = [p.profile for p in ranked]
        if current not in ranked_profiles:
            return ranked_profiles[0]
        for p in ranked_profiles:
            if p != current:
                return p
        return current

    def mark_used(self, profile: str) -> None:
        self.last_used_profile = profile
        self.updated_at = now_iso()

    def mark_rate_limited(self, profile: str, until_ms: int) -> None:
        p = self.profiles.get(profile)
        if not p:
            return
        p.rate_limited_until_ms = max(int(until_ms), now_ms())
        p.updated_at = now_iso()
        self.updated_at = now_iso()


def load_pool(path: Path) -> OAuthPool:
    if not path.exists():
        return OAuthPool.empty()
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("Invalid OAuth pool file (expected object)")
    return OAuthPool.from_json(data)


def save_pool(path: Path, pool: OAuthPool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(pool.to_json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _safe_chmod_0600(path)


def upsert_profile(path: Path, profile: OAuthProfile, pool_fields: Dict[str, Optional[str]]) -> Tuple[OAuthPool, str]:
    pool = load_pool(path)
    if pool.version != 1:
        raise RuntimeError("Unsupported OAuth pool version (expected 1)")
    pool.issuer = pool_fields.get("issuer") or pool.issuer
    pool.client_id = pool_fields.get("clientId") or pool.client_id
    pool.model = pool_fields.get("model") or pool.model
    pool.codex_endpoint = pool_fields.get("codexEndpoint") or pool.codex_endpoint
    pool.profiles[profile.profile] = profile
    pool.mark_used(profile.profile)
    save_pool(path, pool)
    return pool, profile.profile
