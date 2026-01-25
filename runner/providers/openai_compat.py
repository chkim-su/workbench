from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from urllib.error import HTTPError


@dataclass
class OpenAICompatConfig:
    base_url: str
    api_key: str
    model: str


class OpenAICompatProvider:
    def __init__(self, cfg: OpenAICompatConfig):
        self.cfg = cfg

    @staticmethod
    def from_env() -> "OpenAICompatProvider":
        base = os.environ.get("WORKBENCH_OPENAI_BASE_URL") or "https://api.openai.com/v1"
        key = os.environ.get("WORKBENCH_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
        model = os.environ.get("WORKBENCH_OPENAI_MODEL") or "gpt-4.1-mini"
        return OpenAICompatProvider(OpenAICompatConfig(base_url=base.rstrip("/"), api_key=key, model=model))

    def doctor(self, timeout_s: float = 2.0) -> Dict[str, Any]:
        """
        Connectivity probe. Best-effort: /models may not be implemented by all compatible servers.
        """
        url = f"{self.cfg.base_url}/models"
        headers = {}
        if self.cfg.api_key:
            headers["Authorization"] = "Bearer <redacted>"

        req_headers = {"Accept": "application/json"}
        if self.cfg.api_key:
            req_headers["Authorization"] = f"Bearer {self.cfg.api_key}"

        req = urllib.request.Request(url, headers=req_headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return {
                    "ok": True,
                    "probe": "GET /models",
                    "url": url,
                    "httpStatus": getattr(resp, "status", None),
                    "sentAuth": bool(self.cfg.api_key),
                    "headers": headers,
                }
        except HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            return {
                "ok": False,
                "probe": "GET /models",
                "url": url,
                "httpStatus": getattr(e, "code", None),
                "sentAuth": bool(self.cfg.api_key),
                "headers": headers,
                "error": body[:500] or f"HTTPError({getattr(e, 'code', '?')})",
            }
        except Exception as e:
            return {"ok": False, "probe": "GET /models", "url": url, "sentAuth": bool(self.cfg.api_key), "headers": headers, "error": str(e)}

    def chat(self, messages: List[Dict[str, Any]], timeout_s: float = 60.0) -> Dict[str, Any]:
        if not self.cfg.api_key and self.cfg.base_url.rstrip("/") == "https://api.openai.com/v1":
            raise RuntimeError("Missing API key for OpenAI (set WORKBENCH_OPENAI_API_KEY or OPENAI_API_KEY)")

        url = f"{self.cfg.base_url}/chat/completions"
        body = json.dumps(
            {
                "model": self.cfg.model,
                "messages": messages,
                "temperature": 0,
            }
        ).encode("utf-8")

        headers = {"Content-Type": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"

        req = urllib.request.Request(
            url,
            data=body,
            headers=headers,
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
        choices = response.get("choices") or []
        if not choices:
            return ""
        msg = choices[0].get("message") or {}
        return msg.get("content") or ""
