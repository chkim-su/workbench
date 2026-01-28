/**
 * Workbench MCP Core - Shared logic for all transports
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readImageArtifact, readTextArtifact } from './artifacts.js';

// Tool definitions - stable namespace, vendor-neutral
export const TOOLS = {
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
    description: 'Get result of a previous action by correlation ID.',
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
    description: 'List artifacts for a completed action result.',
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
    description: 'Read a text artifact from the Workbench state directory.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to read (must be under WORKBENCH_STATE_DIR)' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read (default: 262144)' },
        tailBytes: { type: 'number', description: 'If set, read only the last N bytes' },
      },
    },
  },
  'workbench.artifacts.read_image': {
    description: 'Read an image artifact as base64.',
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

// Create handler class for managing state and tool calls
export class WorkbenchMcpHandler {
  constructor(stateDir) {
    this.stateDir = stateDir || path.join(process.cwd(), '.workbench');
  }

  ensureDir(p) {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  }

  genCorrelationId() {
    return `cid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  toolOkJson(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
  }

  toolErrText(message) {
    return { content: [{ type: 'text', text: String(message ?? 'error') }], isError: true };
  }

  readCurrentSessionId() {
    const currentPath = path.join(this.stateDir, 'state', 'current.json');
    this.ensureDir(path.dirname(currentPath));
    try {
      if (fs.existsSync(currentPath)) {
        const data = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
        if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
          return data.sessionId.trim();
        }
      }
    } catch {}

    const id = `sess_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const data = { schemaVersion: 1, sessionId: id, updatedAt: now };
    fs.writeFileSync(currentPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
    return id;
  }

  getSystemPaths() {
    const sessionId = this.readCurrentSessionId();
    const base = path.join(this.stateDir, sessionId);
    return {
      sessionId,
      base,
      requestsPath: path.join(base, 'system.requests.jsonl'),
      responsesPath: path.join(base, 'system.responses.jsonl'),
    };
  }

  forwardToExecutor(request) {
    const { requestsPath } = this.getSystemPaths();
    this.ensureDir(path.dirname(requestsPath));
    if (!fs.existsSync(requestsPath)) {
      fs.writeFileSync(requestsPath, '', 'utf8');
    }
    const payload = { version: 1, ...request };
    fs.appendFileSync(requestsPath, JSON.stringify(payload) + '\n', { encoding: 'utf8' });
    return payload;
  }

  readResponses(filterFn, limit = 50) {
    const { responsesPath } = this.getSystemPaths();
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

  getResultByCorrelationId(cid) {
    if (!cid) return null;
    const results = this.readResponses(r => r.correlationId === cid, 1);
    return results.length ? results[0] : null;
  }

  handleToolCall(toolName, args) {
    // Read-only tools
    if (toolName === 'workbench.results.get') {
      const cid = args?.correlationId;
      if (!cid) return this.toolErrText('Missing correlationId');
      const r = this.getResultByCorrelationId(cid);
      if (!r) return this.toolOkJson({ status: 'pending', correlationId: cid, message: 'Result not yet available' });
      return this.toolOkJson({
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
      const results = this.readResponses(
        actionFilter ? r => r.action?.includes(actionFilter) : null,
        limit
      );
      return this.toolOkJson({
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
      if (!cid) return this.toolErrText('Missing correlationId');
      const r = this.getResultByCorrelationId(cid);
      if (!r) return this.toolOkJson({ status: 'pending', correlationId: cid, message: 'Result not yet available' });
      return this.toolOkJson({ status: 'ok', correlationId: cid, action: r.action, ok: r.ok, artifacts: r.artifacts || {} });
    }

    if (toolName === 'workbench.artifacts.read_text') {
      try {
        const p = args?.path;
        const maxBytes = args?.maxBytes;
        const tailBytes = args?.tailBytes;
        return this.toolOkJson(readTextArtifact({ baseDir: this.stateDir, p, maxBytes, tailBytes }));
      } catch (e) {
        return this.toolErrText(e?.message || String(e));
      }
    }

    if (toolName === 'workbench.artifacts.read_image') {
      try {
        const p = args?.path;
        const maxBytes = args?.maxBytes;
        const img = readImageArtifact({ baseDir: this.stateDir, p, maxBytes });
        return {
          content: [
            { type: 'image', data: img.dataBase64, mimeType: img.mimeType },
            { type: 'text', text: JSON.stringify({ path: img.path, bytes: img.bytes, sha256: img.sha256, mimeType: img.mimeType }) },
          ],
        };
      } catch (e) {
        return this.toolErrText(e?.message || String(e));
      }
    }

    // Executor-backed tools (enqueue work)
    const correlationId = this.genCorrelationId();
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

    this.forwardToExecutor(request);

    return this.toolOkJson({
      status: 'accepted',
      correlationId,
      message: `Request queued. Use workbench.results.get(correlationId="${correlationId}") to check status.`,
    });
  }
}
