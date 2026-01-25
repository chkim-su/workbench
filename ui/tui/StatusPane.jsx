#!/usr/bin/env bun
/**
 * Status Pane - Shows live OAuth and system status
 * Designed to run in a tmux side pane
 */

import React, { useState, useEffect, memo } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fetchAllUsage, formatResetTime } from './usageFetcher.js';
import { fetchTmuxStatus } from './tmuxStatus.js';

// Reduced polling frequency to prevent flicker during user interaction
// Polling causes re-renders which conflict with user input handling
const POLL_INTERVAL_MS = 5000; // Was 1000 - too aggressive
const EMBEDDED_POLL_INTERVAL_MS = 10000; // Was 3000 - embedded needs less frequent updates
const USAGE_REFRESH_MS = 15000;

function formatTimeRemaining(ms) {
  if (ms <= 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function extractTokenInfo(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return {
      email: payload['https://api.openai.com/profile']?.email || payload.email || null,
      plan: payload['https://api.openai.com/auth']?.chatgpt_plan_type || null,
      exp: payload.exp ? payload.exp * 1000 : null, // Convert to ms
    };
  } catch {
    return null;
  }
}

function formatTimeUntil(ms) {
  if (!ms) return null;
  const now = Date.now();
  const diff = ms - now;
  if (diff <= 0) return 'expired';

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getProfileStatus(profile) {
  const now = Date.now();
  if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > now) {
    const remaining = profile.rateLimitedUntilMs - now;
    return { status: 'limited', color: 'yellow', icon: '!', text: `Rate limited (${formatTimeRemaining(remaining)})` };
  }
  if (profile.disabled || profile.enabled === false) {
    return { status: 'disabled', color: 'gray', icon: '-', text: 'Disabled' };
  }
  if (profile.expiresAtMs && profile.expiresAtMs < now) {
    return { status: 'expired', color: 'red', icon: 'x', text: 'Expired' };
  }
  return { status: 'ready', color: 'green', icon: '●', text: 'Ready' };
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function UsageBar({ percentage, width = 10 }) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const color = percentage >= 90 ? 'red' : percentage >= 75 ? 'yellow' : 'green';

  return (
    <Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text color={color}> {percentage}%</Text>
    </Text>
  );
}

// Memoized to prevent re-renders when unrelated state changes (reduces flicker)
const OAuthSection = memo(function OAuthSection({ oauthPool, usageData, maxProfiles = 5 }) {
  if (!oauthPool || !oauthPool.profiles) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">OAuth Profiles</Text>
        <Text dimColor>  Not configured</Text>
      </Box>
    );
  }

  const profiles = Object.entries(oauthPool.profiles || {});
  const readyCount = profiles.filter(([, p]) => getProfileStatus(p).status === 'ready').length;
  const limitedCount = profiles.filter(([, p]) => getProfileStatus(p).status === 'limited').length;
  const lastUsed = oauthPool.selection?.lastUsedProfile;
  const pinned = oauthPool.selection?.pinnedProfile;
  const strategy = oauthPool.selection?.strategy || 'round-robin';
  const visibleProfiles = profiles.slice(0, maxProfiles);
  const hiddenCount = profiles.length - visibleProfiles.length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">OAuth </Text>
        <Text color="green">{readyCount}</Text>
        <Text dimColor>/{profiles.length}</Text>
        {limitedCount > 0 && <Text color="yellow"> ({limitedCount} limited)</Text>}
        <Text dimColor> [{strategy}]</Text>
      </Box>

      {/* Profile list */}
      {visibleProfiles.map(([name, profile]) => {
        const status = getProfileStatus(profile);
        const tokenInfo = extractTokenInfo(profile.accessToken || profile.idToken);
        const isLastUsed = name === lastUsed;
        const isPinned = name === pinned;
        const usage = usageData?.get?.(name);

        // Find 5h and weekly usage windows
        const usage5h = usage?.windows?.find((w) => w.type === '5h' || w.type === 'hourly');
        const usageWeekly = usage?.windows?.find((w) => w.type === 'weekly' || w.type === 'week');

        return (
          <Box key={name} flexDirection="column" paddingLeft={1} marginBottom={1}>
            {/* Name + status line */}
            <Box>
              <Text color={status.color}>{status.icon} </Text>
              <Text bold={status.status === 'ready'}>{name}</Text>
              {isLastUsed && <Text color="yellow"> ★</Text>}
              {isPinned && <Text color="magenta"> 📌</Text>}
              {tokenInfo?.plan && <Text color="blue"> [{tokenInfo.plan}]</Text>}
            </Box>

            {/* Details */}
            <Box paddingLeft={2} flexDirection="column">
              {/* Email */}
              {tokenInfo?.email && (
                <Text dimColor>{tokenInfo.email}</Text>
              )}

              {/* Usage bars */}
              {usage && (
                <Box flexDirection="column" marginTop={1}>
                  {usage5h && (
                    <Box>
                      <Text dimColor>5h:  </Text>
                      <UsageBar percentage={usage5h.percentage || 0} width={8} />
                      {usage5h.resetAtMs && (
                        <Text dimColor> reset: {formatResetTime(usage5h.resetAtMs)}</Text>
                      )}
                    </Box>
                  )}
                  {usageWeekly && (
                    <Box>
                      <Text dimColor>week:</Text>
                      <UsageBar percentage={usageWeekly.percentage || 0} width={8} />
                      {usageWeekly.resetAtMs && (
                        <Text dimColor> reset: {formatResetTime(usageWeekly.resetAtMs)}</Text>
                      )}
                    </Box>
                  )}
                </Box>
              )}

              {/* Status details when no usage data */}
              {!usage && (
                <Box gap={1}>
                  {status.status === 'ready' && (
                    <Text dimColor>usage: fetching...</Text>
                  )}
                  {status.status === 'limited' && (
                    <Text color="yellow">rate limited: {status.text.match(/\(([^)]+)\)/)?.[1] || '?'}</Text>
                  )}
                  {status.status === 'expired' && (
                    <Text color="red">token expired - sync required</Text>
                  )}
                  {status.status === 'disabled' && (
                    <Text color="gray">disabled</Text>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        );
      })}
      {hiddenCount > 0 && (
        <Text dimColor paddingLeft={1}>  +{hiddenCount} more profiles</Text>
      )}
    </Box>
  );
});

// Memoized to prevent re-renders when unrelated state changes (reduces flicker)
const VerifySection = memo(function VerifySection({ verifyGates, runId, maxGates = 8 }) {
  if (!verifyGates || verifyGates.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Verify Status</Text>
        <Text dimColor>  No results</Text>
      </Box>
    );
  }

  const passed = verifyGates.filter(g => g.ok && !g.skipped).length;
  const failed = verifyGates.filter(g => !g.ok && !g.skipped).length;
  const skipped = verifyGates.filter(g => g.skipped).length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Verify </Text>
        <Text color="green">{passed}</Text>
        <Text dimColor>/</Text>
        <Text>{verifyGates.length}</Text>
        {failed > 0 && <Text color="red"> ({failed} failed)</Text>}
      </Box>
      {verifyGates.slice(0, maxGates).map((gate, i) => (
        <Box key={i} paddingLeft={1}>
          <Text color={gate.skipped ? 'yellow' : gate.ok ? 'green' : 'red'}>
            {gate.skipped ? '○' : gate.ok ? '✓' : '✗'}
          </Text>
          <Text dimColor={gate.skipped}> {gate.name}</Text>
        </Box>
      ))}
      {verifyGates.length > maxGates && (
        <Text dimColor paddingLeft={1}>  +{verifyGates.length - maxGates} more</Text>
      )}
    </Box>
  );
});

// Memoized to prevent re-renders when unrelated state changes (reduces flicker)
const RunnerSection = memo(function RunnerSection({ runnerStatus }) {
  if (!runnerStatus) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Runner</Text>
        <Text dimColor>  Idle</Text>
      </Box>
    );
  }

  const providerLabel = (() => {
    const p = runnerStatus.provider;
    if (!p) return 'unknown';
    if (typeof p === 'string') return p;
    if (typeof p === 'object') {
      // runner summary uses provider as a structured object:
      // {mode, baseUrl, model, sendAuth, authReason}
      const mode = p.mode || 'unknown';
      const model = p.model ? `:${p.model}` : '';
      return `${mode}${model}`;
    }
    return String(p);
  })();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">Runner</Text>
      <Box paddingLeft={1}>
        <Text>Provider: </Text>
        <Text color="green">{providerLabel}</Text>
      </Box>
      {runnerStatus.toolCallsSeen && (
        <Box paddingLeft={1}>
          <Text>Tool calls: </Text>
          <Text color="cyan">{runnerStatus.toolCallsSeen.length}</Text>
        </Box>
      )}
      {runnerStatus.error && (
        <Box paddingLeft={1}>
          <Text color="red">Error: {runnerStatus.error}</Text>
        </Box>
      )}
    </Box>
  );
});

const TmuxSection = memo(function TmuxSection({ tmuxStatus }) {
  const { installed, sessionExists, sessions, panes, error } = tmuxStatus;
  const sessionLabel = sessions.length > 0 ? sessions.join(', ') : 'none';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">tmux</Text>
        <Text dimColor> | {installed ? 'available' : 'missing'}</Text>
      </Box>
      {!installed ? (
        <Text color="yellow">tmux not found. Install tmux to launch Claude Code.</Text>
      ) : !sessionExists ? (
        <Box paddingLeft={1} flexDirection="column">
          <Text dimColor>Session 'workbench' is not running.</Text>
          <Text dimColor>Run `workbench` or `tmux new-session -s workbench` to initialize.</Text>
        </Box>
      ) : (
        <Box paddingLeft={1} flexDirection="column">
          <Text dimColor>Keys: F1 control · F2 ui · F6 next pane · F7 last pane</Text>
          <Text dimColor>Mouse: click pane to focus · drag divider to resize</Text>
          <Text dimColor>Sessions: {sessionLabel}</Text>
          {panes.slice(0, 4).map((pane) => (
            <Box key={`${pane.sessionName}:${pane.windowName}:${pane.windowIndex}.${pane.paneIndex}`}>
              <Text color={pane.active ? 'green' : undefined}>
                {pane.sessionName}:{pane.windowName} {pane.command || 'shell'}
              </Text>
              {pane.title && pane.title !== pane.command && (
                <Text dimColor> ({pane.title})</Text>
              )}
            </Box>
          ))}
          {panes.length > 4 && (
            <Text dimColor>+{panes.length - 4} more panes</Text>
          )}
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text dimColor>{error}</Text>
        </Box>
      )}
    </Box>
  );
});

export default function StatusPane({ embedded = false } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const rows = stdout?.rows || 24;

  // Minimum size thresholds to prevent layout instability (flicker)
  const MIN_COLS = 30;
  const MIN_ROWS = 10;
  const isTooSmall = cols < MIN_COLS || rows < MIN_ROWS;

  // Calculate available height for content (account for padding, borders, header)
  // This prevents content overflow which causes terminal scrolling and top clipping
  const availableRows = Math.max(MIN_ROWS, rows - 2); // Reserve 2 for padding

  const pollIntervalMs = embedded ? EMBEDDED_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
  const [state, setState] = useState({
    oauthPool: null,
    usageData: new Map(), // profile name -> usage data
    verifyGates: [],
    verifyRunId: null,
    runnerStatus: null,
    lastUpdate: null,
  });
  const [tmuxStatus, setTmuxStatus] = useState({
    installed: false,
    sessionExists: false,
    sessions: [],
    panes: [],
    error: null,
  });

  const stateDir = process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench');
  const tmuxSessionName = process.env.WORKBENCH_TMUX_SESSION || 'workbench';
  const tmuxServerName = process.env.WORKBENCH_TMUX_SERVER || 'workbench';

  useEffect(() => {
    let lastUsageFetchAt = 0;
    const poll = () => {
      // Read OAuth pool
      const poolPath = join(stateDir, 'auth', 'openai_codex_oauth_pool.json');
      const oauthPool = safeReadJson(poolPath);

      // Read current pointer
      const currentPath = join(stateDir, 'state', 'current.json');
      const current = safeReadJson(currentPath);

      // Read verify gates
      let verifyGates = [];
      let verifyRunId = current?.verifyRunId;
      if (verifyRunId) {
        const summaryPath = join(stateDir, 'verify', 'gates', verifyRunId, 'summary.json');
        const summary = safeReadJson(summaryPath);
        verifyGates = summary?.gates || [];
      } else {
        // Fallback: find latest
        const gatesDir = join(stateDir, 'verify', 'gates');
        if (existsSync(gatesDir)) {
          const entries = readdirSync(gatesDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => join(gatesDir, d.name));
          if (entries.length) {
            entries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
            const summaryPath = join(entries[0], 'summary.json');
            const summary = safeReadJson(summaryPath);
            verifyGates = summary?.gates || [];
            verifyRunId = entries[0].split('/').pop();
          }
        }
      }

      // Read runner status
      let runnerStatus = null;
      const runnerRunId = current?.runnerRunId;
      if (runnerRunId) {
        const runnerPath = join(stateDir, 'runs', runnerRunId, 'summary.json');
        runnerStatus = safeReadJson(runnerPath);
      }

      // Fetch usage data for all profiles (async, throttled)
      const now = Date.now();
      if (oauthPool && oauthPool.profiles && now - lastUsageFetchAt > USAGE_REFRESH_MS) {
        lastUsageFetchAt = now;
        fetchAllUsage(oauthPool, stateDir).then((data) => {
          // Flicker prevention: only update if usage data actually changed
          setState((s) => {
            const oldKeys = Array.from(s.usageData.keys()).sort().join(',');
            const newKeys = Array.from(data.keys()).sort().join(',');
            if (oldKeys === newKeys) {
              // Check if any values changed
              let changed = false;
              for (const [k, v] of data) {
                if (JSON.stringify(s.usageData.get(k)) !== JSON.stringify(v)) {
                  changed = true;
                  break;
                }
              }
              if (!changed) return s;
            }
            return { ...s, usageData: data };
          });
        }).catch(() => {});
      }

      // Flicker prevention: only update state if data actually changed
      setState((s) => {
        const oauthChanged = JSON.stringify(s.oauthPool) !== JSON.stringify(oauthPool);
        const verifyChanged = JSON.stringify(s.verifyGates) !== JSON.stringify(verifyGates);
        const runnerChanged = JSON.stringify(s.runnerStatus) !== JSON.stringify(runnerStatus);
        const newLastUpdate = embedded ? s.lastUpdate : new Date().toLocaleTimeString();

        // Skip update if nothing changed (prevents unnecessary re-renders)
        if (!oauthChanged && !verifyChanged && !runnerChanged && s.lastUpdate === newLastUpdate) {
          return s;
        }

        return {
          ...s,
          oauthPool: oauthChanged ? oauthPool : s.oauthPool,
          verifyGates: verifyChanged ? verifyGates : s.verifyGates,
          verifyRunId,
          runnerStatus: runnerChanged ? runnerStatus : s.runnerStatus,
          lastUpdate: newLastUpdate,
        };
      });
    };

    poll();
    const interval = setInterval(poll, pollIntervalMs);
    return () => clearInterval(interval);
  }, [stateDir, embedded, pollIntervalMs]);

  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      try {
        const status = await fetchTmuxStatus(tmuxSessionName, tmuxServerName);
        if (!mounted) return;
        setTmuxStatus((prev) => {
          const prevJson = JSON.stringify(prev);
          const nextJson = JSON.stringify(status);
          if (prevJson === nextJson) {
            return prev;
          }
          return status;
        });
      } catch {
        // already handled by fetchTmuxStatus
      }
    };

    tick();
    const interval = setInterval(tick, pollIntervalMs);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  // Handle SIGINT for graceful exit (no useInput to avoid raw mode issues).
  // When embedded inside another surface (e.g. chat layout), let the parent control shutdown.
  useEffect(() => {
    if (embedded) return;
    const handleSigint = () => {
      exit();
    };
    process.on('SIGINT', handleSigint);
    return () => process.off('SIGINT', handleSigint);
  }, [exit, embedded]);

  // Show minimal UI when window is too small (prevents flicker from layout overflow)
  if (isTooSmall) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">Too small</Text>
        <Text dimColor>{cols}x{rows}</Text>
      </Box>
    );
  }

  // Calculate how many profiles/items to show based on available space
  // Rough estimate: header=4, tmux=6, verify=4, runner=3, footer=2
  const baseOverhead = embedded ? 15 : 18;
  const profileSpace = Math.max(1, availableRows - baseOverhead);
  const maxProfiles = Math.min(5, Math.max(1, Math.floor(profileSpace / 3)));
  const maxVerifyGates = Math.min(6, Math.max(2, availableRows - baseOverhead - maxProfiles * 3));

  return (
    <Box flexDirection="column" padding={1} height={availableRows}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        marginBottom={1}
      >
        <Text bold color="cyan">STATUS</Text>
        {!embedded && <Text dimColor> | Updated: {state.lastUpdate || '...'}</Text>}
      </Box>

      <OAuthSection oauthPool={state.oauthPool} usageData={state.usageData} maxProfiles={maxProfiles} />
      <TmuxSection tmuxStatus={tmuxStatus} />
      <VerifySection verifyGates={state.verifyGates} runId={state.verifyRunId} maxGates={maxVerifyGates} />
      <RunnerSection runnerStatus={state.runnerStatus} />

      {!embedded && (
        <Box marginTop={1}>
          <Text dimColor>Auto-refreshing every {pollIntervalMs / 1000}s</Text>
        </Box>
      )}
    </Box>
  );
}
