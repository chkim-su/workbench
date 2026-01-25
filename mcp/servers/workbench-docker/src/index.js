/**
 * MCP Server for Dockerized My LLM Workbench
 *
 * Controls workbench instances running in Docker containers.
 * Provides tools to:
 * - Start/stop workbench containers
 * - Send prompts to Claude Code or Codex
 * - Execute commands in the container
 * - Get workbench status and logs
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpStdioServer } from '../../../kit/src/index.js';

const server = createMcpStdioServer({ name: 'workbench.workbench_docker', version: '0.1.0' });

// Configuration
const CONFIG = {
  image: process.env.WORKBENCH_DOCKER_IMAGE || 'myworkbench:latest',
  stateDir: process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench'),
  defaultTimeout: 120_000,
};

// Track active containers
const containers = new Map();

// ─── Docker Helpers ───

async function runDocker(args, timeoutMs = 60_000) {
  const proc = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

async function dockerExec(container, command, timeoutMs = 120_000) {
  const args = ['exec', '-i', container, 'bash', '-c', command];
  return runDocker(args, timeoutMs);
}

function generateId(prefix = 'workbench') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function escapeShellArg(arg) {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ─── Tool: Start Workbench Container ───

server.tool(
  {
    name: 'workbench.workbench_docker.start',
    description: 'Start a new My LLM Workbench container for isolated LLM sessions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'Container name (auto-generated if not provided)',
        },
        projectDir: {
          type: 'string',
          description: 'Host directory to mount as /work (default: current directory)',
        },
        provider: {
          type: 'string',
          enum: ['claude-code', 'codex'],
          description: 'Default LLM provider (default: claude-code)',
        },
        anthropicApiKey: {
          type: 'string',
          description: 'Anthropic API key for Claude Code',
        },
        oauthPoolPath: {
          type: 'string',
          description: 'Path to OAuth pool JSON for Codex',
        },
        mountDocker: {
          type: 'boolean',
          description: 'Mount Docker socket for nested containers (default: false)',
        },
      },
    },
  },
  async (args) => {
    const a = args ?? {};
    const containerId = a.name || generateId();
    const containerName = `workbench-${containerId}`;
    const projectDir = a.projectDir || process.cwd();
    const provider = a.provider || 'claude-code';

    if (containers.has(containerId)) {
      return {
        content: [{ type: 'text', text: `Container '${containerId}' already exists.` }],
        isError: true,
      };
    }

    // Build docker run arguments
    const dockerArgs = [
      'run', '-d',
      '--name', containerName,
      '-v', `${projectDir}:/work`,
      '-e', `WORKBENCH_PROVIDER=${provider}`,
    ];

    // Add API keys based on provider
    if (provider === 'claude-code') {
      const apiKey = a.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        dockerArgs.push('-e', `ANTHROPIC_API_KEY=${apiKey}`);
      }
    }

    // Mount OAuth pool if provided
    if (a.oauthPoolPath && existsSync(a.oauthPoolPath)) {
      dockerArgs.push('-v', `${a.oauthPoolPath}:/home/workbench/.workbench/auth/openai_codex_oauth_pool.json:ro`);
    }

    // Mount Docker socket if requested
    if (a.mountDocker) {
      dockerArgs.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
    }

    // Add the image and keep container running
    dockerArgs.push(CONFIG.image, 'tail', '-f', '/dev/null');

    const result = await runDocker(dockerArgs, 30_000);

    if (result.exitCode !== 0) {
      return {
        content: [{ type: 'text', text: `Failed to start container:\n${result.stderr}` }],
        isError: true,
      };
    }

    const dockerContainerId = result.stdout.trim().slice(0, 12);

    // Store container info
    const containerInfo = {
      id: containerId,
      dockerId: dockerContainerId,
      name: containerName,
      projectDir,
      provider,
      createdAt: new Date().toISOString(),
    };
    containers.set(containerId, containerInfo);

    return {
      content: [{
        type: 'json',
        json: {
          containerId,
          dockerId: dockerContainerId,
          name: containerName,
          provider,
          projectDir,
          status: 'running',
        },
      }],
    };
  }
);

// ─── Tool: Chat with LLM in Container ───

server.tool(
  {
    name: 'workbench.workbench_docker.chat',
    description: 'Send a prompt to the LLM (Claude Code or Codex) running in the workbench container.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['containerId', 'prompt'],
      properties: {
        containerId: {
          type: 'string',
          description: 'Container ID from workbench.workbench_docker.start',
        },
        prompt: {
          type: 'string',
          description: 'Prompt to send to the LLM',
        },
        provider: {
          type: 'string',
          enum: ['claude-code', 'codex'],
          description: 'Override the default provider',
        },
        model: {
          type: 'string',
          description: 'Model to use (e.g., sonnet, opus, gpt-5-codex-mini)',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools to auto-approve for Claude Code',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Timeout in seconds (default: 120)',
        },
      },
    },
  },
  async (args) => {
    const a = args ?? {};
    const { containerId, prompt } = a;

    if (!containerId || !prompt) {
      return {
        content: [{ type: 'text', text: 'Missing required fields: containerId, prompt' }],
        isError: true,
      };
    }

    const container = containers.get(containerId);
    if (!container) {
      return {
        content: [{ type: 'text', text: `Container '${containerId}' not found.` }],
        isError: true,
      };
    }

    const provider = a.provider || container.provider;
    const timeoutMs = (a.timeoutSeconds || 120) * 1000;
    let command;

    if (provider === 'claude-code') {
      const model = a.model || 'sonnet';
      const allowedTools = a.allowedTools || ['Read', 'Glob', 'Grep', 'LS'];
      command = `claude -p ${escapeShellArg(prompt)} --output-format json --model ${model} --allowedTools ${allowedTools.join(',')}`;
    } else {
      // Codex via Python
      const model = a.model || 'gpt-5-codex-mini';
      command = `cd /app && python3 -c "
import sys
sys.path.insert(0, 'runner')
import json
from providers.openai_oauth_codex import OpenAICodexOAuthProvider

prompt = ${JSON.stringify(prompt)}
messages = [{'role': 'user', 'content': prompt}]

try:
    provider = OpenAICodexOAuthProvider.from_env()
    result = provider.chat(messages, timeout_s=90.0)
    text = provider.extract_text(result)
    print(json.dumps({'ok': True, 'text': text}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
"`;
    }

    const result = await dockerExec(container.name, command, timeoutMs);

    if (result.exitCode !== 0) {
      return {
        content: [{ type: 'text', text: `Error:\n${result.stderr || result.stdout}` }],
        isError: true,
      };
    }

    // Parse response
    let response;
    try {
      const parsed = JSON.parse(result.stdout);
      if (provider === 'claude-code') {
        response = parsed.result || result.stdout;
      } else {
        if (!parsed.ok) {
          return {
            content: [{ type: 'text', text: `Codex error: ${parsed.error}` }],
            isError: true,
          };
        }
        response = parsed.text;
      }
    } catch {
      response = result.stdout.trim();
    }

    return {
      content: [{
        type: 'json',
        json: {
          containerId,
          provider,
          response,
        },
      }],
    };
  }
);

// ─── Tool: Execute Command in Container ───

server.tool(
  {
    name: 'workbench.workbench_docker.exec',
    description: 'Execute a shell command in the workbench container.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['containerId', 'command'],
      properties: {
        containerId: { type: 'string' },
        command: { type: 'string' },
        workDir: { type: 'string', description: 'Working directory (default: /work)' },
        timeoutSeconds: { type: 'number' },
      },
    },
  },
  async (args) => {
    const { containerId, command, workDir, timeoutSeconds } = args ?? {};

    const container = containers.get(containerId);
    if (!container) {
      return {
        content: [{ type: 'text', text: `Container '${containerId}' not found.` }],
        isError: true,
      };
    }

    const fullCommand = workDir ? `cd ${escapeShellArg(workDir)} && ${command}` : command;
    const timeoutMs = (timeoutSeconds || 60) * 1000;

    const result = await dockerExec(container.name, fullCommand, timeoutMs);

    return {
      content: [{
        type: 'json',
        json: {
          containerId,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      }],
      isError: result.exitCode !== 0,
    };
  }
);

// ─── Tool: Stop Container ───

server.tool(
  {
    name: 'workbench.workbench_docker.stop',
    description: 'Stop and remove a workbench container.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['containerId'],
      properties: {
        containerId: { type: 'string' },
      },
    },
  },
  async (args) => {
    const { containerId } = args ?? {};

    const container = containers.get(containerId);
    if (!container) {
      return {
        content: [{ type: 'text', text: `Container '${containerId}' not found.` }],
        isError: true,
      };
    }

    await runDocker(['rm', '-f', container.name], 10_000);
    containers.delete(containerId);

    return {
      content: [{
        type: 'json',
        json: { containerId, status: 'stopped' },
      }],
    };
  }
);

// ─── Tool: List Containers ───

server.tool(
  {
    name: 'workbench.workbench_docker.list',
    description: 'List all active workbench containers.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  async () => {
    const list = [...containers.values()].map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      projectDir: c.projectDir,
      createdAt: c.createdAt,
    }));

    return {
      content: [{
        type: 'json',
        json: { count: list.length, containers: list },
      }],
    };
  }
);

// ─── Tool: Get Container Logs ───

server.tool(
  {
    name: 'workbench.workbench_docker.logs',
    description: 'Get logs from a workbench container.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['containerId'],
      properties: {
        containerId: { type: 'string' },
        tail: { type: 'number', description: 'Number of lines (default: 100)' },
      },
    },
  },
  async (args) => {
    const { containerId, tail } = args ?? {};

    const container = containers.get(containerId);
    if (!container) {
      return {
        content: [{ type: 'text', text: `Container '${containerId}' not found.` }],
        isError: true,
      };
    }

    const lines = tail || 100;
    const result = await runDocker(['logs', '--tail', String(lines), container.name], 10_000);

    return {
      content: [{
        type: 'json',
        json: {
          containerId,
          logs: result.stdout + result.stderr,
        },
      }],
    };
  }
);

server.start();
