#!/usr/bin/env bun
/**
 * Workbench Control Pane
 * - Designed to be hosted in a persistent tmux pane (not a popup)
 * - Issues system actions via JSONL bus (system.requests.jsonl)
 *
 * Note: This intentionally does NOT exit on Esc; providers own `/` and the main pane
 * is often occupied by Codex/Claude. This pane is the dedicated Workbench command surface.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { join } from 'node:path';
import { render } from 'ink';
import {
  appendSystemRequest,
  isSystemExecutorReady,
  newCorrelationId,
  readSystemResponses,
} from './system-client.js';

function ControlPane() {
  const stateDir = (process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench')).trim();
  const tmuxServer = (process.env.WORKBENCH_TMUX_SERVER || 'workbench').trim();
  const tmuxSession = (process.env.WORKBENCH_TMUX_SESSION || 'workbench').trim();
  const repoRoot = (process.env.WORKBENCH_REPO_ROOT || process.cwd()).trim();

  const executorReady = isSystemExecutorReady(stateDir);

  const actions = useMemo(() => ([
    {
      value: 'launch-claude-ui',
      label: 'Launch Claude Code (control/main pane)',
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
      value: 'launch-codex-ui',
      label: 'Launch Codex (OAuth) (control/main pane)',
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
    { value: 'sep1', label: '—', separator: true },
    {
      value: 'copy-provider-pane',
      label: 'Copy provider pane (less popup)',
      request: {
        type: 'pane.capture',
        tmuxServer,
        tmuxSession,
        window: 'control',
        paneRole: 'main',
        title: 'Provider transcript',
        openPopup: true,
        captureLines: 20000,
      },
    },
    {
      value: 'copy-main-pane',
      label: 'Copy control/main pane (less popup)',
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
    if (!executorReady) {
      setNotice('System executor offline. Start Workbench from a real terminal.');
      return;
    }
    if (item.confirm && confirmIndex !== selected) {
      setConfirmIndex(selected);
      setNotice('Press Enter again to confirm.');
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
    if (key.upArrow) return void setSelectedSafe(selected - 1);
    if (key.downArrow) return void setSelectedSafe(selected + 1);
    if (key.return) return void submitSelected();
    if (input === 'r') {
      setNotice('Refreshed.');
      setResult(null);
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
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text wrap="truncate-end">
          <Text bold color="cyan">WORKBENCH</Text>
          <Text dimColor> cmd</Text>
          <Text dimColor> | executor: </Text>
          <Text color={executorReady ? 'green' : 'red'}>{executorReady ? 'ready' : 'offline'}</Text>
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        {actions.map((a, i) => {
          if (a.separator) {
            return (
              <Box key={a.value}>
                <Text dimColor wrap="truncate-end">{a.label}</Text>
              </Box>
            );
          }
          const active = i === selected;
          const confirming = confirmIndex === i;
          const prefix = confirming ? ' ! ' : active ? ' > ' : '   ';
          const shortcut = i < 9 ? `  [${i + 1}]` : '';
          return (
            <Box key={a.value}>
              <Text
                inverse={active}
                bold={active}
                color={confirming ? 'yellow' : active ? 'cyan' : undefined}
                wrap="truncate-end"
              >
                {prefix}{a.label}{shortcut}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {notice ? <Text color="yellow" wrap="truncate-end">{notice}</Text> : null}
        {inFlight ? (
          <Box gap={1}>
            <Spinner />
            <Text wrap="truncate-end">{inFlight.label}</Text>
          </Box>
        ) : null}
        {result ? (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              Result: <Text color={result.ok ? 'green' : 'red'}>{result.ok ? 'OK' : 'FAIL'}</Text>
              <Text dimColor> | {result.action}</Text>
              <Text dimColor> | {result.summary}</Text>
            </Text>
            {result.detail ? <Text dimColor wrap="truncate-end">{String(result.detail).slice(0, 220)}</Text> : null}
          </Box>
        ) : null}
        <Text dimColor wrap="truncate-end">↑↓ move | Enter run | 1-9 jump | r reset</Text>
      </Box>
    </Box>
  );
}

render(<ControlPane />, { exitOnCtrlC: false });
