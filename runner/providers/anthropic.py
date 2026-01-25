from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from urllib.error import HTTPError


@dataclass
class AnthropicConfig:
    base_url: str
    api_key: str
    model: str


class AnthropicProvider:
    """
    Minimal Anthropic Messages API provider (Claude).
    Uses HTTP directly (no CLI), suitable for Mode B compatibility.
    """

    def __init__(self, cfg: AnthropicConfig):
        self.cfg = cfg

    @staticmethod
    def from_env() -> "AnthropicProvider":
        base = (os.environ.get("WORKBENCH_ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/")
        key = (os.environ.get("WORKBENCH_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or "").strip()
        model = (os.environ.get("WORKBENCH_ANTHROPIC_MODEL") or "claude-3-5-sonnet-latest").strip()
        return AnthropicProvider(AnthropicConfig(base_url=base, api_key=key, model=model))

    def doctor(self, timeout_s: float = 2.0) -> Dict[str, Any]:
        url = f"{self.cfg.base_url}/v1/models"
        headers = {"Accept": "application/json", "anthropic-version": "2023-06-01"}
        if self.cfg.api_key:
            headers["x-api-key"] = self.cfg.api_key

        safe_headers = {"Accept": "application/json", "anthropic-version": "2023-06-01"}
        safe_headers["x-api-key"] = "<redacted>" if self.cfg.api_key else "<missing>"

        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return {"ok": True, "probe": "GET /v1/models", "url": url, "httpStatus": getattr(resp, "status", None), "headers": safe_headers}
        except HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            return {
                "ok": False,
                "probe": "GET /v1/models",
                "url": url,
                "httpStatus": getattr(e, "code", None),
                "headers": safe_headers,
                "error": body[:500] or f"HTTPError({getattr(e, 'code', '?')})",
            }
        except Exception as e:
            return {"ok": False, "probe": "GET /v1/models", "url": url, "headers": safe_headers, "error": str(e)}

    def chat(self, messages: List[Dict[str, Any]], timeout_s: float = 60.0) -> Dict[str, Any]:
        if not self.cfg.api_key:
            raise RuntimeError("Missing Anthropic API key (set WORKBENCH_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY)")

        system_text, anthropic_messages = self._convert_messages(messages)
        url = f"{self.cfg.base_url}/v1/messages"
        body = json.dumps(
            {
                "model": self.cfg.model,
                "max_tokens": 512,
                "temperature": 0,
                "system": system_text,
                "messages": anthropic_messages,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
                "x-api-key": self.cfg.api_key,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)
        except HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            raise RuntimeError(f"LLM request failed (HTTP {getattr(e, 'code', '?')}): {body[:500]}") from e

    def extract_text(self, response: Dict[str, Any]) -> str:
        content = response.get("content")
        if not isinstance(content, list):
            return ""
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)

    def _convert_messages(self, messages: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]]]:
        system_parts: List[str] = []
        out: List[Dict[str, Any]] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if not isinstance(content, str):
                continue
            if role == "system":
                system_parts.append(content)
                continue
            if role in ("user", "assistant"):
                out.append({"role": role, "content": content})
        return ("\n\n".join(system_parts)).strip(), out

