import { useState, useEffect, memo, useRef, useMemo, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { TextInput, Spinner } from '@inkjs/ui';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { checkClaudeCode, CLAUDE_MODELS } from './claudeCodeProvider.js';
import CommandPalette from './components/CommandPalette.jsx';
import Menu from './components/Menu.jsx';
import TracesPanel from './components/TracesPanel.jsx';
import StatusPane from './StatusPane.jsx';
import { useTraceWatcher } from './hooks/useTraceWatcher.js';
import { appendSystemRequest, getClaudeConnectionMode, isSystemExecutorReady, newCorrelationId, readSystemResponses, setClaudeConnectionMode } from './system-client.js';

// ─── Constants ───

const PROVIDERS = [
  { label: 'Claude Code (local CLI)', value: 'claude-code', icon: '🤖' },
  { label: 'OpenAI Codex (OAuth)', value: 'openai-oauth', icon: '🔐' },
];

const CODEX_MODELS = [
  { label: 'gpt-5-codex-mini (fast, cost-effective)', value: 'gpt-5-codex-mini' },
  { label: 'gpt-5.2-codex (balanced)', value: 'gpt-5.2-codex' },
  { label: 'gpt-4.1 (legacy)', value: 'gpt-4.1' },
  { label: 'gpt-4.1-mini (legacy, fast)', value: 'gpt-4.1-mini' },
  { label: 'o3-mini (reasoning)', value: 'o3-mini' },
  { label: 'o4-mini (reasoning)', value: 'o4-mini' },
];

const SESSION_COMMANDS = {
  '/new': 'Start new session',
  '/clear': 'Clear chat history',
};

const SYSTEM_COMMANDS = {
  '//help': 'Show available commands',
  '//provider': 'Switch provider (OpenAI Codex, Claude Code)',
  '//runtime': 'Select runtime mode (Codex Chat, Codex CLI, OpenCode, Claude Code)',
  '//model': 'Change the model',
  '//models': 'List available models',
  '//profile': 'Switch OAuth profile (Codex only)',
  '//pwd': 'Show current workspace directory',
  '//cwd': 'Set workspace directory (advanced)',
  '//status': 'Show session status',
  '//sidebar': 'Toggle status sidebar',
  '//mode': 'Switch session mode',
  '//focus': 'Focus tmux window (control/ui)',
  '//exit': 'Exit chat',
  '//quit': 'Exit chat',
  '//back': 'Return to menu',
  '//docker': 'Run Docker harness (gate 4)',
  '//verify': 'Run general verification (fast gate)',
  '//claude': 'Switch to Claude Code runtime',
};

// ─── Helpers ───

/** Generate unique message ID for stable React keys (prevents flicker) */
let msgIdCounter = 0;
function nextMsgId() {
  return `msg-${Date.now()}-${++msgIdCounter}`;
}

/**
 * Launch Claude Code in the Workbench tmux "ui" window (pane 0).
 * Claude Code is a native TTY surface; Workbench should not mirror it.
 */
function diagnoseTmuxSession(session) {
  try {
    execSync('command -v tmux >/dev/null 2>&1');
  } catch {
    return { installed: false, sessionExists: false };
  }

  try {
    const server = process.env.WORKBENCH_TMUX_SERVER || '';
    const tmuxBin = server ? `tmux -L "${server}"` : 'tmux';
    execSync(`${tmuxBin} has-session -t "${session}" >/dev/null 2>&1`);
    return { installed: true, sessionExists: true };
  } catch {
    return { installed: true, sessionExists: false };
  }
}

function hasWindow(session, windowName) {
  try {
    const server = process.env.WORKBENCH_TMUX_SERVER || '';
    const tmuxBin = server ? `tmux -L "${server}"` : 'tmux';
    const raw = execSync(`${tmuxBin} list-windows -t "${session}" -F '#{window_name}'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).includes(windowName);
  } catch {
    return false;
  }
}

function ensureUiWindow(session, cwd) {
  if (hasWindow(session, 'ui')) return true;
  try {
    const server = process.env.WORKBENCH_TMUX_SERVER || '';
    const tmuxBin = server ? `tmux -L "${server}"` : 'tmux';
    const workdir = cwd ? `-c "${cwd}"` : '';
    execSync(`${tmuxBin} new-window -d -t "${session}" -n "ui" ${workdir} "bash"`);
    return true;
  } catch {
    return false;
  }
}

function launchClaudeCodeInPane() {
  const session = process.env.WORKBENCH_TMUX_SESSION || 'workbench';
  const diag = diagnoseTmuxSession(session);

  if (!diag.installed) {
    return {
      success: false,
      message: 'tmux CLI not found. Install tmux to host Claude Code (see INSTALL.md).',
    };
  }

  if (!diag.sessionExists) {
    return {
      success: false,
      message: `tmux session "${session}" not running. Start Workbench from a terminal or run scripts/workbench.sh to create it.`,
    };
  }

  const cwd = process.env.WORKBENCH_WORKSPACE_DIR || process.env.WORKBENCH_REPO_ROOT || process.cwd();
  if (!ensureUiWindow(session, cwd)) {
    return {
      success: false,
      message: `Unable to locate/create tmux window "ui" in session "${session}".`,
    };
  }

  try {
    const server = process.env.WORKBENCH_TMUX_SERVER || '';
    const tmuxBin = server ? `tmux -L "${server}"` : 'tmux';
    const target = `${session}:ui.0`;
    execSync(`${tmuxBin} send-keys -t "${target}" C-c`);
    execSync(`${tmuxBin} send-keys -t "${target}" "clear && claude" Enter`);
    // Do not auto-focus the Claude window by default; keep Workbench controls available.
    // Users can switch via tmux or `//focus ui`.
    if (process.env.WORKBENCH_CLAUDE_AUTOFOCUS === '1') {
      execSync(`${tmuxBin} select-window -t "${session}:ui"`);
      execSync(`${tmuxBin} select-pane -t "${target}"`);
    }
    return { success: true };
  } catch (e) {
    return {
      success: false,
      message: `Failed to focus tmux UI pane for Claude Code: ${e.message}`,
    };
  }
}

function getProfileStatus(profile) {
  const now = Date.now();
  if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > now) {
    const remaining = Math.ceil((profile.rateLimitedUntilMs - now) / 1000 / 60);
    return { status: 'limited', color: 'yellow', text: `Rate limited (${remaining}m)` };
  }
  if (profile.disabled || profile.enabled === false) {
    return { status: 'disabled', color: 'gray', text: 'Disabled' };
  }
  if (profile.expiresAtMs && profile.expiresAtMs < now) {
    return { status: 'expired', color: 'red', text: 'Expired' };
  }
  return { status: 'ready', color: 'green', text: 'Ready' };
}

function loadOAuthPool(stateDirOverride) {
  const stateDir = stateDirOverride || process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench');
  const poolPath = join(stateDir, 'auth', 'openai_codex_oauth_pool.json');
  try {
    if (existsSync(poolPath)) {
      return JSON.parse(readFileSync(poolPath, 'utf8'));
    }
  } catch {}
  return null;
}

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch {}
}

function normalizeCwd(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  const marker = '\\\\wsl.localhost\\\\ubuntu\\\\';
  const idx = lower.indexOf(marker);
  if (idx >= 0) {
    let rest = s.slice(idx + marker.length);
    rest = rest.replaceAll('\\\\', '/').replaceAll('\\', '/').trim();
    if (rest && !rest.startsWith('/')) rest = `/${rest}`;
    return rest;
  }
  return s;
}

function checkCodexCLI() {
  try {
    const out = execSync('codex --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return { available: true, version: out || null };
  } catch {
    return { available: false, version: null };
  }
}

function checkOpenCodeCLI() {
  try {
    execSync('command -v opencode >/dev/null 2>&1', { stdio: ['ignore', 'ignore', 'ignore'] });
    return { available: true };
  } catch {
    return { available: false };
  }
}

function ensureOpencodeConfig(stateDir) {
  const base = join(stateDir, 'opencode');
  const xdg = {
    XDG_CONFIG_HOME: join(base, 'xdg', 'config'),
    XDG_DATA_HOME: join(base, 'xdg', 'data'),
    XDG_STATE_HOME: join(base, 'xdg', 'state'),
    XDG_CACHE_HOME: join(base, 'xdg', 'cache'),
    OPENCODE_TEST_HOME: base,
  };
  for (const p of Object.values(xdg)) ensureDir(p);

  const cfgDir = join(xdg.XDG_CONFIG_HOME, 'opencode');
  ensureDir(cfgDir);
  const cfgPath = join(cfgDir, 'config.json');
  if (!existsSync(cfgPath)) {
    const cfg = {
      $schema: 'https://opencode.ai/config.json',
      permission: {
        read: 'allow',
        edit: 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        bash: 'deny',
        external_directory: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        codesearch: 'deny',
        doom_loop: 'deny',
      },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  }

  return xdg;
}

function opencodeBinary() {
  return (process.env.WORKBENCH_OPENCODE_BIN || '').trim() || 'opencode';
}

function opencodeModelForRuntime(currentModel) {
  const override = (process.env.WORKBENCH_OPENCODE_MODEL || '').trim();
  if (override) return override;
  const m = String(currentModel || '').trim();
  if (m) return `openai/${m}`;
  return 'openai/gpt-5.2-codex';
}

function opencodeAgentForRuntime() {
  return (process.env.WORKBENCH_OPENCODE_AGENT || '').trim() || 'build';
}

function writeCodexAuthFromPool({ stateDir, profileName }) {
  const pool = loadOAuthPool(stateDir);
  const profiles = pool?.profiles || {};
  let chosen = null;
  if (profileName && profiles[profileName]) chosen = profiles[profileName];
  const lastUsed = pool?.selection?.lastUsedProfile;
  if (!chosen && lastUsed && profiles[lastUsed]) chosen = profiles[lastUsed];
  if (!chosen) {
    const keys = Object.keys(profiles);
    if (keys.length) chosen = profiles[keys[0]];
  }
  if (!chosen) throw new Error('OAuth pool missing/empty');
  if (!chosen.accessToken || !chosen.refreshToken || !chosen.accountId) throw new Error('OAuth profile missing token fields');

  const codexHomeDir = join(stateDir, 'codex_home');
  ensureDir(join(codexHomeDir, '.codex'));
  const authPath = join(codexHomeDir, '.codex', 'auth.json');
  const auth = {
    tokens: {
      id_token: chosen.accessToken,
      access_token: chosen.accessToken,
      refresh_token: chosen.refreshToken,
      account_id: chosen.accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  return { codexHomeDir, authPath };
}

/**
 * Emit a trace event to the JSONL events file for live reasoning display.
 * @param {string} eventsPath - Path to the events JSONL file
 * @param {string} correlationId - Correlation ID for this turn
 * @param {object} opts - Event options: kind, message, tool (optional)
 */
function emitTraceEvent(eventsPath, correlationId, { kind, message, tool }) {
  if (!eventsPath) return;
  try {
    // Ensure directory exists
    const dir = eventsPath.substring(0, eventsPath.lastIndexOf('/'));
    if (dir) ensureDir(dir);

    const event = {
      version: 1,
      type: 'turn.event',
      correlationId,
      at: new Date().toISOString(),
      kind,
      message,
      ...(tool ? { tool } : {}),
    };
    appendFileSync(eventsPath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  } catch {
    // Silently ignore write errors to not disrupt the main flow
  }
}

async function runCodexRuntimeTurn({ stateDir, model, profileName, prompt, cwd, eventsPath, correlationId }) {
  const { codexHomeDir } = writeCodexAuthFromPool({ stateDir, profileName });
  const args = ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', cwd];
  if (model) args.push('--model', model);

  const preludeLines = [
    'You are running inside the local Codex CLI runtime.',
    'You can create/edit files in the working directory.',
    'Prefer apply_patch-style edits when modifying files.',
    'Do not claim you cannot create files.',
  ];
  const fullPrompt = `${preludeLines.join('\n')}\n\nUSER:\n${prompt}`;
  args.push(fullPrompt);

  return await new Promise((resolve, reject) => {
    const proc = spawn('codex', args, { cwd, env: { ...process.env, HOME: codexHomeDir }, stdio: ['ignore', 'pipe', 'pipe'] });

    // Emit start event
    emitTraceEvent(eventsPath, correlationId, { kind: 'info', message: 'codex exec started' });

    let stdoutBuf = '';
    let stderr = '';
    let agentMessage = '';
    const fileChanges = new Set();

    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      // Process complete lines for streaming events
      for (;;) {
        const idx = stdoutBuf.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;

        try {
          const ev = JSON.parse(line);

          // Track agent messages
          if (ev?.type === 'item.completed' && ev?.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
            agentMessage = ev.item.text;
            emitTraceEvent(eventsPath, correlationId, { kind: 'think', message: 'Processing response...' });
          }

          // Track file changes
          if (ev?.type === 'item.completed' && ev?.item?.type === 'file_change' && Array.isArray(ev?.item?.changes)) {
            for (const c of ev.item.changes) {
              if (typeof c?.path === 'string') {
                fileChanges.add(c.path);
                emitTraceEvent(eventsPath, correlationId, { kind: 'tool_use', tool: 'edit', message: c.path });
              }
            }
          }

          // Track tool calls/use
          if (ev?.type === 'tool_call' || ev?.type === 'tool_use') {
            const toolName = String(ev?.tool || ev?.name || 'tool').trim();
            const summary = String(ev?.summary || ev?.description || '').trim() || `Using ${toolName}`;
            emitTraceEvent(eventsPath, correlationId, { kind: 'tool_use', tool: toolName, message: summary });
          }

          // Track item started events
          if (ev?.type === 'item.started' && ev?.item?.type) {
            const itemType = String(ev.item.type).trim();
            emitTraceEvent(eventsPath, correlationId, { kind: 'info', message: `Started: ${itemType}` });
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    });

    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => {
      emitTraceEvent(eventsPath, correlationId, { kind: 'error', message: err.message });
      reject(err);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        emitTraceEvent(eventsPath, correlationId, { kind: 'error', message: `codex exitCode=${code}` });
        reject(new Error(stderr || `codex exitCode=${code}`));
        return;
      }
      emitTraceEvent(eventsPath, correlationId, { kind: 'info', message: 'codex exec completed' });
      resolve({ text: agentMessage || '(no content)', fileChanges: Array.from(fileChanges) });
    });
  });
}

async function runOpenCodeRuntimeTurn({ stateDir, model, agent, prompt, cwd, onEvent, eventsPath, correlationId }) {
  const bin = opencodeBinary();
  const args = ['run', '--format', 'json'];
  if (agent) args.push('--agent', agent);
  if (model) args.push('--model', model);
  args.push(prompt);

  const fileChanges = new Set();
  let lastText = '';
  let stderr = '';

  const resolvedCwd = normalizeCwd(cwd) || process.cwd();
  const env = { ...process.env, ...ensureOpencodeConfig(stateDir), OPENCODE: '1' };

  return await new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd: resolvedCwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';

    // Emit start event
    emitTraceEvent(eventsPath, correlationId, { kind: 'info', message: 'opencode exec started' });

    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
      for (;;) {
        const idx = stdoutBuf.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;

        let ev = null;
        try { ev = JSON.parse(line); } catch { ev = null; }
        if (!ev || typeof ev !== 'object') continue;

        if (ev.type === 'tool_use') {
          const tool = String(ev?.part?.tool || '').trim() || 'tool';
          const title = String(ev?.part?.state?.title || '').trim();

          if (typeof ev?.part?.state?.input === 'object' && ev.part.state.input) {
            const input = ev.part.state.input;
            for (const k of ['path', 'file', 'filepath', 'filename', 'target', 'pattern']) {
              const v = input?.[k];
              if (typeof v === 'string' && v.trim()) fileChanges.add(v.trim());
            }
          }

          onEvent?.({ kind: 'tool_use', tool, message: title || '(tool)' });
          // Also emit to trace file
          emitTraceEvent(eventsPath, correlationId, { kind: 'tool_use', tool, message: title || '(tool)' });
          continue;
        }

        if (ev.type === 'step_start' || ev.type === 'step_finish') {
          const title = String(ev?.part?.state?.title || ev?.part?.title || '').trim();
          onEvent?.({ kind: ev.type, message: title || ev.type });
          // Also emit to trace file
          emitTraceEvent(eventsPath, correlationId, { kind: 'info', message: `${ev.type}: ${title || 'step'}` });
          continue;
        }

        if (ev.type === 'text') {
          const text = String(ev?.part?.text || '').trim();
          if (text) lastText = text;
          continue;
        }

        if (ev.type === 'error') {
          const msg = String(ev?.error?.message || ev?.error?.name || 'error').trim();
          onEvent?.({ kind: 'error', message: msg });
          // Also emit to trace file
          emitTraceEvent(eventsPath, correlationId, { kind: 'error', message: msg });
          stderr = stderr ? `${stderr}\n${msg}` : msg;
          continue;
        }
      }
    });

    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => {
      emitTraceEvent(eventsPath, correlationId, { kind: 'error', message: err.message });
      reject(err);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        emitTraceEvent(eventsPath, correlationId, { kind: 'error', message: `opencode exitCode=${code}` });
        reject(new Error((stderr || '').trim() || `opencode exitCode=${code}`));
        return;
      }
      emitTraceEvent(eventsPath, correlationId, { kind: 'info', message: 'opencode exec completed' });
      resolve({ text: lastText || '(no content)', fileChanges: Array.from(fileChanges) });
    });
  });
}

// ─── Components ───

const MESSAGE_STYLES = {
  user: { headerColor: 'cyan', label: 'You', textColor: undefined },
  system: { headerColor: 'yellow', label: 'System', textColor: undefined },
  error: { headerColor: 'red', label: 'Error', textColor: 'red' },
  command: { headerColor: 'magenta', label: 'Command', textColor: 'magenta' },
  assistant: { headerColor: 'green', label: 'Assistant', textColor: undefined },
};

function looksLikeFileOpRequest(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (/(^|\s)(cat|read|open|show)\s+.+/.test(t)) return true;
  if (/(^|\s)(create|make|write|edit|update|modify|delete)\s+.+/.test(t)) return true;
  if (/\b(readme|makefile)\b/.test(t)) return true;
  if (/\.[a-z0-9]{1,8}\b/.test(t)) return true;
  if (t.includes('\\\\wsl.localhost\\') || t.includes('/home/') || t.includes('c:\\') || t.includes('\\\\')) return true;
  return false;
}

// Memoized to prevent re-renders when parent state changes (reduces flicker)
const Message = memo(function Message({ role, content }) {
  const style = MESSAGE_STYLES[role] || MESSAGE_STYLES.assistant;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={style.headerColor}>{style.label}:</Text>
      <Box paddingLeft={2}>
        <Text wrap="wrap" color={style.textColor}>{content}</Text>
      </Box>
    </Box>
  );
});

function HelpView({ onClose }) {
  useInput((input, key) => {
    if (key.return || key.escape) {
      onClose();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan">Available Commands</Text>
      </Box>
      <Box flexDirection="column" paddingX={2}>
        <Box marginBottom={1}>
          <Text bold color="cyan">System (//)</Text>
        </Box>
        {Object.entries(SYSTEM_COMMANDS).map(([cmd, desc]) => (
          <Box key={cmd}>
            <Text color="cyan" bold>{cmd.padEnd(12)}</Text>
            <Text dimColor>{desc}</Text>
          </Box>
        ))}
        <Box marginTop={1} marginBottom={1}>
          <Text bold color="cyan">Session (/)</Text>
        </Box>
        {Object.entries(SESSION_COMMANDS).map(([cmd, desc]) => (
          <Box key={cmd}>
            <Text color="cyan" bold>{cmd.padEnd(12)}</Text>
            <Text dimColor>{desc}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} paddingX={2}>
        <Text dimColor>Press Enter or Esc to continue</Text>
      </Box>
    </Box>
  );
}

function ModelSelector({ currentModel, currentProvider, onSelect, onCancel }) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  // Select models based on provider (only Claude Code and OpenAI Codex)
  const models = currentProvider === 'claude-code' ? CLAUDE_MODELS : CODEX_MODELS;
  const providerLabel = currentProvider === 'claude-code' ? 'Claude' : 'OpenAI';

  const options = models.map((m) => ({
    label: m.value === currentModel ? `${m.label} ✓` : m.label,
    value: m.value,
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan">Select Model ({providerLabel})</Text>
      </Box>
      <Box paddingX={2}>
        <Menu options={options} onSelect={onSelect} showHint={false} />
      </Box>
      <Box marginTop={1} paddingX={2}>
        <Text dimColor>Current: {currentModel} | Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function ProviderSelector({ currentProvider, claudeAvailable, onSelect, onCancel }) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const options = PROVIDERS.map((p) => {
    const isCurrent = p.value === currentProvider;
    const isDisabled = p.value === 'claude-code' && !claudeAvailable;
    let label = `${p.icon} ${p.label}`;

    if (isDisabled) label += ' (not installed)';
    if (isCurrent) label += ' ✓';
    if (p.value === 'claude-code' && claudeAvailable) label += ' → tmux window';

    return { label, value: p.value, isDisabled };
  }).filter((p) => !p.isDisabled);

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan">Select Provider</Text>
      </Box>
      <Box paddingX={2}>
        <Menu options={options} onSelect={onSelect} showHint={false} />
      </Box>
      <Box marginTop={1} paddingX={2}>
        <Text dimColor>Current: {currentProvider} | Esc to cancel</Text>
      </Box>
      <Box marginTop={1} paddingX={2} flexDirection="column">
        <Text dimColor>• Claude Code: Opens native TUI in a tmux window</Text>
        <Text dimColor>• Codex: Chat within this TUI using OAuth</Text>
      </Box>
      {!claudeAvailable && (
        <Box marginTop={1} paddingX={2}>
          <Text color="yellow">Install Claude Code: npm i -g @anthropic-ai/claude-code</Text>
        </Box>
      )}
    </Box>
  );
}

function ProfileSelector({ oauthPool, currentProfile, onSelect, onCancel }) {
  if (!oauthPool || !oauthPool.profiles) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">No OAuth profiles configured</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  const options = Object.entries(oauthPool.profiles).map(([name, profile]) => {
    const status = getProfileStatus(profile);
    return {
      label: `${name} (${status.text})${name === currentProfile ? ' ✓' : ''}`,
      value: name,
    };
  });

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan">Select OAuth Profile</Text>
      </Box>
      <Box paddingX={2}>
        <Menu options={options} onSelect={onSelect} showHint={false} />
      </Box>
      <Box marginTop={1} paddingX={2}>
        <Text dimColor>Current: {currentProfile || 'auto'} | Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function StatusView({ oauthPool, currentProfile, currentModel, onClose }) {
  useInput((input, key) => {
    if (key.return || key.escape) {
      onClose();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan">Session Status</Text>
      </Box>

      <Box flexDirection="column" paddingX={2} marginBottom={1}>
        <Text bold>Current Settings:</Text>
        <Text>  Model: <Text color="green">{currentModel}</Text></Text>
        <Text>  Profile: <Text color="green">{currentProfile || 'auto'}</Text></Text>
      </Box>

      <Box flexDirection="column" paddingX={2}>
        <Text bold>OAuth Profiles:</Text>
        {oauthPool && oauthPool.profiles ? (
          Object.entries(oauthPool.profiles).map(([name, profile]) => {
            const status = getProfileStatus(profile);
            return (
              <Box key={name}>
                <Text color={status.color}>  {name === currentProfile ? '● ' : '  '}{name}: {status.text}</Text>
              </Box>
            );
          })
        ) : (
          <Text dimColor>  No profiles configured</Text>
        )}
      </Box>

      <Box marginTop={1} paddingX={2}>
        <Text dimColor>Press Enter or Esc to continue</Text>
      </Box>
    </Box>
  );
}

// Main Chat component
export default function Chat({
  provider = 'openai-oauth',
  sessionMode,
  sessionManager,
  onClose,
  onModeChange,
}) {
  const { stdout } = useStdout();
  // Resize events are already debounced at entry point level (100ms)
  // No need for component-level debounce - use raw columns directly
  const cols = stdout?.columns || 80;
  const rows = stdout?.rows || 24;

  // Minimum size thresholds to prevent layout instability (flicker)
  const MIN_COLS = 60;
  const MIN_ROWS = 15;
  const isTooSmall = cols < MIN_COLS || rows < MIN_ROWS;

  const [sidebarEligible, setSidebarEligible] = useState(cols >= 110);
  const repoRoot = process.env.WORKBENCH_REPO_ROOT || process.cwd();
  const defaultWorkspaceDir = process.env.WORKBENCH_WORKSPACE_DIR || repoRoot;
  const stateDir = process.env.WORKBENCH_STATE_DIR || join(repoRoot, '.workbench');

  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState('chat'); // chat | help | model | profile | status | provider | runtime
  const [currentModel, setCurrentModel] = useState('gpt-5-codex-mini');
  const [currentProfile, setCurrentProfile] = useState(null);
  const [currentProvider, setCurrentProvider] = useState(provider);
  const [currentRuntime, setCurrentRuntime] = useState(provider === 'claude-code' ? 'claude-native' : 'codex-api');
  const [workspaceDir, setWorkspaceDir] = useState(defaultWorkspaceDir);
  const [claudeAvailable, setClaudeAvailable] = useState(false);
  const [codexAvailable, setCodexAvailable] = useState(false);
  const [opencodeAvailable, setOpencodeAvailable] = useState(false);
  const [oauthPool, setOauthPool] = useState(null);
  // Prefer a tmux-hosted status pane. Allow forcing embedded status for non-tmux use.
  const [showSidebar, setShowSidebar] = useState(() => {
    if (process.env.WORKBENCH_EMBED_STATUS === '1') return true;
    if (process.env.WORKBENCH_EMBED_STATUS === '0') return false;
    return !process.env.TMUX;
  });

  // Compose/input state (kept together to avoid multi-render flicker on each keystroke)
  const [composer, setComposer] = useState({
    inputKey: 0,
    inputDefaultValue: '',
    input: '',
    showPalette: false,
    paletteFilter: '',
    paletteIndex: 0,
  });
  const [pendingSystemAction, setPendingSystemAction] = useState(null);
  const systemOffsetRef = useRef(0);
  const systemPollRef = useRef(null);
  const [claudeConnectionMode, setClaudeConnectionModeState] = useState(() => getClaudeConnectionMode(stateDir));

  // Trace display state for reasoning traces
  const [turnCorrelationId, setTurnCorrelationId] = useState(null);
  const [tracesCollapsed, setTracesCollapsed] = useState(false);

  // Compute session ID for trace file path (mirrors system-client.js ensureSessionId)
  const sessionId = useMemo(() => {
    const currentPath = join(stateDir, 'state', 'current.json');
    try {
      if (existsSync(currentPath)) {
        const data = JSON.parse(readFileSync(currentPath, 'utf8'));
        if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
          return data.sessionId.trim();
        }
      }
    } catch {}
    return null;
  }, [stateDir]);

  // Compute events file path based on runtime
  const eventsFilePath = useMemo(() => {
    if (!sessionId || !stateDir) return null;
    if (currentRuntime === 'codex-runtime') {
      return join(stateDir, sessionId, 'codex.events.jsonl');
    }
    if (currentRuntime === 'opencode-runtime') {
      return join(stateDir, sessionId, 'opencode.events.jsonl');
    }
    return null;
  }, [stateDir, sessionId, currentRuntime]);

  // Hook for watching trace events
  const { traces, clearTraces } = useTraceWatcher({
    eventsFilePath,
    correlationId: turnCorrelationId,
    isActive: isLoading,
    pollIntervalMs: 250,
  });

  useEffect(() => {
    const { offset } = readSystemResponses(stateDir, 0);
    systemOffsetRef.current = offset;
  }, [stateDir]);

  const paletteFilterLower = composer.paletteFilter.toLowerCase();
  const activePaletteCommands = useMemo(
    () => (composer.input.startsWith('//') ? SYSTEM_COMMANDS : SESSION_COMMANDS),
    [composer.input],
  );
  const filteredPaletteCommandKeys = useMemo(() => {
    const commands = Object.keys(activePaletteCommands);
    if (!paletteFilterLower) return commands;
    return commands.filter((c) => c.toLowerCase().includes(paletteFilterLower));
  }, [activePaletteCommands, paletteFilterLower]);

  useEffect(() => {
    setComposer((prev) => {
      const maxIndex = Math.max(0, filteredPaletteCommandKeys.length - 1);
      if (prev.paletteIndex > maxIndex) {
        return { ...prev, paletteIndex: maxIndex };
      }
      return prev;
    });
  }, [filteredPaletteCommandKeys.length]);

  // Initialize provider and load OAuth pool
  useEffect(() => {
    const defaultModel = 'gpt-5-codex-mini';

    async function init() {
      const claudeCheck = await checkClaudeCode();
      setClaudeAvailable(claudeCheck.available);

      const codexCheck = checkCodexCLI();
      setCodexAvailable(codexCheck.available);

      const opencodeCheck = checkOpenCodeCLI();
      setOpencodeAvailable(opencodeCheck.available);

      const pool = loadOAuthPool(stateDir);
      setOauthPool(pool);

      if (pool?.profiles) {
        const readyProfiles = Object.entries(pool.profiles)
          .filter(([, p]) => getProfileStatus(p).status === 'ready');
        if (readyProfiles.length > 0) {
          setCurrentProfile(readyProfiles[0][0]);
        }
      }

      const initialClaudeMode = getClaudeConnectionMode(stateDir);
      const claudeRuntime = initialClaudeMode === 'managed' ? 'claude-managed' : 'claude-native';
      const runtime = provider === 'claude-code'
        ? claudeRuntime
        : (codexCheck.available ? 'codex-runtime' : 'codex-api');
      setCurrentRuntime(runtime);
      setMessages([{
        id: nextMsgId(),
        role: 'system',
        content: `Chat started | Provider: Codex | Runtime: ${runtime} | Model: ${defaultModel} | Type //help for commands`,
      }]);
    }

    init();
  }, []);

  // Sidebar hysteresis to avoid flicker around resize boundaries.
  useEffect(() => {
    const showAtOrAbove = 112;
    const hideAtOrBelow = 106;
    setSidebarEligible((prev) => {
      if (prev) return cols <= hideAtOrBelow ? false : true;
      return cols >= showAtOrAbove ? true : false;
    });
  }, [cols]);

  // Reload OAuth pool periodically (with change detection to prevent flicker)
  useEffect(() => {
    let lastPoolJson = JSON.stringify(oauthPool);
    const interval = setInterval(() => {
      const newPool = loadOAuthPool(stateDir);
      const newPoolJson = JSON.stringify(newPool);
      // Only update state if pool actually changed (prevents unnecessary re-renders)
      if (newPoolJson !== lastPoolJson) {
        lastPoolJson = newPoolJson;
        setOauthPool(newPool);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [stateDir]);

  // Handle input change for command palette
  const handleInputChange = (value) => {
    setComposer((prev) => {
      if (prev.input === value) return prev;
      const showPalette = value.startsWith('/');
      const paletteFilter = showPalette ? (value.startsWith('//') ? value.slice(2) : value.slice(1)) : '';
      return { ...prev, input: value, showPalette, paletteFilter, paletteIndex: 0 };
    });
  };

  // Handle input (only active in chat mode)
  useInput((inputChar, key) => {
    if (viewMode !== 'chat') return;

    // Handle palette navigation when visible
    if (composer.showPalette) {
      if (key.upArrow) {
        setComposer((prev) => ({ ...prev, paletteIndex: Math.max(0, prev.paletteIndex - 1) }));
        return;
      }
      if (key.downArrow) {
        const maxIndex = Math.max(0, filteredPaletteCommandKeys.length - 1);
        setComposer((prev) => ({ ...prev, paletteIndex: Math.min(maxIndex, prev.paletteIndex + 1) }));
        return;
      }
      if (key.escape) {
        setComposer((prev) => ({
          ...prev,
          inputKey: prev.inputKey + 1,
          inputDefaultValue: '',
          input: '',
          showPalette: false,
          paletteFilter: '',
          paletteIndex: 0,
        }));
        return;
      }
      if (key.tab) {
        // Tab-complete the selected command
        const filtered = filteredPaletteCommandKeys;
        setComposer((prev) => {
          const cmd = filtered[prev.paletteIndex];
          if (!cmd) return prev;
          const paletteFilter = cmd.startsWith('//') ? cmd.slice(2) : cmd.slice(1);
          return {
            ...prev,
            inputKey: prev.inputKey + 1,
            inputDefaultValue: cmd,
            input: cmd,
            showPalette: true,
            paletteFilter,
          };
        });
        return;
      }
    }

    if (key.escape) {
      if (composer.showPalette) {
        setComposer((prev) => ({
          ...prev,
          inputKey: prev.inputKey + 1,
          inputDefaultValue: '',
          input: '',
          showPalette: false,
          paletteFilter: '',
          paletteIndex: 0,
        }));
      } else {
        onClose?.();
      }
      return;
    }

    if (key.ctrl && inputChar === 'c') {
      onClose?.();
      return;
    }

    // Toggle traces panel with 't' key (only when not typing in input)
    if (inputChar === 't' && !composer.input && traces.length > 0 && !isLoading) {
      setTracesCollapsed((prev) => !prev);
      return;
    }
  }, { isActive: !isLoading && viewMode === 'chat' });

  // Handle slash commands
  const pushSystemMessage = (content) => {
    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'system', content }]);
  };

  const requestSystemAction = ({ type, description, logMessage, full = false }) => {
    if (!isSystemExecutorReady(stateDir)) {
      pushSystemMessage('System executor offline. Start Workbench from a terminal so it can run Docker/verify for you.');
      return false;
    }
    if (pendingSystemAction) {
      pushSystemMessage('A system action is already in flight. Wait a moment before starting another.');
      return false;
    }
    const correlationId = newCorrelationId();
    appendSystemRequest(stateDir, { type, correlationId, full });
    pushSystemMessage(logMessage || `Queued ${description}...`);
    setPendingSystemAction({ correlationId, type, description });
    return true;
  };

  useEffect(() => {
    if (!pendingSystemAction) {
      if (systemPollRef.current) {
        clearInterval(systemPollRef.current);
        systemPollRef.current = null;
      }
      return;
    }

    const poll = () => {
      try {
        const { responses, offset } = readSystemResponses(stateDir, systemOffsetRef.current);
        if (offset !== systemOffsetRef.current) {
          systemOffsetRef.current = offset;
        }
        for (const response of responses) {
          if (response.correlationId === pendingSystemAction.correlationId) {
            const summary = response.summary || 'completed';
            const artifactPath = response.artifacts?.summary ? ` summary:${response.artifacts.summary}` : '';
            const detail = response.detail ? ` detail:${response.detail}` : '';
            pushSystemMessage(`${pendingSystemAction.description} ${response.ok ? 'completed' : 'failed'} (${summary}${artifactPath}${detail})`);
            setPendingSystemAction(null);
            if (systemPollRef.current) {
              clearInterval(systemPollRef.current);
              systemPollRef.current = null;
            }
            return;
          }
        }
      } catch {
        // ignore read errors
      }
    };

    poll();
    systemPollRef.current = setInterval(poll, 1500);
    return () => {
      if (systemPollRef.current) {
        clearInterval(systemPollRef.current);
        systemPollRef.current = null;
      }
    };
  }, [pendingSystemAction, stateDir]);

  const handleSlashCommand = (cmd) => {
    const trimmed = cmd.trim();
    const command = trimmed.toLowerCase();
    const isSystem = command.startsWith('//');

    switch (command) {

      case '//docker':
        requestSystemAction({
          type: 'docker.probe',
          description: 'Docker probe (gate 4)',
          logMessage: 'Requesting Docker probe via //docker...',
        });
        return true;

      case '//verify':
        {
          const words = trimmed.split(/\s+/).slice(1);
          const full = words.includes('full');
          requestSystemAction({
            type: 'verify',
            description: full ? 'Full verification (gate 5/6)' : 'Fast verification',
            logMessage: full ? 'Requesting full verification via //verify full...' : 'Requesting verification via //verify...',
            full,
          });
        }
        return true;

      case '//claude':
        handleProviderSelect('claude-code');
        return true;

      case '//help':
        setViewMode('help');
        return true;

      case '//model':
      case '//models':
        setViewMode('model');
        return true;

      case '//status':
        setViewMode('status');
        return true;

      case '//sidebar':
        {
          const next = !showSidebar;
          setShowSidebar(next);
          setMessages((prev) => [...prev, { id: nextMsgId(), role: 'command', content: `Status sidebar: ${next ? 'on' : 'off'}` }]);
        }
        return true;

      case '//profile':
        if (currentProvider === 'claude-code') {
          setMessages((prev) => [...prev, {
            id: nextMsgId(),
            role: 'command',
            content: 'Profile switching is only available for Codex provider. Use /provider to switch.',
          }]);
          return true;
        }
        setViewMode('profile');
        return true;

      case '//provider':
        setViewMode('provider');
        return true;

      case '//runtime':
        setViewMode('runtime');
        return true;

      case '//pwd':
        setMessages((prev) => [...prev, { id: nextMsgId(), role: 'command', content: `Workspace: ${workspaceDir}` }]);
        return true;

      case '/clear':
        setMessages([{
          id: nextMsgId(),
          role: 'system',
          content: `Chat cleared | Model: ${currentModel} | Type //help for commands`,
        }]);
        return true;

      case '/new':
        if (sessionManager) {
          sessionManager.newSession(sessionMode);
        }
        setMessages([{
          id: nextMsgId(),
          role: 'system',
          content: `New session started | Mode: ${sessionMode === 'A' ? 'Controlled' : 'Compatibility'} | Type //help for commands`,
        }]);
        return true;

      case '//mode':
        onModeChange?.(null);
        return true;

      case '//exit':
      case '//quit':
      case '//back':
        onClose?.();
        return true;

      default:
        if (command.startsWith('//focus')) {
          const arg = trimmed.split(/\s+/).slice(1).join(' ').trim();
          const session = process.env.WORKBENCH_TMUX_SESSION || 'workbench';
          if (!arg) {
            setMessages((prev) => [...prev, {
              id: nextMsgId(),
              role: 'command',
              content: 'Usage: //focus <control|ui>',
            }]);
            return true;
          }
          try {
            const server = process.env.WORKBENCH_TMUX_SERVER || '';
            const tmuxBin = server ? `tmux -L "${server}"` : 'tmux';
            execSync(`${tmuxBin} select-window -t "${session}:${arg}"`);
            setMessages((prev) => [...prev, {
              id: nextMsgId(),
              role: 'command',
              content: `Focused tmux window: ${arg}`,
            }]);
          } catch {
            setMessages((prev) => [...prev, {
              id: nextMsgId(),
              role: 'error',
              content: `Failed to focus tmux window "${arg}". Ensure tmux is running and window exists.`,
            }]);
          }
          return true;
        }
        if (command.startsWith('//cwd') || command.startsWith('//cd')) {
          const arg = trimmed.split(/\s+/).slice(1).join(' ').trim();
          if (!arg) {
            setMessages((prev) => [...prev, { id: nextMsgId(), role: 'command', content: `Workspace: ${workspaceDir}` }]);
            return true;
          }
          try {
            const resolved = arg;
            if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
              setMessages((prev) => [...prev, { id: nextMsgId(), role: 'error', content: `Not a directory: ${resolved}` }]);
              return true;
            }
            setWorkspaceDir(resolved);
            setMessages((prev) => [...prev, { id: nextMsgId(), role: 'command', content: `Workspace set to: ${resolved}` }]);
            return true;
          } catch (e) {
            setMessages((prev) => [...prev, { id: nextMsgId(), role: 'error', content: e?.message || 'Failed to set workspace directory' }]);
            return true;
          }
        }
        if (isSystem) {
          setMessages((prev) => [...prev, {
            id: nextMsgId(),
            role: 'command',
            content: `Unknown system command: ${command}. Type //help for available commands.`,
          }]);
          return true;
        }
        if (command.startsWith('/')) {
          if (command === '/provider' || command === '/runtime' || command === '/model' || command === '/profile' || command === '/status' || command === '/help') {
            setMessages((prev) => [...prev, {
              id: nextMsgId(),
              role: 'command',
              content: `System commands use \`//\` now. Try: //${command.slice(1)}`,
            }]);
            return true;
          }
          setMessages((prev) => [...prev, {
            id: nextMsgId(),
            role: 'command',
            content: `Unknown command: ${command}. Type /help for available commands.`,
          }]);
          return true;
        }
        return false;
    }
  };

  // Send message
  const handleSubmit = async (value) => {
    if (!value.trim() || isLoading) return;

    // Check for slash commands first
    if (handleSlashCommand(value.trim())) {
      return;
    }

    const userMessage = value.trim();

    // In chat-only modes (codex-api, direct-api), refuse to "do file ops" deterministically to avoid false claims.
    const isChatOnlyRuntime = currentRuntime === 'codex-api' || currentRuntime === 'direct-api';
    if (isChatOnlyRuntime && looksLikeFileOpRequest(userMessage)) {
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: 'user', content: userMessage },
        {
          id: nextMsgId(),
          role: 'system',
          content: 'This runtime is chat-only and cannot read/write local files. Use //runtime and select codex-runtime, opencode-runtime, or claude-code to enable real file edits/reads.',
        },
      ]);
      return;
    }

    // Handle Claude Code runtime (native TTY)
    if (currentRuntime === 'claude-code') {
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: 'user', content: userMessage },
        {
          id: nextMsgId(),
          role: 'system',
          content: 'Claude Code runtime launches `claude` in a native terminal. Run `claude` directly in your terminal for full capabilities.',
        },
      ]);
      return;
    }

    // Determine runner label
    const runner = currentProvider === 'claude-code'
      ? 'Claude Code runtime'
      : currentRuntime === 'codex-runtime'
        ? 'Codex runtime'
        : currentRuntime === 'opencode-runtime'
          ? 'OpenCode runtime'
        : currentRuntime === 'direct-api'
          ? `Direct API (${currentProvider})`
          : 'Codex chat API';
    pushSystemMessage(`Running ${runner} (${currentModel})...`);
    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'user', content: userMessage }]);

    // Set up trace tracking for this turn
    const correlationId = newCorrelationId();
    setTurnCorrelationId(correlationId);
    setTracesCollapsed(false);
    clearTraces();

    setIsLoading(true);

    try {
      const cwd = workspaceDir;

      const history = messages
        .filter((m) => m.role !== 'system' && m.role !== 'error' && m.role !== 'command')
        .map((m) => ({ role: m.role, content: m.content }));
      history.push({ role: 'user', content: userMessage });

      if (currentProvider === 'openai-oauth' && currentRuntime === 'codex-runtime') {
        const r = await runCodexRuntimeTurn({
          stateDir,
          model: currentModel,
          profileName: currentProfile,
          prompt: userMessage,
          cwd,
          eventsPath: eventsFilePath,
          correlationId,
        });
        setMessages((prev) => [...prev, { id: nextMsgId(), role: 'assistant', content: r.text }]);
        if (r.fileChanges?.length) {
          setMessages((prev) => [...prev, { id: nextMsgId(), role: 'system', content: `Codex changed ${r.fileChanges.length} file(s): ${r.fileChanges.join(', ')}` }]);
        } else {
          setMessages((prev) => [...prev, { id: nextMsgId(), role: 'system', content: 'Codex reported no file changes.' }]);
        }
        return;
      }

      if (currentProvider === 'openai-oauth' && currentRuntime === 'opencode-runtime') {
        const pending = [];
        let flushTimer = null;
        const flush = () => {
          flushTimer = null;
          if (!pending.length) return;
          const batch = pending.splice(0, pending.length);
          setMessages((prev) => [
            ...prev,
            ...batch.map((e) => ({
              id: nextMsgId(),
              role: e.kind === 'error' ? 'error' : 'system',
              content: e.kind === 'tool_use'
                ? `OpenCode tool: ${e.tool} — ${e.message}`
                : `OpenCode: ${e.message}`,
            })),
          ]);
        };
        const onEvent = (e) => {
          pending.push(e);
          if (!flushTimer) flushTimer = setTimeout(flush, 120);
        };

        const r = await runOpenCodeRuntimeTurn({
          stateDir,
          model: opencodeModelForRuntime(currentModel),
          agent: opencodeAgentForRuntime(),
          prompt: userMessage,
          cwd,
          onEvent,
          eventsPath: eventsFilePath,
          correlationId,
        });
        if (flushTimer) clearTimeout(flushTimer);
        flush();

        setMessages((prev) => [...prev, { id: nextMsgId(), role: 'assistant', content: r.text }]);
        if (r.fileChanges?.length) {
          setMessages((prev) => [...prev, { id: nextMsgId(), role: 'system', content: `OpenCode touched ${r.fileChanges.length} path(s): ${r.fileChanges.join(', ')}` }]);
        } else {
          setMessages((prev) => [...prev, { id: nextMsgId(), role: 'system', content: 'OpenCode reported no obvious path references.' }]);
        }
        return;
      }

      // codex-api mode is chat-only (no local FS/terminal access). Provide an explicit system prompt to prevent false claims.
      const systemPreamble = [
        'You are running in My LLM Workbench (managed chat, no tools).',
        'You do NOT have direct access to the user’s filesystem or terminal in this mode.',
        'Never claim you created/edited/read files or ran commands.',
        'If asked to modify or read local files, tell the user to switch to a tool runtime: //runtime -> codex-runtime or opencode-runtime.',
        `Current mode: ${sessionMode || 'B'}`,
        `Provider: ${currentProvider}`,
        `Runtime: ${currentRuntime}`,
        `Workspace: ${cwd}`,
      ].join('\n');

      const providerHistory = [{ role: 'system', content: systemPreamble }, ...history];

      const result = await new Promise((resolve, reject) => {
        const env = {
          ...process.env,
          WORKBENCH_STATE_DIR: stateDir,
          WORKBENCH_PROVIDER: currentProvider,
          WORKBENCH_OPENAI_MODEL: currentModel,
        };

        if (currentProfile) {
          env.WORKBENCH_OPENAI_OAUTH_PROFILE = currentProfile;
        }

        const py = spawn('python3', ['-c', `
import sys
sys.path.insert(0, 'runner')
import json
from providers.openai_oauth_codex import OpenAICodexOAuthProvider

messages = json.loads(sys.argv[1])
try:
    provider = OpenAICodexOAuthProvider.from_env()
    result = provider.chat(messages, timeout_s=90.0)
    text = provider.extract_text(result)
    print(json.dumps({"ok": True, "text": text}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`, JSON.stringify(providerHistory)], { env, cwd: repoRoot });

        let stdout = '';
        let stderr = '';
        py.stdout.on('data', (d) => (stdout += d.toString()));
        py.stderr.on('data', (d) => (stderr += d.toString()));
        py.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(stderr || `Process exited with code ${code}`));
          } else {
            try {
              resolve(JSON.parse(stdout));
            } catch (e) {
              reject(new Error(`Invalid response: ${stdout}`));
            }
          }
        });
        py.on('error', reject);
      });

      if (result.ok) {
        setMessages((prev) => [...prev, { id: nextMsgId(), role: 'assistant', content: result.text }]);
      } else {
        setMessages((prev) => [...prev, { id: nextMsgId(), role: 'error', content: result.error }]);
      }
    } catch (e) {
      setMessages((prev) => [...prev, { id: nextMsgId(), role: 'error', content: e.message }]);
    } finally {
      setIsLoading(false);
      setTurnCorrelationId(null);
    }
  };

  // Handle model selection
  const handleModelSelect = useCallback((model) => {
    setCurrentModel(model);
    setMessages((prev) => [...prev, {
      id: nextMsgId(),
      role: 'command',
      content: `Model changed to: ${model}`,
    }]);
    setViewMode('chat');
  }, []);

  // Handle profile selection
  const handleProfileSelect = useCallback((profile) => {
    setCurrentProfile(profile);
    setMessages((prev) => [...prev, {
      id: nextMsgId(),
      role: 'command',
      content: `Profile changed to: ${profile}`,
    }]);
    setViewMode('chat');
  }, []);

  // Handle provider selection (only Claude Code and OpenAI Codex)
  const handleProviderSelect = useCallback((providerValue) => {
    if (providerValue === 'claude-code') {
      const runtime = claudeConnectionMode === 'managed' ? 'claude-managed' : 'claude-native';
      setCurrentProvider(providerValue);
      setCurrentRuntime(runtime);
      setCurrentModel(CLAUDE_MODELS?.[0]?.value || 'sonnet');

      if (runtime === 'claude-native') {
        const launched = launchClaudeCodeInPane();
        if (launched.success) {
          setMessages((prev) => [...prev, {
            id: nextMsgId(),
            role: 'command',
            content: 'Provider switched to Claude Code. Runtime: claude-native. Claude CLI started in tmux window "ui" (pane 0). Workbench controls remain in tmux window "control". Use `//focus ui` or tmux window switch to view Claude.',
          }]);
        } else {
          const reasonMessage = launched.message || 'Failed to launch Claude Code. Are you running in tmux?';
          setMessages((prev) => [...prev, {
            id: nextMsgId(),
            role: 'error',
            content: reasonMessage,
          }]);
        }
      } else {
        setMessages((prev) => [...prev, {
          id: nextMsgId(),
          role: 'command',
          content: 'Provider switched to Claude Code. Activate the managed executor or run //status for instructions.',
        }]);
      }
    } else {
      // OpenAI Codex OAuth
      setCurrentProvider(providerValue);
      const runtime = codexAvailable ? 'codex-runtime' : 'codex-api';
      setCurrentRuntime(runtime);
      setCurrentModel('gpt-5-codex-mini');
      setMessages((prev) => [...prev, {
        id: nextMsgId(),
        role: 'command',
        content: `Provider switched to Codex. Runtime: ${runtime}. Model: gpt-5-codex-mini`,
      }]);
    }
    setViewMode('chat');
  }, [claudeConnectionMode, codexAvailable]);

const RuntimeSelector = memo(function RuntimeSelector({ currentRuntime, currentProvider, codexAvailable, opencodeAvailable, claudeAvailable, onSelect, onCancel }) {
  useInput((input, key) => {
    if (key.escape) onCancel();
  });

  // Memoize options - don't include currentRuntime in deps to prevent selection reset
  const clauses = useMemo(() => {
    if (currentProvider === 'claude-code') {
      return [
        { label: 'Claude tmux surface (native CLI)', value: 'claude-native' },
        { label: 'Claude managed surface (system executor)', value: 'claude-managed' },
      ];
    }

    // For OpenAI Codex provider
    const allOptions = [
      { label: 'Codex – Chat Mode (OpenAI API, chat-only)', value: 'codex-api', available: true },
      { label: 'Codex – CLI Mode (local CLI, file edits)', value: 'codex-runtime', available: codexAvailable },
      { label: 'OpenCode – Run Mode (local opencode, file edits)', value: 'opencode-runtime', available: opencodeAvailable },
      { label: 'Claude Code (Anthropic native TTY)', value: 'claude-code', available: claudeAvailable },
    ];

    return allOptions.map((opt) => ({
      label: opt.available ? opt.label : `${opt.label} (not installed)`,
      value: opt.value,
    }));
  }, [currentProvider, codexAvailable, opencodeAvailable, claudeAvailable]);

  // Find current runtime label for display
  const currentLabel = clauses.find(c => c.value === currentRuntime)?.label || currentRuntime;

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan">Select Runtime</Text>
      </Box>
      <Box paddingX={2}>
        <Menu options={clauses} onSelect={onSelect} showHint={false} />
      </Box>
      <Box marginTop={1} paddingX={2} flexDirection="column">
        <Text dimColor>Current: {currentLabel} ✓</Text>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
});

  const handleRuntimeSelect = useCallback((runtime) => {
    if (currentProvider === 'claude-code') {
      const normalized = runtime === 'claude-managed' ? 'managed' : 'tmux';
      setClaudeConnectionModeState(setClaudeConnectionMode(stateDir, normalized));
      setCurrentRuntime(runtime);
      setMessages((prev) => [...prev, {
        id: nextMsgId(),
        role: 'command',
        content: `Runtime changed to: ${runtime} (${normalized === 'managed' ? 'managed executor' : 'tmux native'})`,
      }]);
      setViewMode('chat');
      return;
    }

    if (runtime === 'codex-runtime' && !codexAvailable) {
      setMessages((prev) => [...prev, {
        id: nextMsgId(),
        role: 'error',
        content: 'codex runtime is not available (codex CLI not found in PATH). Install codex or choose codex-api.',
      }]);
      setViewMode('chat');
      return;
    }

    if (runtime === 'opencode-runtime' && !opencodeAvailable) {
      setMessages((prev) => [...prev, {
        id: nextMsgId(),
        role: 'error',
        content: 'OpenCode runtime is not available (opencode not found in PATH). Install opencode or set WORKBENCH_OPENCODE_BIN.',
      }]);
      setViewMode('chat');
      return;
    }

    // Handle Claude Code runtime selection (native TTY) - actually launch claude
    if (runtime === 'claude-code') {
      // Check if claude is available
      if (!claudeAvailable) {
        setMessages((prev) => [...prev, {
          id: nextMsgId(),
          role: 'error',
          content: 'Claude Code is not available. Install claude CLI first: npm install -g @anthropic-ai/claude-code',
        }]);
        setViewMode('chat');
        return;
      }

      // Launch Claude Code in tmux pane
      const launched = launchClaudeCodeInPane();
      if (launched.success) {
        setCurrentRuntime(runtime);
        setCurrentProvider('claude-code'); // Also switch provider to Claude Code
        setCurrentModel(CLAUDE_MODELS?.[0]?.value || 'sonnet');
        setMessages((prev) => [...prev, {
          id: nextMsgId(),
          role: 'command',
          content: 'Runtime changed to: Claude Code. Claude CLI started in tmux. Use `//focus ui` or switch tmux window to interact with Claude.',
        }]);
      } else {
        setMessages((prev) => [...prev, {
          id: nextMsgId(),
          role: 'error',
          content: launched.message || 'Failed to launch Claude Code. Are you running in tmux?',
        }]);
      }
      setViewMode('chat');
      return;
    }

    setCurrentRuntime(runtime);
    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'command', content: `Runtime changed to: ${runtime}` }]);
    setViewMode('chat');
  }, [currentProvider, stateDir, codexAvailable, opencodeAvailable, claudeAvailable]);

  const returnToChat = useCallback(() => {
    setViewMode('chat');
  }, []);

  // Render different views based on mode
  switch (viewMode) {
    case 'help':
      return <HelpView onClose={returnToChat} />;

    case 'model':
      return (
        <ModelSelector
          currentModel={currentModel}
          currentProvider={currentProvider}
          onSelect={handleModelSelect}
          onCancel={returnToChat}
        />
      );

    case 'profile':
      return (
        <ProfileSelector
          oauthPool={oauthPool}
          currentProfile={currentProfile}
          onSelect={handleProfileSelect}
          onCancel={returnToChat}
        />
      );

    case 'status':
      return (
        <StatusView
          oauthPool={oauthPool}
          currentProfile={currentProfile}
          currentModel={currentModel}
          onClose={returnToChat}
        />
      );

    case 'provider':
      return (
        <ProviderSelector
          currentProvider={currentProvider}
          claudeAvailable={claudeAvailable}
          onSelect={handleProviderSelect}
          onCancel={returnToChat}
        />
      );

    case 'runtime':
      return (
        <RuntimeSelector
          currentRuntime={currentRuntime}
          currentProvider={currentProvider}
          codexAvailable={codexAvailable}
          opencodeAvailable={opencodeAvailable}
          claudeAvailable={claudeAvailable}
          onSelect={handleRuntimeSelect}
          onCancel={returnToChat}
        />
      );

    default:
      break;
  }

  // Show minimal UI when window is too small (prevents flicker from layout overflow)
  if (isTooSmall) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">Window too small</Text>
        <Text dimColor>Min: {MIN_COLS}x{MIN_ROWS} | Current: {cols}x{rows}</Text>
        <Text dimColor>Resize window to continue</Text>
      </Box>
    );
  }

  // Ink clears the entire terminal when rendered output >= terminal height.
  // Keep the rendered chat output comfortably under `rows` to avoid visible flicker,
  // especially while overlays (palette/quick actions) are open.
  const messagesToRender = (() => {
    const sidebarWidth = sidebarEligible && showSidebar ? 42 : 0;
    const approxTextCols = Math.max(24, cols - sidebarWidth - 20);
    // Account for trace panel: collapsed=2 rows, expanded=min(traces+4, 16)
    const tracePanelRows = traces.length > 0
      ? (tracesCollapsed && !isLoading ? 2 : Math.min(traces.length + 4, 16))
      : (isLoading ? 4 : 0);
    const reservedRows = (composer.showPalette ? 18 : 10) + (isLoading ? 2 : 0) + tracePanelRows;
    const budget = Math.max(0, rows - reservedRows);
    if (budget <= 0) return [];

    const estimateWrappedLines = (text) => {
      const s = String(text ?? '');
      const lines = s.split('\n');
      let count = 0;
      for (const line of lines) {
        const len = line.length;
        count += Math.max(1, Math.ceil(len / approxTextCols));
      }
      return count;
    };

    let used = 0;
    const out = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const estimated = 1 /* header */ + estimateWrappedLines(m?.content) + 1 /* margin */;
      if (out.length > 0 && used+estimated > budget) break;
      used += estimated;
      out.push(m);
      if (used >= budget) break;
    }
    return out.reverse();
  })();

  // Main chat view
  return (
    <Box flexDirection="row" padding={1} height={Math.max(0, rows - 4)}>
      <Box flexDirection="column" flexGrow={1} minWidth={60} paddingRight={1}>
        {/* Header */}
        <Box borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
          <Text bold color="cyan"> CHAT </Text>
          <Text dimColor> | </Text>
          <Text color={sessionMode === 'A' ? 'green' : 'yellow'}>
            {sessionMode === 'A' ? 'CTRL' : 'COMPAT'}
          </Text>
          <Text dimColor> | </Text>
          <Text color="magenta">
            {currentProvider === 'claude-code' ? 'Claude' : 'Codex'}
          </Text>
          <Text dimColor> | </Text>
          <Text color="green">{currentModel}</Text>
          {cols >= 120 && (
            <>
              <Text dimColor> | </Text>
              <Text color="yellow">{currentProfile || 'auto'}</Text>
              <Text dimColor> | </Text>
              <Text color="cyan">{currentRuntime}</Text>
            </>
          )}
          <Text dimColor> | //help</Text>
        </Box>

        {/* Messages area */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
          {messagesToRender.map((msg) => (
            <Message key={msg.id || `${msg.role}:${msg.content?.slice?.(0, 32) || ''}`} role={msg.role} content={msg.content} />
          ))}

          {/* Reasoning traces panel */}
          {(isLoading || traces.length > 0) && (
            <TracesPanel
              traces={traces}
              isActive={isLoading}
              collapsed={tracesCollapsed && !isLoading}
              onToggle={() => setTracesCollapsed((c) => !c)}
            />
          )}

          {isLoading && (
            <Box marginTop={1}>
              <Spinner label="Thinking..." />
            </Box>
          )}
        </Box>

        {/* Command palette overlay */}
        {composer.showPalette && (
          <CommandPalette
            commands={activePaletteCommands}
            filter={composer.paletteFilter}
            prefix={composer.input.startsWith('//') ? '//' : '/'}
            selectedIndex={composer.paletteIndex}
            onSelect={(cmd) => {
              handleSlashCommand(cmd);
              setComposer((prev) => ({
                ...prev,
                inputKey: prev.inputKey + 1,
                inputDefaultValue: '',
                input: '',
                showPalette: false,
                paletteFilter: '',
                paletteIndex: 0,
              }));
            }}
            onClose={() => {
              setComposer((prev) => ({
                ...prev,
                inputKey: prev.inputKey + 1,
                inputDefaultValue: '',
                input: '',
                showPalette: false,
                paletteFilter: '',
                paletteIndex: 0,
              }));
            }}
          />
        )}

        {/* Input area */}
        <Box borderStyle="single" borderColor={isLoading ? 'gray' : 'cyan'} paddingX={1} marginTop={1}>
          {isLoading ? (
            <Text dimColor>Waiting for response...</Text>
          ) : (
            <Box>
              <Text color="cyan">&gt; </Text>
              <TextInput
                key={composer.inputKey}
                defaultValue={composer.inputDefaultValue}
                onChange={handleInputChange}
                placeholder="Type a message or //help..."
                onSubmit={(value) => {
                  if (composer.showPalette) {
                    const available = filteredPaletteCommandKeys;
                    if (available[composer.paletteIndex]) {
                      handleSlashCommand(available[composer.paletteIndex]);
                      setComposer((prev) => ({
                        ...prev,
                        inputKey: prev.inputKey + 1,
                        inputDefaultValue: '',
                        input: '',
                        showPalette: false,
                        paletteFilter: '',
                        paletteIndex: 0,
                      }));
                      return;
                    }
                  }
                  handleSubmit(value);
                  setComposer((prev) => ({
                    ...prev,
                    inputKey: prev.inputKey + 1,
                    inputDefaultValue: '',
                    input: '',
                    showPalette: false,
                    paletteFilter: '',
                    paletteIndex: 0,
                  }));
                }}
              />
            </Box>
          )}
        </Box>

        {/* Footer - responsive to prevent wrapping/flicker */}
        <Box marginTop={1} paddingX={1} gap={2} flexWrap="nowrap">
          <Text dimColor>//help</Text>
          <Text dimColor>//exit</Text>
          {cols >= 70 && <Text dimColor>/new</Text>}
          {cols >= 80 && <Text dimColor>//mode</Text>}
          {cols >= 90 && <Text dimColor>//provider</Text>}
          {cols >= 100 && <Text dimColor>//model</Text>}
          {cols >= 110 && <Text dimColor>//status</Text>}
        </Box>
      </Box>

      {sidebarEligible && showSidebar && (
        <Box
          flexDirection="column"
          width={40}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          paddingY={0}
        >
          <StatusPane embedded />
        </Box>
      )}
    </Box>
  );
}
