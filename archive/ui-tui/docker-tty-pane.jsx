#!/usr/bin/env bun
/**
 * Docker TTY Pane - Interactive Docker container terminal view
 *
 * This pane is the "observation window" for users to see what the LLM is doing
 * inside a Docker container. Unlike docker-pane.js (which shows MCP events/logs),
 * this pane provides direct TTY access to the container.
 *
 * Architecture:
 * - control window (F1): LLM controls Docker via Main TUI
 * - docker-tty window (F3): User OBSERVES the same Docker container
 *
 * The docker-tty window mirrors the control window layout:
 * +---------------------+-----------------+
 * | Pane 0: Docker TTY  | Pane 2: Status  |
 * | (Container view)    | (OAuth, MCP)    |
 * +---------------------+-----------------+
 * | Pane 1: Docker Pane (events/logs)     |
 * +---------------------------------------+
 * | (bottom-right: Workbench UI command)  |
 * +---------------------------------------+
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import { spawnSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

const stateDir = process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench');
const repoRoot = process.env.WORKBENCH_REPO_ROOT || process.cwd();
const tmuxServer = process.env.WORKBENCH_TMUX_SERVER || 'workbench';
const tmuxSession = process.env.WORKBENCH_TMUX_SESSION || 'workbench';

// ANSI sequences for alternate screen buffer
const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function formatTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getRunningContainers() {
  try {
    const result = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const [name, status, image] = line.split('\t');
          return { name, status, image };
        });
    }
  } catch {}
  return [];
}

function getWorkbenchContainer() {
  const containers = getRunningContainers();
  // Prefer containers with "workbench" or "sandbox" or "claude" in name
  const preferred = containers.find(c =>
    c.name.includes('workbench') || c.name.includes('sandbox') || c.name.includes('claude')
  );
  return preferred || containers[0] || null;
}

function DockerTTYPane() {
  const { stdout } = useStdout();
  const rows = stdout?.rows || 24;
  const cols = stdout?.columns || 80;

  const [containers, setContainers] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState('list'); // 'list' | 'attached' | 'connecting'
  const [attachedContainer, setAttachedContainer] = useState(null);
  const [streamLines, setStreamLines] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [error, setError] = useState(null);

  const streamProcRef = useRef(null);
  const refreshIntervalRef = useRef(null);

  // Refresh container list
  const refreshContainers = useCallback(() => {
    const list = getRunningContainers();
    setContainers(list);
    setLastUpdate(new Date());

    // Auto-select workbench container if available
    if (list.length > 0 && selectedIdx >= list.length) {
      setSelectedIdx(0);
    }

    // Find preferred container
    const preferredIdx = list.findIndex(c =>
      c.name.includes('workbench') || c.name.includes('sandbox') || c.name.includes('claude')
    );
    if (preferredIdx >= 0 && selectedIdx === 0 && mode === 'list') {
      setSelectedIdx(preferredIdx);
    }
  }, [selectedIdx, mode]);

  // Start streaming logs from container (read-only observation)
  const startObserving = useCallback((containerName) => {
    if (streamProcRef.current) {
      streamProcRef.current.kill();
    }

    setMode('connecting');
    setError(null);
    setStreamLines([`--- Connecting to ${containerName} ---`]);

    // Use docker logs -f for read-only observation
    const proc = spawn('docker', ['logs', '-f', '--tail', '100', containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    streamProcRef.current = proc;

    proc.on('error', (err) => {
      setError(`Failed to connect: ${err.message}`);
      setMode('list');
      streamProcRef.current = null;
    });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        setMode('attached');
        setAttachedContainer(containerName);
        setStreamLines(prev => {
          const newLines = [...prev];
          for (const line of lines) {
            newLines.push(`${formatTimestamp(new Date())} ${line}`);
          }
          return newLines.slice(-500); // Keep last 500 lines
        });
      }
    });

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      setStreamLines(prev => {
        const newLines = [...prev];
        for (const line of lines) {
          newLines.push(`${formatTimestamp(new Date())} [ERR] ${line}`);
        }
        return newLines.slice(-500);
      });
      setMode('attached');
      setAttachedContainer(containerName);
    });

    proc.on('close', (code) => {
      setStreamLines(prev => [...prev, `--- Stream ended (exit ${code}) ---`]);
      if (mode === 'attached' || mode === 'connecting') {
        setMode('list');
      }
      streamProcRef.current = null;
    });

    // If no output after 2 seconds, show connected message
    setTimeout(() => {
      if (streamProcRef.current === proc) {
        setMode('attached');
        setAttachedContainer(containerName);
        setStreamLines(prev => {
          if (prev.length <= 1) {
            return [...prev, `--- Connected (waiting for output) ---`];
          }
          return prev;
        });
      }
    }, 2000);
  }, [mode]);

  // Stop observing
  const stopObserving = useCallback(() => {
    if (streamProcRef.current) {
      streamProcRef.current.kill();
      streamProcRef.current = null;
    }
    setMode('list');
    setAttachedContainer(null);
    setStreamLines([]);
  }, []);

  // Launch interactive docker exec in tmux
  const launchInteractiveShell = useCallback((containerName) => {
    // Send docker exec command to this pane via tmux
    try {
      spawnSync('tmux', [
        '-L', tmuxServer,
        'send-keys',
        '-t', `${tmuxSession}:docker-tty.0`,
        `docker exec -it ${containerName} bash`,
        'Enter'
      ], { encoding: 'utf8' });

      // Exit this TUI so the user gets the raw terminal
      process.exit(0);
    } catch (err) {
      setError(`Failed to launch shell: ${err.message}`);
    }
  }, []);

  // Initial load and periodic refresh
  useEffect(() => {
    refreshContainers();
    refreshIntervalRef.current = setInterval(refreshContainers, 5000);
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
      if (streamProcRef.current) {
        streamProcRef.current.kill();
      }
    };
  }, [refreshContainers]);

  // Keyboard input
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      stopObserving();
      process.exit(0);
    }

    if (mode === 'list') {
      if (key.upArrow && containers.length > 0) {
        setSelectedIdx(prev => Math.max(0, prev - 1));
      }
      if (key.downArrow && containers.length > 0) {
        setSelectedIdx(prev => Math.min(containers.length - 1, prev + 1));
      }
      if (key.return && containers.length > 0) {
        const container = containers[selectedIdx];
        if (container) {
          startObserving(container.name);
        }
      }
      if (input === 'i' && containers.length > 0) {
        const container = containers[selectedIdx];
        if (container) {
          launchInteractiveShell(container.name);
        }
      }
      if (input === 'r') {
        refreshContainers();
      }
      if (input === 'q') {
        process.exit(0);
      }
    } else if (mode === 'attached' || mode === 'connecting') {
      if (key.escape || input === 'q') {
        stopObserving();
      }
      if (input === 'i' && attachedContainer) {
        stopObserving();
        launchInteractiveShell(attachedContainer);
      }
    }
  });

  const availableHeight = Math.max(5, rows - 2);

  // Render list mode
  if (mode === 'list') {
    return (
      <Box flexDirection="column" height={availableHeight} width={cols}>
        {/* Header */}
        <Box paddingX={1}>
          <Text bold color="magenta">DOCKER TTY</Text>
          <Text dimColor> | </Text>
          <Text dimColor>Observation Window</Text>
          <Text dimColor> | </Text>
          <Text dimColor>{formatTimestamp(lastUpdate)}</Text>
        </Box>

        {/* Container list */}
        <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column" marginTop={1}>
          <Text bold>Running Containers:</Text>
          {containers.length === 0 ? (
            <Text dimColor>No containers running. Start a sandbox first.</Text>
          ) : (
            containers.map((c, i) => {
              const isSelected = i === selectedIdx;
              const isPreferred = c.name.includes('workbench') || c.name.includes('sandbox') || c.name.includes('claude');
              return (
                <Box key={c.name}>
                  <Text
                    inverse={isSelected}
                    bold={isSelected}
                    color={isPreferred ? 'cyan' : undefined}
                  >
                    {isSelected ? ' > ' : '   '}
                    {c.name}
                    <Text dimColor> ({c.status})</Text>
                    {isPreferred && <Text color="yellow"> *</Text>}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>

        {/* Error message */}
        {error && (
          <Box paddingX={1} marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        {/* Help */}
        <Box paddingX={1} marginTop={1} flexDirection="column">
          <Text dimColor>Enter: observe logs | i: interactive shell | r: refresh | q: quit</Text>
          <Text dimColor wrap="truncate-end">
            Tip: This window mirrors control (F1). LLM controls Docker there, you observe here.
          </Text>
        </Box>
      </Box>
    );
  }

  // Render attached/connecting mode
  const displayLines = streamLines.slice(-(availableHeight - 4));

  return (
    <Box flexDirection="column" height={availableHeight} width={cols}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color="magenta">DOCKER TTY</Text>
        <Text dimColor> | </Text>
        <Text color={mode === 'connecting' ? 'yellow' : 'green'}>
          {mode === 'connecting' ? 'CONNECTING' : 'OBSERVING'}
        </Text>
        <Text dimColor> | </Text>
        <Text color="cyan">{attachedContainer || '...'}</Text>
      </Box>

      {/* Stream output */}
      <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column" marginTop={1} flexGrow={1}>
        {displayLines.length === 0 ? (
          <Text dimColor>Waiting for container output...</Text>
        ) : (
          displayLines.map((line, i) => (
            <Box key={i}>
              <Text
                color={line.includes('[ERR]') ? 'red' : line.includes('---') ? 'cyan' : undefined}
                wrap="truncate-end"
              >
                {line.slice(0, cols - 4)}
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Help */}
      <Box paddingX={1}>
        <Text dimColor>q/Esc: back to list | i: interactive shell</Text>
      </Box>
    </Box>
  );
}

// Enter alternate screen buffer before Ink starts rendering
process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);

function cleanup() {
  process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

const { waitUntilExit } = render(<DockerTTYPane />);

waitUntilExit().then(() => {
  cleanup();
  process.exit(0);
});
