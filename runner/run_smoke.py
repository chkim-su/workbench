#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from mcp_stdio import McpStdioClient, mcp_initialize
from providers.anthropic import AnthropicProvider
from providers.claude_code_tmux import ClaudeCodeTmuxProvider
from providers.mock import MockProvider
from providers.openai_compat import OpenAICompatProvider
from providers.openai_oauth_codex import OpenAICodexOAuthProvider


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


EVENT_SCHEMA_VERSION = 1
SUMMARY_SCHEMA_VERSION = 1


class EvidenceWriter:
    def __init__(self, path: Path, max_bytes: int):
        self.path = path
        self.max_bytes = max_bytes
        self._disabled = False

    def append(self, obj: Dict[str, Any]) -> None:
        if self._disabled:
            return

        line = json.dumps({"schemaVersion": EVENT_SCHEMA_VERSION, **obj}, ensure_ascii=False) + "\n"
        try:
            current = self.path.stat().st_size if self.path.exists() else 0
        except Exception:
            current = 0
        if self.max_bytes > 0 and current + len(line.encode("utf-8", errors="replace")) > self.max_bytes:
            self._disabled = True
            truncated = json.dumps(
                {"schemaVersion": EVENT_SCHEMA_VERSION, "type": "evidence.truncated", "at": now_iso(), "maxBytes": self.max_bytes},
                ensure_ascii=False,
            )
            if self.max_bytes <= 0:
                return
            try:
                if current + len(truncated.encode("utf-8", errors="replace")) + 1 <= self.max_bytes:
                    with self.path.open("a", encoding="utf-8") as f:
                        f.write(truncated + "\n")
            except Exception:
                pass
            return

        with self.path.open("a", encoding="utf-8") as f:
            f.write(line)


def autosync_opencode_oauth(repo_root: Path, timeout_s: float = 30.0) -> Dict[str, Any]:
    """
    Best-effort: import OpenCode OAuth tokens into the Workbench pool.
    Never raises: returns a result object for evidence/diagnosis.
    """
    cmd = ["python3", "runner/auth/openai_oauth_import_opencode.py"]
    try:
        p = subprocess.run(
            cmd,
            cwd=str(repo_root),
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_s,
        )
        return {
            "ok": p.returncode == 0,
            "cmd": cmd,
            "exitCode": p.returncode,
            "stdoutTail": (p.stdout or "").strip()[-1000:],
            "stderrTail": (p.stderr or "").strip()[-1000:],
        }
    except Exception as e:
        return {"ok": False, "cmd": cmd, "error": str(e)}


def parse_tool_json(text: str) -> Dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


def env_bool(name: str) -> bool:
    return (os.environ.get(name) or "").strip() in ("1", "true", "TRUE", "yes", "YES", "on", "ON")


def redact_text(text: str, secrets: List[str]) -> str:
    for s in secrets:
        if s:
            text = text.replace(s, "<redacted>")
    text = re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer <redacted>", text)
    return text


def redact_obj(obj: Any, secrets: List[str]) -> Any:
    if isinstance(obj, str):
        return redact_text(obj, secrets)
    if isinstance(obj, list):
        return [redact_obj(x, secrets) for x in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if str(k).lower() in ("authorization", "api_key", "apikey"):
                out[k] = "<redacted>"
            else:
                out[k] = redact_obj(v, secrets)
        return out
    return obj


class ConfigError(RuntimeError):
    pass


def resolve_provider() -> Tuple[Any, Dict[str, Any], List[str]]:
    """
    Returns (provider, provider_info, secrets_to_redact).

    Supported shapes:
    - Remote OpenAI-style: requires API key.
    - Local OpenAI-compatible: allows no key only with explicit opt-in.
    - Mock: deterministic offline provider for CI/offline.
    """
    mode = (os.environ.get("WORKBENCH_PROVIDER") or "auto").strip().lower()
    allow_noauth = env_bool("WORKBENCH_OPENAI_ALLOW_NOAUTH")

    base_url_env = (os.environ.get("WORKBENCH_OPENAI_BASE_URL") or "").strip()
    model_env = (os.environ.get("WORKBENCH_OPENAI_MODEL") or "").strip()
    key = (os.environ.get("WORKBENCH_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY") or "").strip()

    default_base = "https://api.openai.com/v1"
    default_model = "gpt-4.1-mini"
    base_url = (base_url_env or default_base).rstrip("/")
    model = model_env or default_model
    is_default_openai = base_url == default_base

    if mode in ("mock", "mock-v1"):
        provider = MockProvider.from_env()
        info = {"mode": "mock", "baseUrl": None, "model": None, "sendAuth": False, "authReason": "mock provider"}
        return provider, info, []

    if mode in ("anthropic",):
        key_a = (os.environ.get("WORKBENCH_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or "").strip()
        model_a = (os.environ.get("WORKBENCH_ANTHROPIC_MODEL") or "").strip()
        if not key_a:
            example = "WORKBENCH_PROVIDER=anthropic WORKBENCH_ANTHROPIC_API_KEY=... WORKBENCH_ANTHROPIC_MODEL=claude-3-5-sonnet-latest python3 runner/run_smoke.py"
            raise ConfigError(f"Runner provider config error: missing WORKBENCH_ANTHROPIC_API_KEY/ANTHROPIC_API_KEY. Example: {example}")
        if not model_a:
            example = "WORKBENCH_PROVIDER=anthropic WORKBENCH_ANTHROPIC_API_KEY=... WORKBENCH_ANTHROPIC_MODEL=claude-3-5-sonnet-latest python3 runner/run_smoke.py"
            raise ConfigError(f"Runner provider config error: missing WORKBENCH_ANTHROPIC_MODEL. Example: {example}")
        provider = AnthropicProvider.from_env()
        info = {"mode": "anthropic", "baseUrl": provider.cfg.base_url, "model": provider.cfg.model, "sendAuth": True, "authReason": "Anthropic API key required"}
        return provider, info, [key_a]

    if mode in ("claude", "claude-code", "claude-tmux", "claude-code-raw"):
        # Claude Code CLI provider. No API keys required here; it uses local Claude Code auth.
        provider = ClaudeCodeTmuxProvider.from_env()
        info = {
            "mode": "claude-code-tmux",
            "baseUrl": None,
            "model": provider.cfg.model,
            "sendAuth": False,
            "authReason": "Claude Code local auth (CLI)",
            "claudeBin": provider.cfg.claude_bin,
            "permissionMode": provider.cfg.permission_mode,
        }
        return provider, info, []

    if mode in ("openai-oauth", "openai-codex-oauth", "oauth-openai"):
        try:
            provider = OpenAICodexOAuthProvider.from_env()
        except Exception as e:
            example = (
                "python3 runner/auth/openai_oauth_login.py && "
                "WORKBENCH_PROVIDER=openai-oauth WORKBENCH_OPENAI_MODEL=gpt-5.2-codex python3 runner/run_smoke.py"
            )
            raise ConfigError(f"Runner provider config error: {str(e)}. Example: {example}")

        # Load tokens for redaction.
        secrets: List[str] = []
        try:
            data = json.loads(provider.cfg.token_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for k in ("accessToken", "refreshToken"):
                    if isinstance(data.get(k), str):
                        secrets.append(data.get(k))
        except Exception:
            pass

        info = {
            "mode": "openai-oauth-codex",
            "baseUrl": provider.cfg.codex_endpoint,
            "model": provider.cfg.model,
            "sendAuth": True,
            "authReason": "OpenAI OAuth access token (stored under .workbench/auth/)",
            "tokenPath": str(provider.cfg.token_path),
        }
        return provider, info, secrets

    if mode in ("openai-remote", "remote"):
        if not key:
            example = "WORKBENCH_PROVIDER=openai-remote WORKBENCH_OPENAI_API_KEY=... python3 runner/run_smoke.py"
            raise ConfigError(f"Runner provider config error: missing WORKBENCH_OPENAI_API_KEY/OPENAI_API_KEY. Example: {example}")
        provider = OpenAICompatProvider.from_env()
        info = {
            "mode": "openai-remote",
            "baseUrl": base_url,
            "model": model,
            "sendAuth": True,
            "authReason": "remote provider requires API key",
            "apiKeyPresent": True,
        }
        return provider, info, [key]

    if mode in ("openai-local", "local"):
        missing = []
        if not base_url_env:
            missing.append("WORKBENCH_OPENAI_BASE_URL")
        if not model_env:
            missing.append("WORKBENCH_OPENAI_MODEL")
        if missing:
            example = "WORKBENCH_PROVIDER=openai-local WORKBENCH_OPENAI_BASE_URL=http://localhost:11434/v1 WORKBENCH_OPENAI_MODEL=... WORKBENCH_OPENAI_ALLOW_NOAUTH=1 python3 runner/run_smoke.py"
            raise ConfigError(f"Runner provider config error: missing {', '.join(missing)}. Example: {example}")
        if not key and not allow_noauth:
            example = "WORKBENCH_PROVIDER=openai-local WORKBENCH_OPENAI_BASE_URL=http://localhost:11434/v1 WORKBENCH_OPENAI_MODEL=... WORKBENCH_OPENAI_ALLOW_NOAUTH=1 python3 runner/run_smoke.py"
            raise ConfigError(f"Runner provider config error: local mode without API key requires explicit opt-in WORKBENCH_OPENAI_ALLOW_NOAUTH=1. Example: {example}")
        provider = OpenAICompatProvider.from_env()
        info = {
            "mode": "openai-local",
            "baseUrl": base_url,
            "model": model,
            "sendAuth": bool(key),
            "authReason": "API key provided" if key else "explicit no-auth opt-in (WORKBENCH_OPENAI_ALLOW_NOAUTH=1)",
            "apiKeyPresent": bool(key),
            "allowNoAuth": allow_noauth,
        }
        return provider, info, [key] if key else []

    # auto mode resolution
    key_a = (os.environ.get("WORKBENCH_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    model_a = (os.environ.get("WORKBENCH_ANTHROPIC_MODEL") or "").strip()
    if key_a and model_a:
        provider = AnthropicProvider.from_env()
        info = {"mode": "anthropic", "baseUrl": provider.cfg.base_url, "model": provider.cfg.model, "sendAuth": True, "authReason": "Anthropic API key required"}
        return provider, info, [key_a]

    # Prefer OAuth if token exists (no API keys).
    try:
        provider_oauth = OpenAICodexOAuthProvider.from_env()
        info = {
            "mode": "openai-oauth-codex",
            "baseUrl": provider_oauth.cfg.codex_endpoint,
            "model": provider_oauth.cfg.model,
            "sendAuth": True,
            "authReason": "OpenAI OAuth access token (stored under .workbench/auth/)",
            "tokenPath": str(provider_oauth.cfg.token_path),
            "poolPath": str(getattr(provider_oauth.cfg, "pool_path", "")) or None,
            "profile": getattr(provider_oauth.cfg, "selection_profile", None),
        }
        secrets: List[str] = []
        try:
            pool_path = getattr(provider_oauth.cfg, "pool_path", None)
            if isinstance(pool_path, Path) and pool_path.exists():
                pool_data = json.loads(pool_path.read_text(encoding="utf-8"))
                if isinstance(pool_data, dict):
                    profiles = pool_data.get("profiles")
                    if isinstance(profiles, dict):
                        for _, v in profiles.items():
                            if isinstance(v, dict):
                                for k in ("accessToken", "refreshToken"):
                                    if isinstance(v.get(k), str):
                                        secrets.append(v.get(k))
            else:
                data = json.loads(provider_oauth.cfg.token_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for k in ("accessToken", "refreshToken"):
                        if isinstance(data.get(k), str):
                            secrets.append(data.get(k))
        except Exception:
            pass
        return provider_oauth, info, secrets
    except Exception:
        pass

    if base_url_env and not is_default_openai:
        # Treat as local attempt. Require explicit model + either key or allow-noauth.
        missing = []
        if not model_env:
            missing.append("WORKBENCH_OPENAI_MODEL")
        if missing:
            example = "WORKBENCH_OPENAI_BASE_URL=http://localhost:11434/v1 WORKBENCH_OPENAI_MODEL=... WORKBENCH_OPENAI_ALLOW_NOAUTH=1 python3 runner/run_smoke.py"
            raise ConfigError(f"Runner provider config error: local base URL detected; missing {', '.join(missing)}. Example: {example}")
        if not key and not allow_noauth:
            example = "WORKBENCH_OPENAI_BASE_URL=http://localhost:11434/v1 WORKBENCH_OPENAI_MODEL=... WORKBENCH_OPENAI_ALLOW_NOAUTH=1 python3 runner/run_smoke.py"
            raise ConfigError(f"Runner provider config error: local base URL detected; set WORKBENCH_OPENAI_ALLOW_NOAUTH=1 (or provide WORKBENCH_OPENAI_API_KEY). Example: {example}")
        provider = OpenAICompatProvider.from_env()
        info = {
            "mode": "openai-local",
            "baseUrl": base_url,
            "model": model,
            "sendAuth": bool(key),
            "authReason": "API key provided" if key else "explicit no-auth opt-in (WORKBENCH_OPENAI_ALLOW_NOAUTH=1)",
            "apiKeyPresent": bool(key),
            "allowNoAuth": allow_noauth,
        }
        return provider, info, [key] if key else []

    # Default: remote OpenAI-style.
    if not key:
        example = "WORKBENCH_PROVIDER=mock python3 runner/run_smoke.py  # offline\nWORKBENCH_PROVIDER=openai-remote WORKBENCH_OPENAI_API_KEY=... python3 runner/run_smoke.py"
        raise ConfigError(f"Runner provider config error: missing API key for remote OpenAI-style mode. Examples:\n{example}")
    provider = OpenAICompatProvider.from_env()
    info = {
        "mode": "openai-remote",
        "baseUrl": base_url,
        "model": model,
        "sendAuth": True,
        "authReason": "remote provider requires API key",
        "apiKeyPresent": True,
    }
    return provider, info, [key]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-steps", type=int, default=12)
    args = ap.parse_args()

    repo_root = Path.cwd()
    state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
    run_id = f"run_{int(time.time())}"
    run_dir = state_dir / "runs" / run_id
    ensure_dir(run_dir)

    # Make run directory available to providers for durable evidence artifacts.
    os.environ["WORKBENCH_RUN_DIR"] = str(run_dir)

    events_path = run_dir / "events.jsonl"
    summary_path = run_dir / "summary.json"

    evidence_max = int((os.environ.get("WORKBENCH_EVIDENCE_MAX_BYTES") or "20000000").strip() or "20000000")

    try:
        provider, provider_info, secrets = resolve_provider()
    except ConfigError as e:
        summary = {
            "schemaVersion": SUMMARY_SCHEMA_VERSION,
            "runId": run_id,
            "runDir": str(run_dir),
            "events": str(events_path),
            "workflowId": None,
            "stateDir": str(state_dir),
            "provider": {"mode": "unconfigured"},
            "errorKind": "config",
            "error": str(e).replace("\n", " "),
        }
        write_json(summary_path, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        print(f"\n[workbench-runner] CONFIG ERROR: {summary['error']}")
        print(f"- Evidence: {summary_path}")
        return 2

    # Tool routing starts with the registry server only; other tools become available after registry.scan.
    registry = McpStdioClient(command=["bun", "mcp/servers/registry/src/index.js"], cwd=str(repo_root), env=os.environ.copy())
    mcp_initialize(registry, timeout_s=10.0)

    registry_tools = registry.request("tools/list", None, timeout_s=10.0)
    registry_tool_names = [t.get("name") for t in (registry_tools.get("result") or {}).get("tools", []) if isinstance(t, dict)]

    evidence = EvidenceWriter(events_path, max_bytes=evidence_max)

    messages: List[Dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "You are a tool-using agent.\n"
                "When you need to call a tool, output ONLY a single-line JSON object:\n"
                '{"tool":"<tool_name>","arguments":{...}}\n'
                'When finished, output ONLY: {"final":"..."}\n'
                "Do not output anything else."
                "\nYou MUST call tools to complete the scenario and MUST NOT output a final answer until all required tool calls are done."
                f"\n\nInitial tools available: {', '.join(sorted([n for n in registry_tool_names if isinstance(n, str)]))}"
            ),
        },
        {
            "role": "user",
            "content": (
                f"Use workflow id: smoke_{int(time.time() * 1000)}\n"
                "Run the smoke scenario strictly in this order using tool calls:\n"
                "1) Call tool workbench.registry.scan with {\"timeoutMs\": 10000}\n"
                "2) Call tool workbench.workflow.upload with a minimal workflow definition:\n"
                "   {\"version\":1,\"id\":\"smoke_<timestamp>\",\"steps\":[{\"id\":\"s1\",\"kind\":\"note\",\"note\":\"hello\"}]}\n"
                "3) Call tool workbench.workflow.status for that workflow id\n"
                "4) Call tool workbench.workflow.update with {\"id\":...,\"note\":\"updated\"}\n"
                "5) Call tool workbench.workflow.status again and then finish.\n"
            ),
        },
    ]

    evidence.append({"type": "run.start", "at": now_iso(), "runId": run_id, "provider": redact_obj(provider_info, secrets)})

    tool_clients: Dict[str, McpStdioClient] = {"workbench.registry": registry}
    tool_to_server: Dict[str, Tuple[str, Dict[str, Any]]] = {}
    current_workflow_id: Optional[str] = None
    discovered_servers: List[str] = []
    discovered_tools: List[str] = []

    def sha256_text(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()

    def try_read_text(path: Path) -> Optional[str]:
        try:
            return path.read_text(encoding="utf-8")
        except Exception:
            return None

    def snapshot_state() -> Dict[str, Any]:
        snap: Dict[str, Any] = {}
        reg_path = state_dir / "registry" / "mcp.json"
        reg_raw = try_read_text(reg_path)
        if reg_raw is not None:
            snap["registry"] = {"path": str(reg_path), "sha256": sha256_text(reg_raw)}

        if current_workflow_id:
            wf_dir = state_dir / "workflows" / current_workflow_id
            status_path = wf_dir / "status.json"
            def_path = wf_dir / "definition.json"
            s_raw = try_read_text(status_path)
            d_raw = try_read_text(def_path)
            snap["workflow"] = {
                "id": current_workflow_id,
                "dir": str(wf_dir),
                "status": {"path": str(status_path), "sha256": sha256_text(s_raw) if s_raw is not None else None},
                "definition": {"path": str(def_path), "sha256": sha256_text(d_raw) if d_raw is not None else None},
            }
        return snap

    def load_registry_mapping() -> None:
        nonlocal tool_to_server
        nonlocal discovered_servers, discovered_tools
        reg_path = state_dir / "registry" / "mcp.json"
        data = json.loads(reg_path.read_text(encoding="utf-8"))
        mapping: Dict[str, Tuple[str, Dict[str, Any]]] = {}
        for server_name, entry in (data.get("servers") or {}).items():
            manifest = entry.get("manifest") or {}
            tools = entry.get("tools") or []
            for tname in tools:
                mapping[tname] = (server_name, manifest)
        tool_to_server = mapping
        discovered_servers = sorted({v[0] for v in tool_to_server.values()})
        discovered_tools = sorted(tool_to_server.keys())

    def get_client_for_tool(tool_name: str) -> McpStdioClient:
        server_name, manifest = tool_to_server[tool_name]
        if server_name in tool_clients:
            return tool_clients[server_name]
        cmd = manifest.get("command")
        cwd = manifest.get("cwd") or "."
        client = McpStdioClient(command=cmd, cwd=str((repo_root / cwd).resolve()), env=os.environ.copy())
        mcp_initialize(client, timeout_s=10.0)
        tool_clients[server_name] = client
        return client

    def call_tool(client: McpStdioClient, tool_name: str, arguments: Any, timeout_s: float) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
        return client.request_with_meta("tools/call", {"name": tool_name, "arguments": arguments}, timeout_s)

    def extract_first_json_content(jsonrpc_resp: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            result = jsonrpc_resp.get("result") or {}
            content = result.get("content") or []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "json" and isinstance(item.get("json"), dict):
                    return item["json"]
        except Exception:
            pass
        return None

    error: Optional[str] = None
    error_kind: Optional[str] = None
    tool_calls_seen: List[str] = []
    expected = [
        "workbench.registry.scan",
        "workbench.workflow.upload",
        "workbench.workflow.status",
        "workbench.workflow.update",
        "workbench.workflow.status",
    ]
    expected_i = 0
    bad_outputs = 0

    # Provider doctor (best-effort probe).
    doctor = {}
    try:
        doctor = provider.doctor(timeout_s=2.0) if hasattr(provider, "doctor") else {"ok": None, "note": "no doctor()"}
    except Exception as e:
        doctor = {"ok": False, "error": str(e)}

    # Best-effort auto-heal: if OpenAI OAuth profiles were disabled, re-import from OpenCode and retry doctor once.
    try:
        autosync = (os.environ.get("WORKBENCH_OPENAI_OAUTH_AUTOSYNC_OPENCODE") or "1").strip() != "0"
        if autosync and (provider_info or {}).get("mode") == "openai-oauth-codex":
            err_txt = str((doctor or {}).get("error") or "")
            if (doctor or {}).get("ok") is False and "No usable OAuth profiles available" in err_txt:
                sync_result = autosync_opencode_oauth(repo_root)
                evidence.append({"type": "oauth.autosync.opencode", "at": now_iso(), "result": redact_obj(sync_result, secrets)})
                try:
                    doctor = provider.doctor(timeout_s=2.0) if hasattr(provider, "doctor") else doctor
                except Exception as e:
                    doctor = {"ok": False, "error": str(e), "autosync": sync_result}
    except Exception:
        pass
    evidence.append({"type": "provider.doctor", "at": now_iso(), "provider": redact_obj(provider_info, secrets), "doctor": redact_obj(doctor, secrets)})
    try:
        for step in range(args.max_steps):
            evidence.append({"type": "llm.request", "at": now_iso(), "step": step, "messages": redact_obj(messages, secrets)})
            llm_resp = provider.chat(messages, timeout_s=60.0)  # type: ignore[attr-defined]
            content = provider.extract_text(llm_resp)
            raw_text = json.dumps(redact_obj(llm_resp, secrets), ensure_ascii=False)
            if len(raw_text) > 20000:
                raw_text = raw_text[:20000] + "...<truncated>"
            content_redacted = redact_text(content, secrets)
            evidence.append({"type": "llm.response", "at": now_iso(), "step": step, "rawText": raw_text, "content": content_redacted})

            try:
                call = parse_tool_json(content)
            except Exception as exc:
                evidence.append({"type": "llm.parse_error", "at": now_iso(), "error": str(exc), "content": content_redacted})
                bad_outputs += 1
                if bad_outputs >= 5:
                    raise RuntimeError("LLM output was not parseable JSON too many times")
                next_required = expected[expected_i] if expected_i < len(expected) else "workbench.workflow.status"
                messages.append({"role": "assistant", "content": content_redacted})
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "Output ONLY a single-line JSON tool call. No prose.\n"
                            f'Example: {{"tool":"{next_required}","arguments":{{...}}}}'
                        ),
                    }
                )
                continue

            if "final" in call:
                if expected_i < len(expected):
                    bad_outputs += 1
                    if bad_outputs >= 5:
                        raise RuntimeError(f"Model tried to finish early too many times; next required tool is {expected[expected_i]}")
                    messages.append({"role": "assistant", "content": content_redacted})
                    messages.append(
                        {
                            "role": "user",
                            "content": f"Do NOT finish yet. Next required tool is {expected[expected_i]}. Output ONLY the tool-call JSON.",
                        }
                    )
                    continue
                evidence.append({"type": "run.final", "at": now_iso(), "final": call["final"]})
                break

            tool = call.get("tool")
            arguments = call.get("arguments", {})
            if not isinstance(tool, str) or not tool:
                raise RuntimeError(f"Invalid tool call: {call}")

            if expected_i < len(expected) and tool != expected[expected_i]:
                msg = f"Incorrect tool. Next required tool is {expected[expected_i]}. Output ONLY the tool-call JSON."
                evidence.append({"type": "tool.rejected", "at": now_iso(), "tool": tool, "expected": expected[expected_i]})
                messages.append({"role": "assistant", "content": content})
                messages.append({"role": "user", "content": msg})
                continue

            server = "workbench.registry" if tool == "workbench.registry.scan" else tool_to_server.get(tool, (None, None))[0]

            if tool == "workbench.registry.scan":
                started = time.time()
                req, resp, meta = call_tool(registry, tool, arguments, timeout_s=120.0)
                tool_calls_seen.append(tool)
                expected_i = min(expected_i + 1, len(expected))
                evidence.append(
                    redact_obj(
                        {
                            "type": "tool.call",
                            "at": now_iso(),
                            "tool": tool,
                            "server": "workbench.registry",
                            "arguments": arguments,
                            "jsonrpcRequest": req,
                            "jsonrpcResponse": resp,
                            "process": meta,
                            "durationMs": int((time.time() - started) * 1000),
                            "state": snapshot_state(),
                        },
                        secrets,
                    )
                )
                load_registry_mapping()
                evidence.append({"type": "registry.loaded", "at": now_iso(), "servers": discovered_servers, "tools": discovered_tools})
                messages.append({"role": "assistant", "content": content})
                messages.append({"role": "user", "content": f"Tool result for {tool}: {json.dumps(resp, ensure_ascii=False)}"})
                messages.append({"role": "user", "content": f"Discovered tools: {', '.join(sorted(tool_to_server.keys()))}"})
                continue

            if not tool_to_server:
                raise RuntimeError("No tools discovered yet. The LLM must call workbench.registry.scan first.")

            client = get_client_for_tool(tool)
            started = time.time()
            req, resp, meta = call_tool(client, tool, arguments, timeout_s=60.0)
            duration_ms = int((time.time() - started) * 1000)

            if tool == "workbench.workflow.upload":
                status = extract_first_json_content(resp)
                if isinstance(status, dict) and isinstance(status.get("id"), str):
                    current_workflow_id = status["id"]

            tool_calls_seen.append(tool)
            expected_i = min(expected_i + 1, len(expected))
            evidence.append(
                redact_obj(
                    {
                        "type": "tool.call",
                        "at": now_iso(),
                        "tool": tool,
                        "server": server,
                        "arguments": arguments,
                        "jsonrpcRequest": req,
                        "jsonrpcResponse": resp,
                        "process": meta,
                        "durationMs": duration_ms,
                        "state": snapshot_state(),
                    },
                    secrets,
                )
            )

            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": f"Tool result for {tool}: {json.dumps(resp, ensure_ascii=False)}"})
    except Exception as exc:
        error = str(exc)
        error_kind = "runtime"
        evidence.append({"type": "run.error", "at": now_iso(), "error": redact_text(error, secrets)})
    finally:
        for c in tool_clients.values():
            c.stop()

    summary = {
        "schemaVersion": SUMMARY_SCHEMA_VERSION,
        "runId": run_id,
        "runDir": str(run_dir),
        "events": str(events_path),
        "workflowId": current_workflow_id,
        "discoveredServers": discovered_servers,
        "discoveredTools": discovered_tools,
        "toolCallsSeen": tool_calls_seen,
        "provider": redact_obj(provider_info, secrets),
        "providerDoctor": redact_obj(doctor, secrets),
        "stateDir": str(state_dir),
        "errorKind": error_kind,
        "error": redact_text(error, secrets) if error else None,
    }
    write_json(summary_path, summary)

    # Update pointer file for TUI state aggregation
    current_path = state_dir / "state" / "current.json"
    current_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        current = json.loads(current_path.read_text(encoding="utf-8")) if current_path.exists() else {"schemaVersion": 1}
    except Exception:
        current = {"schemaVersion": 1}
    current["runnerRunId"] = run_id
    current["updatedAt"] = now_iso()
    current_path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if error:
        print("\n[workbench-runner] FAILED")
        print(f"- Evidence: {events_path}")
        print("- Next action: run in mock mode: WORKBENCH_PROVIDER=mock python3 runner/run_smoke.py")
        if (provider_info or {}).get("mode") == "openai-oauth-codex":
            print("- Next action (openai oauth): run `opencode auth login`, then `workbench oauth-import-opencode`, then rerun.")
        else:
            print("- Next action (real LLM): set WORKBENCH_PROVIDER=openai-remote|openai-local and required env vars, then rerun.")
        return 1

    print("\n[workbench-runner] OK")
    print(f"- Evidence: {events_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
