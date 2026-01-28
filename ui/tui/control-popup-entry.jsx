#!/usr/bin/env bun
/**
 * Workbench Control Popup
 * - Designed to be launched via `tmux display-popup`
 * - Issues system actions via JSONL bus (system.requests.jsonl)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { join } from 'node:path';
import { render } from 'ink';
import {
  appendSystemRequest,
  isSystemExecutorReady,
  newCorrelationId,
  readSystemResponses,
} from './system-client.js';

// ANSI sequences for alternate screen buffer (flicker prevention)
const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function cleanup() {
  process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

function ControlPopup() {
  const { exit } = useApp();
  const stateDir = (process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench')).trim();
  const tmuxServer = (process.env.WORKBENCH_TMUX_SERVER || 'workbench').trim();
  const tmuxSession = (process.env.WORKBENCH_TMUX_SESSION || 'workbench').trim();
  const repoRoot = (process.env.WORKBENCH_REPO_ROOT || process.cwd()).trim();

  const executorReady = isSystemExecutorReady(stateDir);

  const actions = useMemo(() => ([
    {
      value: 'launch-claude-ui',
      label: 'Launch Claude Code (ui/provider pane)',
      request: {
        type: 'surface.launch',
        surface: 'claude-code',
        cwd: repoRoot,
        title: 'claude',
        tmuxServer,
        tmuxSession,
        window: 'ui',
        paneRole: 'provider',
      },
    },
    {
      value: 'launch-codex-ui',
      label: 'Launch Codex (OAuth) (ui/provider pane)',
      request: {
        type: 'surface.launch',
        surface: 'codex',
        cwd: repoRoot,
        title: 'codex',
        syncOAuth: true,
        tmuxServer,
        tmuxSession,
        window: 'ui',
        paneRole: 'provider',
      },
    },
    { value: 'sep0', label: '—', separator: true },
    {
      value: 'restore-workbench',
      label: 'Restore Workbench UI (control/main pane)',
      request: {
        type: 'surface.launch',
        surface: 'workbench-ink',
        cwd: repoRoot,
        title: 'workbench',
        tmuxServer,
        tmuxSession,
        window: 'control',
        paneRole: 'main',
      },
    },
    {
      value: 'launch-claude',
      label: 'Launch Claude Code (replace control/main pane)',
      confirm: true,
      request: {
        type: 'surface.launch',
        surface: 'claude-code',
        cwd: repoRoot,
        title: 'claude',
        tmuxServer,
        tmuxSession,
        window: 'control',
        paneRole: 'main',
      },
    },
    {
      value: 'launch-codex',
      label: 'Launch Codex (OAuth) (replace control/main pane)',
      confirm: true,
      request: {
        type: 'surface.launch',
        surface: 'codex',
        cwd: repoRoot,
        title: 'codex',
        syncOAuth: true,
        tmuxServer,
        tmuxSession,
        window: 'control',
        paneRole: 'main',
      },
    },
    { value: 'sep1', label: '—', separator: true },
    {
      value: 'copy-main-pane',
      label: 'Copy main pane (less popup)',
      request: {
        type: 'pane.capture',
        tmuxServer,
        tmuxSession,
        window: 'control',
        paneRole: 'main',
        title: 'Transcript',
        openPopup: true,
        captureLines: 20000,
      },
    },
    {
      value: 'docker-probe',
      label: 'Docker probe (MCP)',
      request: { type: 'docker.probe' },
    },
    {
      value: 'verify-fast',
      label: 'Verify (fast)',
      request: { type: 'verify', full: false },
    },
    {
      value: 'verify-full',
      label: 'Verify (full)',
      request: { type: 'verify', full: true },
    },
    {
      value: 'oauth-sync',
      label: 'OAuth sync (one-shot)',
      request: { type: 'oauth.sync', watch: false },
    },
    { value: 'close', label: 'Close', request: null },
  ]), [repoRoot, stateDir, tmuxServer, tmuxSession]);

  const [selected, setSelected] = useState(0);
  const [confirmIndex, setConfirmIndex] = useState(null);
  const [inFlight, setInFlight] = useState(null); // { correlationId, label }
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState(null);
  const offsetRef = useRef(0);

  const setSelectedSafe = (next) => {
    const n = Math.max(0, Math.min(actions.length - 1, next));
    setSelected(n);
    setConfirmIndex(null);
  };

  const submitSelected = () => {
    const item = actions[selected];
    if (!item || item.separator) return;
    if (item.value === 'close') {
      exit();
      return;
    }
    if (!executorReady) {
      setNotice('System executor offline. Start Workbench from a real terminal.');
      return;
    }
    if (item.confirm && confirmIndex !== selected) {
      setConfirmIndex(selected);
      setNotice('Press Enter again to confirm replacing control/main pane.');
      return;
    }

    const correlationId = newCorrelationId();
    appendSystemRequest(stateDir, { ...item.request, correlationId });
    setInFlight({ correlationId, label: item.label });
    setResult(null);
    setNotice(null);
    setConfirmIndex(null);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (confirmIndex !== null) {
        setConfirmIndex(null);
        setNotice(null);
        return;
      }
      exit();
      return;
    }
    if (key.upArrow) {
      setSelectedSafe(selected - 1);
      return;
    }
    if (key.downArrow) {
      setSelectedSafe(selected + 1);
      return;
    }
    if (key.return) {
      submitSelected();
      return;
    }
    const num = Number.parseInt(input, 10);
    if (Number.isFinite(num) && num >= 1 && num <= actions.length) {
      setSelectedSafe(num - 1);
    }
  });

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      const { responses, offset } = readSystemResponses(stateDir, offsetRef.current);
      offsetRef.current = offset;
      for (const r of responses) {
        if (r?.type === 'system.result' && r?.correlationId === inFlight.correlationId) {
          setResult(r);
          setInFlight(null);
          return;
        }
      }
    }, 200);
    return () => clearInterval(timer);
  }, [inFlight, stateDir]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text wrap="truncate-end">
          <Text bold color="cyan">WORKBENCH</Text>
          <Text dimColor> popup</Text>
          <Text dimColor> | executor: </Text>
          <Text color={executorReady ? 'green' : 'red'}>{executorReady ? 'ready' : 'offline'}</Text>
          <Text dimColor> | tmux: {tmuxServer}/{tmuxSession}</Text>
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        {actions.map((a, i) => {
          if (a.separator) {
            return (
              <Box key={a.value} marginY={0}>
                <Text dimColor wrap="truncate-end">{a.label}</Text>
              </Box>
            );
          }
          const active = i === selected;
          const confirming = confirmIndex === i;
          const prefix = confirming ? ' ! ' : active ? ' > ' : '   ';
          const label = a.label;
          const shortcut = i < 9 ? `  [${i + 1}]` : '';
          return (
            <Box key={a.value}>
              <Text
                inverse={active}
                bold={active}
                color={confirming ? 'yellow' : active ? 'cyan' : undefined}
                wrap="truncate-end"
              >
                {prefix}{label}{shortcut}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {notice && (
          <Text color="yellow" wrap="truncate-end">{notice}</Text>
        )}
        {inFlight && (
          <Box gap={1}>
            <Spinner />
            <Text wrap="truncate-end">{inFlight.label}</Text>
          </Box>
        )}
        {result && (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              Result: <Text color={result.ok ? 'green' : 'red'}>{result.ok ? 'OK' : 'FAIL'}</Text>
              <Text dimColor> | {result.action}</Text>
              <Text dimColor> | {result.summary}</Text>
            </Text>
            {result.detail ? <Text dimColor wrap="truncate-end">{String(result.detail).slice(0, 180)}</Text> : null}
          </Box>
        )}
        <Text dimColor wrap="truncate-end">↑↓ move | Enter run | Esc close</Text>
      </Box>
    </Box>
  );
}

process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
render(<ControlPopup />, { exitOnCtrlC: false });
