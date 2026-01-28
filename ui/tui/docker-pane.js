#!/usr/bin/env node
/**
 * Docker Pane - Live Docker process streaming with event status fallback
 *
 * Architecture:
 * - Primary: Stream stdout/stderr from Docker containers in real-time
 * - Secondary: Poll system.responses.jsonl for Docker/Sandbox events
 * - Renders in a compact tmux-friendly format
 *
 * Layout:
 * Window "control":
 * +--------------------+-----------------+
 * | Pane 0: Main TUI   | Pane 1: Status  |
 * | (Chat/Control)     | (OAuth, MCP)    |
 * +--------------------+-----------------+
 * | Pane 2: Docker process streaming     |
 * | (stdout/stderr from Docker container)|
 * +--------------------------------------+
 */
import { render, Box, Text, useStdout, useInput } from 'ink';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { readFileSync, existsSync, statSync, mkdirSync, watchFile, unwatchFile } from 'fs';
import { join, dirname } from 'path';
import { spawn, spawnSync } from 'child_process';

const stateDir = process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench');
const repoRoot = process.env.WORKBENCH_REPO_ROOT || process.cwd();
const dockerPaneMode = (process.env.WORKBENCH_DOCKER_PANE_MODE || '').trim().toLowerCase();
const useRawMode = dockerPaneMode === '' || dockerPaneMode === 'raw' || dockerPaneMode === '1' || dockerPaneMode === 'true';

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  }
}

function readCurrentSessionId() {
  const currentPath = join(stateDir, 'state', 'current.json');
  ensureDir(dirname(currentPath));
  try {
    if (existsSync(currentPath)) {
      const data = JSON.parse(readFileSync(currentPath, 'utf8'));
      if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
        return data.sessionId.trim();
      }
    }
  } catch {}
  return null;
}

function getSystemPaths() {
  const sessionId = readCurrentSessionId();
  if (!sessionId) return null;
  const base = join(stateDir, sessionId);
  return {
    sessionId,
    base,
    responsesPath: join(base, 'system.responses.jsonl'),
  };
}

function readSystemResponses(offset = 0) {
  const paths = getSystemPaths();
  if (!paths) return { responses: [], offset: 0 };

  const { responsesPath } = paths;
  if (!existsSync(responsesPath)) {
    return { responses: [], offset: 0 };
  }

  let stats = null;
  try {
    stats = statSync(responsesPath);
  } catch {
    return { responses: [], offset };
  }

  const total = stats.size;
  if (offset > total) offset = total;
  if (total === 0 || offset === total) {
    return { responses: [], offset: total };
  }

  const content = readFileSync(responsesPath, 'utf8');
  const chunk = content.slice(offset);
  const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
  const responses = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.version === 1 && typeof obj.type === 'string') {
        responses.push(obj);
      }
    } catch {}
  }

  return { responses, offset: total };
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function getRunningContainers() {
  try {
    const result = spawnSync('docker', ['ps', '--format', '{{.Names}}'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    }
  } catch {}
  return [];
}

function getWorkbenchContainer() {
  const containers = getRunningContainers();
  // Prefer containers with "workbench" or "sandbox" in name
  const preferred = containers.find(c =>
    c.includes('workbench') || c.includes('sandbox') || c.includes('claude')
  );
  return preferred || containers[0] || null;
}

function runRawPane() {
  let offset = 0;
  let currentContainer = null;
  let streamProc = null;
  let lastProbeTs = 0;

  const log = (line) => {
    process.stdout.write(`${line}\n`);
  };

  const stopStream = () => {
    if (streamProc) {
      try { streamProc.kill(); } catch {}
      streamProc = null;
    }
  };

  const startStream = (containerName) => {
    stopStream();
    currentContainer = containerName;
    log(`--- ${formatTimestamp(new Date().toISOString())} STREAM ${containerName} ---`);
    streamProc = spawn('docker', ['logs', '-f', '--tail', '50', containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const writeLines = (data, isErr) => {
      const lines = data.toString().split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const ts = formatTimestamp(new Date().toISOString());
        const tag = isErr ? '[ERR]' : '[OUT]';
        log(`${ts} ${tag} ${line}`);
      }
    };
    streamProc.stdout.on('data', (d) => writeLines(d, false));
    streamProc.stderr.on('data', (d) => writeLines(d, true));
    streamProc.on('close', (code) => {
      log(`--- ${formatTimestamp(new Date().toISOString())} STREAM ENDED (${code}) ---`);
    });
  };

  const pollSystemResponses = () => {
    try {
      const { responses, offset: newOffset } = readSystemResponses(offset);
      if (newOffset !== offset) offset = newOffset;
      const relevant = responses.filter((r) =>
        r?.action?.startsWith('docker.') || r?.action?.startsWith('sandbox.')
      );
      for (const r of relevant) {
        const ts = formatTimestamp(r.endedAt || new Date().toISOString());
        const status = r.ok ? 'OK' : 'ERR';
        log(`${ts} [SYS] ${status} ${r.action} ${r.summary || ''}`.trim());
      }
    } catch {}
  };

  const pollContainers = () => {
    const container = getWorkbenchContainer();
    if (container && container !== currentContainer) {
      startStream(container);
    }
    if (!container && currentContainer) {
      log(`--- ${formatTimestamp(new Date().toISOString())} NO CONTAINER ---`);
      currentContainer = null;
      stopStream();
    }
  };

  log(`DOCKER PANE (raw) | ${formatTimestamp(new Date().toISOString())}`);
  log(`Tip: tmux scrollback available (no alternate screen).`);

  pollContainers();
  pollSystemResponses();

  const sysTimer = setInterval(pollSystemResponses, 1000);
  const containerTimer = setInterval(pollContainers, 5000);
  const probeTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastProbeTs < 10000) return;
    lastProbeTs = now;
  }, 10000);

  const cleanup = () => {
    stopStream();
    clearInterval(sysTimer);
    clearInterval(containerTimer);
    clearInterval(probeTimer);
  };

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

function DockerPane() {
  const { stdout } = useStdout();
  const rows = stdout?.rows || 24;
  const cols = stdout?.columns || 80;

  const [events, setEvents] = useState([]);
  const [offset, setOffset] = useState(0);
  const [sandboxStatus, setSandboxStatus] = useState({ running: false, name: null });
  const [lastUpdate, setLastUpdate] = useState(null);

  // Process streaming state
  const [streamLines, setStreamLines] = useState([]);
  const [activeContainer, setActiveContainer] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [mode, setMode] = useState('events'); // 'events' | 'stream'
  const streamProcRef = useRef(null);

  // Start streaming from a container
  const startStream = (containerName) => {
    if (streamProcRef.current) {
      streamProcRef.current.kill();
    }

    setActiveContainer(containerName);
    setIsStreaming(true);
    setStreamLines([`--- Streaming from ${containerName} ---`]);
    setMode('stream');

    // Use docker logs -f to stream container output
    const proc = spawn('docker', ['logs', '-f', '--tail', '50', containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    streamProcRef.current = proc;

    const addLine = (line, isError = false) => {
      const ts = formatTimestamp(new Date().toISOString());
      const prefix = isError ? '[ERR]' : '[OUT]';
      setStreamLines(prev => {
        const newLines = [...prev, `${ts} ${prefix} ${line}`];
        // Keep last 200 lines
        return newLines.slice(-200);
      });
    };

    let stdoutBuf = '';
    let stderrBuf = '';

    proc.stdout.on('data', (data) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      lines.forEach(line => {
        if (line.trim()) addLine(line.trim(), false);
      });
    });

    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() || '';
      lines.forEach(line => {
        if (line.trim()) addLine(line.trim(), true);
      });
    });

    proc.on('close', (code) => {
      addLine(`--- Stream ended (exit ${code}) ---`, false);
      setIsStreaming(false);
      streamProcRef.current = null;
    });

    proc.on('error', (err) => {
      addLine(`--- Stream error: ${err.message} ---`, true);
      setIsStreaming(false);
      streamProcRef.current = null;
    });
  };

  // Stop streaming
  const stopStream = () => {
    if (streamProcRef.current) {
      streamProcRef.current.kill();
      streamProcRef.current = null;
    }
    setIsStreaming(false);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamProcRef.current) {
        streamProcRef.current.kill();
      }
    };
  }, []);

  // Poll JSONL for Docker/Sandbox results
  useEffect(() => {
    const poll = () => {
      try {
        const { responses, offset: newOffset } = readSystemResponses(offset);
        if (newOffset !== offset) {
          setOffset(newOffset);
        }

        const relevantResponses = responses.filter(r =>
          r.action?.startsWith('docker.') ||
          r.action?.startsWith('sandbox.') ||
          r.type?.includes('docker') ||
          r.type?.includes('sandbox')
        );

        if (relevantResponses.length > 0) {
          setEvents(prev => [...prev.slice(-50), ...relevantResponses]);
          setLastUpdate(new Date().toISOString());

          // Update sandbox status from latest response
          const latest = relevantResponses[relevantResponses.length - 1];
          if (latest.sandbox) {
            setSandboxStatus(latest.sandbox);

            // Auto-start streaming when sandbox starts
            if (latest.sandbox.running && latest.sandbox.name && !isStreaming) {
              startStream(latest.sandbox.name);
            }
          }

          // Auto-switch to stream mode for exec results with output
          if (latest.action === 'sandbox.exec' && latest.detail) {
            setStreamLines(prev => {
              const ts = formatTimestamp(latest.endedAt);
              return [...prev, `${ts} [EXEC] ${latest.detail.slice(0, 500)}`].slice(-200);
            });
            setMode('stream');
          }
        }
      } catch {}
    };

    poll();
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [offset, isStreaming]);

  // Check for running containers periodically
  useEffect(() => {
    const check = () => {
      const container = getWorkbenchContainer();
      if (container && !isStreaming && mode === 'events') {
        // Found a container, offer to stream
        setSandboxStatus(prev => ({ ...prev, running: true, name: container }));
      } else if (!container && sandboxStatus.running) {
        setSandboxStatus({ running: false, name: null });
        stopStream();
      }
    };

    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [isStreaming, mode, sandboxStatus.running]);

  // Keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      stopStream();
      process.exit(0);
    }
    if (input === 'q') {
      stopStream();
      process.exit(0);
    }
    // Toggle between modes
    if (input === 't') {
      setMode(prev => prev === 'events' ? 'stream' : 'events');
    }
    // Start streaming from detected container
    if (input === 's' && sandboxStatus.name && !isStreaming) {
      startStream(sandboxStatus.name);
    }
    // Stop streaming
    if (input === 'x' && isStreaming) {
      stopStream();
    }
  });

  const availableHeight = Math.max(5, rows - 4);
  const maxLines = Math.max(1, availableHeight - 3);

  // Compute display content based on mode
  const displayContent = useMemo(() => {
    if (mode === 'stream') {
      return streamLines.slice(-maxLines);
    }
    return events.slice(-maxLines);
  }, [mode, events, streamLines, maxLines]);

  return (
    <Box flexDirection="column" height={availableHeight} width={cols}>
      {/* Header */}
      <Box borderStyle="round" borderColor="blue" paddingX={1}>
        <Text bold color="blue">DOCKER</Text>
        <Text dimColor> | </Text>
        <Text color={mode === 'stream' ? 'cyan' : 'gray'}>
          {mode === 'stream' ? 'STREAM' : 'EVENTS'}
        </Text>
        <Text dimColor> | </Text>
        <Text color={sandboxStatus.running ? 'green' : 'gray'}>
          {sandboxStatus.running ? `${sandboxStatus.name || 'running'}` : 'no container'}
        </Text>
        {isStreaming && (
          <>
            <Text dimColor> | </Text>
            <Text color="yellow">LIVE</Text>
          </>
        )}
        {lastUpdate && (
          <>
            <Text dimColor> | </Text>
            <Text dimColor>{formatTimestamp(lastUpdate)}</Text>
          </>
        )}
      </Box>

      {/* Content area */}
      <Box flexDirection="column" flexGrow={1} marginTop={1} paddingX={1}>
        {mode === 'stream' ? (
          // Stream mode - show live output
          displayContent.length === 0 ? (
            <Text dimColor>Waiting for container output...</Text>
          ) : (
            displayContent.map((line, i) => (
              <Box key={`stream-${i}`} marginBottom={0}>
                <Text color={line.includes('[ERR]') ? 'red' : line.includes('---') ? 'cyan' : undefined}>
                  {String(line).slice(0, cols - 4)}
                </Text>
              </Box>
            ))
          )
        ) : (
          // Events mode - show Docker/Sandbox events
          displayContent.length === 0 ? (
            <Box flexDirection="column">
              <Text dimColor>Waiting for Docker/Sandbox events...</Text>
              {sandboxStatus.name && (
                <Text color="cyan">Press 's' to stream from {sandboxStatus.name}</Text>
              )}
            </Box>
          ) : (
            displayContent.map((r, i) => (
              <Box key={`event-${i}-${r.correlationId || ''}-${r.endedAt || ''}`} marginBottom={0}>
                <Text color={r.ok ? 'green' : 'red'}>
                  {r.ok ? '+' : 'x'}
                </Text>
                <Text> </Text>
                <Text dimColor>{formatTimestamp(r.endedAt)}</Text>
                <Text> </Text>
                <Text color="cyan">{r.action || r.type}</Text>
                <Text dimColor> - </Text>
                <Text>{(r.summary || 'completed').slice(0, cols - 40)}</Text>
              </Box>
            ))
          )
        )}
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text dimColor>q:quit t:toggle</Text>
        {sandboxStatus.name && !isStreaming && (
          <Text dimColor> s:stream</Text>
        )}
        {isStreaming && (
          <Text dimColor> x:stop</Text>
        )}
      </Box>
    </Box>
  );
}

if (useRawMode) {
  runRawPane();
} else {
  render(<DockerPane />);
}
