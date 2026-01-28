#!/usr/bin/env node
/**
 * Workbench MCP Server - Shared instance for Codex & Claude Code
 *
 * Transport: HTTP (single endpoint)
 * Namespace: workbench.*
 * Execution: Forwards to Executor via system.requests.jsonl
 *
 * Architecture Invariant:
 * - MCP server NEVER writes JSONL directly
 * - Only the Executor is the single authority for evidence/logs
 * - MCP returns immediate "accepted" response
 */
import { createServer } from 'http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readImageArtifact, readTextArtifact } from './artifacts.js';

const PORT = parseInt(process.env.WORKBENCH_MCP_PORT || '8765', 10);
const stateDir = process.env.WORKBENCH_STATE_DIR || path.join(process.cwd(), '.workbench');

// Tool definitions - stable namespace, vendor-neutral
const TOOLS = {
  'workbench.docker.probe': {
    description: 'Check Docker daemon status and version',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  'workbench.docker.ps': {
    description: 'List running containers',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        all: { type: 'boolean', description: 'Show all containers (including stopped)' },
      },
    },
  },
  'workbench.sandbox.status': {
    description: 'Get sandbox container status',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Sandbox container name' },
      },
    },
  },
  'workbench.sandbox.start': {
    description: 'Start sandbox container with tmux',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Container name (default: workbench-docker)' },
        image: { type: 'string', description: 'Docker image (default: claude-sandbox:base)' },
        workspace: { type: 'string', description: 'Host path to mount at /work' },
      },
    },
  },
  'workbench.sandbox.exec': {
    description: 'Execute command in sandbox',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        name: { type: 'string', description: 'Sandbox container name' },
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' },
      },
    },
  },
  'workbench.sandbox.stop': {
    description: 'Stop and remove sandbox container',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Sandbox container name' },
      },
    },
  },
  'workbench.verify': {
    description: 'Run verification harness',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        full: { type: 'boolean', description: 'Run full verification including Docker' },
      },
    },
  },
  'workbench.codex.swap': {
    description: 'Swap Codex OAuth account. Automatically selects next available profile and restarts Codex with session resume.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targetProfile: { type: 'string', description: 'Specific profile name to swap to (optional, auto-selects if not provided)' },
        tmuxServer: { type: 'string', description: 'tmux server name (default: workbench)' },
        tmuxSession: { type: 'string', description: 'tmux session name (default: workbench)' },
        window: { type: 'string', description: 'tmux window name (default: control)' },
        paneRole: { type: 'string', description: 'Target pane role (default: main)' },
      },
    },
  },
  'workbench.results.get': {
    description: 'Get result of a previous action by correlation ID. Returns logical resource.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['correlationId'],
      properties: {
        correlationId: { type: 'string', description: 'Correlation ID from accepted response' },
      },
    },
  },
  'workbench.results.list': {
    description: 'List recent action results.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Number of results to return (default: 10)' },
        action: { type: 'string', description: 'Filter by action type' },
      },
    },
  },
  'workbench.artifacts.list': {
    description: 'List artifacts for a completed action result (by correlationId).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['correlationId'],
      properties: {
        correlationId: { type: 'string', description: 'Correlation ID from accepted response' },
      },
    },
  },
  'workbench.artifacts.read_text': {
    description: 'Read a text artifact from the Workbench state directory (.workbench).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to read (must be under WORKBENCH_STATE_DIR)' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read (default: 262144)' },
        tailBytes: { type: 'number', description: 'If set, read only the last N bytes (useful for logs)' },
      },
    },
  },
  'workbench.artifacts.read_image': {
    description: 'Read an image artifact from the Workbench state directory (.workbench) as base64.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to read (must be under WORKBENCH_STATE_DIR)' },
        maxBytes: { type: 'number', description: 'Maximum file size in bytes (default: 2097152)' },
      },
    },
  },
};

// Helper functions
function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function genCorrelationId() {
  return `cid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function toolOkJson(obj) {
  return { content: [{ type: 'json', json: obj }] };
}

function toolErrText(message) {
  return { content: [{ type: 'text', text: String(message ?? 'error') }], isError: true };
}

function readCurrentSessionId() {
  const currentPath = path.join(stateDir, 'state', 'current.json');
  ensureDir(path.dirname(currentPath));
  try {
    if (fs.existsSync(currentPath)) {
      const data = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
      if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
        return data.sessionId.trim();
      }
    }
  } catch {}

  // Create new session ID if none exists
  const id = `sess_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const data = { schemaVersion: 1, sessionId: id, updatedAt: now };
  fs.writeFileSync(currentPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  return id;
}

function getSystemPaths() {
  const sessionId = readCurrentSessionId();
  const base = path.join(stateDir, sessionId);
  return {
    sessionId,
    base,
    requestsPath: path.join(base, 'system.requests.jsonl'),
    responsesPath: path.join(base, 'system.responses.jsonl'),
  };
}

// Forward request to Executor by appending to system.requests.jsonl
// This is the only place the MCP server touches JSONL - and it's the request queue, not responses
function forwardToExecutor(request) {
  const { requestsPath } = getSystemPaths();
  ensureDir(path.dirname(requestsPath));
  if (!fs.existsSync(requestsPath)) {
    fs.writeFileSync(requestsPath, '', 'utf8');
  }
  const payload = { version: 1, ...request };
  fs.appendFileSync(requestsPath, JSON.stringify(payload) + '\n', { encoding: 'utf8' });
  return payload;
}

// Read responses from JSONL (for results.get and results.list)
function readResponses(filterFn, limit = 50) {
  const { responsesPath } = getSystemPaths();
  if (!fs.existsSync(responsesPath)) {
    return [];
  }
  const content = fs.readFileSync(responsesPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const responses = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.version === 1 && (!filterFn || filterFn(obj))) {
        responses.push(obj);
      }
    } catch {}
  }
  return responses.slice(-limit);
}

function getResultByCorrelationId(cid) {
  if (!cid) return null;
  const results = readResponses(r => r.correlationId === cid, 1);
  return results.length ? results[0] : null;
}

// Handle tool calls - forward to Executor, return immediate "accepted"
function handleToolCall(toolName, args) {
  // Read-only tools (do not enqueue work)
  if (toolName === 'workbench.results.get') {
    const cid = args?.correlationId;
    if (!cid) return toolErrText('Missing correlationId');
    const r = getResultByCorrelationId(cid);
    if (!r) return toolOkJson({ status: 'pending', correlationId: cid, message: 'Result not yet available' });
    return toolOkJson({
      status: 'completed',
      correlationId: cid,
      ok: r.ok,
      action: r.action,
      summary: r.summary,
      detail: r.detail,
      artifacts: r.artifacts || {},
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
    });
  }

  if (toolName === 'workbench.results.list') {
    const limit = args?.limit || 10;
    const actionFilter = args?.action;
    const results = readResponses(
      actionFilter ? r => r.action?.includes(actionFilter) : null,
      limit
    );
    return toolOkJson({
      status: 'ok',
      count: results.length,
      results: results.map(r => ({
        correlationId: r.correlationId,
        action: r.action,
        ok: r.ok,
        summary: r.summary,
        endedAt: r.endedAt,
      })),
    });
  }

  if (toolName === 'workbench.artifacts.list') {
    const cid = args?.correlationId;
    if (!cid) return toolErrText('Missing correlationId');
    const r = getResultByCorrelationId(cid);
    if (!r) return toolOkJson({ status: 'pending', correlationId: cid, message: 'Result not yet available' });
    return toolOkJson({ status: 'ok', correlationId: cid, action: r.action, ok: r.ok, artifacts: r.artifacts || {} });
  }

  if (toolName === 'workbench.artifacts.read_text') {
    try {
      const p = args?.path;
      const maxBytes = args?.maxBytes;
      const tailBytes = args?.tailBytes;
      return toolOkJson(readTextArtifact({ baseDir: stateDir, p, maxBytes, tailBytes }));
    } catch (e) {
      return toolErrText(e?.message || String(e));
    }
  }

  if (toolName === 'workbench.artifacts.read_image') {
    try {
      const p = args?.path;
      const maxBytes = args?.maxBytes;
      const img = readImageArtifact({ baseDir: stateDir, p, maxBytes });
      return {
        content: [
          { type: 'image', mimeType: img.mimeType, data: img.dataBase64 },
          { type: 'json', json: { path: img.path, bytes: img.bytes, sha256: img.sha256, mimeType: img.mimeType } },
        ],
      };
    } catch (e) {
      return toolErrText(e?.message || String(e));
    }
  }

  // Executor-backed tools (enqueue work)
  const correlationId = genCorrelationId();
  const actionType = toolName.replace('workbench.', '').replace('.', '_');

  const request = {
    type: actionType === 'docker_probe' ? 'docker.probe' :
          actionType === 'docker_ps' ? 'docker.ps' :
          actionType === 'sandbox_status' ? 'sandbox.status' :
          actionType === 'sandbox_start' ? 'sandbox.start' :
          actionType === 'sandbox_exec' ? 'sandbox.exec' :
          actionType === 'sandbox_stop' ? 'sandbox.stop' :
          actionType === 'codex_swap' ? 'codex.swap' :
          actionType === 'verify' ? 'verify' :
          actionType,
    correlationId,
    args: args || {},
    requestedAt: new Date().toISOString(),
  };

  forwardToExecutor(request);

  return toolOkJson({
    status: 'accepted',
    correlationId,
    message: `Request queued for execution. Use workbench.results.get(correlationId="${correlationId}") to check status.`,
  });
}

// HTTP server for MCP
const server = createServer(async (req, res) => {
  // CORS headers for browser clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { method, params, id } = JSON.parse(body);

    // JSON-RPC style response
    const jsonRpcResponse = (result) => ({
      jsonrpc: '2.0',
      id: id || null,
      result,
    });

    const jsonRpcError = (code, message) => ({
      jsonrpc: '2.0',
      id: id || null,
      error: { code, message },
    });

    if (method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcResponse({
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'workbench-mcp',
          version: '0.1.0',
        },
      })));
      return;
    }

    if (method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcResponse({
        tools: Object.entries(TOOLS).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
      })));
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: toolArgs } = params || {};
      if (!TOOLS[name]) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(-32602, `Unknown tool: ${name}`)));
        return;
      }

      const result = handleToolCall(name, toolArgs || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcResponse(result)));
      return;
    }

    // Handle notifications (no response needed)
    if (method === 'notifications/initialized') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jsonRpcError(-32601, `Unknown method: ${method}`)));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: e.message },
    }));
  }
});

server.listen(PORT, () => {
  console.log(`Workbench MCP server listening on http://localhost:${PORT}`);
  console.log(`State directory: ${stateDir}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down Workbench MCP server...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
