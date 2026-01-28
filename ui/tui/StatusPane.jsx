#!/usr/bin/env bun
/**
 * Status Pane - Shows live OAuth and system status
 * Designed to run in a tmux side pane
 */

import React, { useState, useEffect, useRef, memo } from 'react';
import { Box, Text, useApp, useStdout, useInput } from 'ink';
import { join, resolve } from 'node:path';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { fetchAllUsage, formatResetTime } from './usageFetcher.js';
import { fetchTmuxStatus } from './tmuxStatus.js';
import { fetchAllClaudeUsage, formatTokens, formatCost } from './claudeUsageFetcher.js';
import {
  formatTimeRemaining,
  extractTokenInfo,
  getProfileStatus,
  safeReadJson,
} from './utils/index.js';

// 1s polling for responsive timer updates and account switch detection
const POLL_INTERVAL_MS = 1000;
const EMBEDDED_POLL_INTERVAL_MS = 1000;
const USAGE_REFRESH_MS = 15000;

function shouldEnableMouse() {
  const raw = (process.env.WORKBENCH_STATUS_MOUSE ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function enableMouseTracking(stdout) {
  if (!stdout?.write) return;
  // Enable xterm mouse tracking + SGR (1006) so clicks are reported as CSI <b;x;yM.
  stdout.write('\x1b[?1000h\x1b[?1006h');
}

function disableMouseTracking(stdout) {
  if (!stdout?.write) return;
  stdout.write('\x1b[?1000l\x1b[?1006l');
}

function parseSgrMouse(input) {
  // Example: \x1b[<0;34;12M (left press at col 34, row 12)
  //          \x1b[<0;34;12m (left release)
  if (typeof input !== 'string') return null;
  const m = /^\u001b\[<(\d+);(\d+);(\d+)([mM])$/.exec(input);
  if (!m) return null;
  const b = Number(m[1]);
  const col = Number(m[2]);
  const row = Number(m[3]);
  const kind = m[4] === 'M' ? 'press' : 'release';
  if (!Number.isFinite(b) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
  return { b, col, row, kind };
}

function getAbsoluteRect(node) {
  if (!node?.yogaNode) return null;
  let x = 0;
  let y = 0;
  let cur = node;
  while (cur) {
    if (cur.yogaNode) {
      x += cur.yogaNode.getComputedLeft();
      y += cur.yogaNode.getComputedTop();
    }
    cur = cur.parentNode;
  }
  const width = node.yogaNode.getComputedWidth();
  const height = node.yogaNode.getComputedHeight();
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { x, y, width, height };
}

function pointInRect(col0, row0, rect) {
  if (!rect) return false;
  return (
    col0 >= rect.x &&
    col0 < rect.x + rect.width &&
    row0 >= rect.y &&
    row0 < rect.y + rect.height
  );
}

// getProfileStatus returns 'rate_limited' - normalize to 'limited' for legacy compatibility
// in component code where needed

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
// _tick prop breaks memoization to force countdown updates every second
const OAuthSection = memo(function OAuthSection({ oauthPool, usageData, maxProfiles = 5, _tick }) {
  if (!oauthPool || !oauthPool.profiles) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="yellow">Codex</Text>
        <Text dimColor paddingLeft={1}>OAuth not configured</Text>
      </Box>
    );
  }

  const profiles = Object.entries(oauthPool.profiles || {});
  const readyCount = profiles.filter(([, p]) => getProfileStatus(p).status === 'ready').length;
  const limitedCount = profiles.filter(([, p]) => getProfileStatus(p).status === 'rate_limited').length;
  const lastUsed = oauthPool.selection?.lastUsedProfile;
  const pinned = oauthPool.selection?.pinnedProfile;
  const strategy = oauthPool.selection?.strategy || 'round-robin';
  const visibleProfiles = profiles.slice(0, maxProfiles);
  const hiddenCount = profiles.length - visibleProfiles.length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="yellow">Codex </Text>
        <Text color="green">{readyCount}</Text>
        <Text dimColor>/{profiles.length} accounts</Text>
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
              <Text color={status.color}>
                {status.icon}{' '}
              </Text>
              <Text bold={status.status === 'ready'} color={isLastUsed ? 'green' : undefined}>
                {name}
              </Text>
              {isLastUsed && <Text color="green"> ★ [active]</Text>}
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
                  {status.status === 'rate_limited' && (
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

function readPositiveNumberEnv(name) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clampPercent(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Claude Code Usage Section - render daily/weekly limits like Codex
const ClaudeUsageSection = memo(function ClaudeUsageSection({ claudeUsage, maxProjects = 2 }) {
  if (!claudeUsage || !claudeUsage.available) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="magenta">Claude</Text>
        <Text dimColor paddingLeft={1}>Not installed</Text>
      </Box>
    );
  }

  if (claudeUsage.error) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="magenta">Claude</Text>
        <Text dimColor paddingLeft={1}>{claudeUsage.error}</Text>
      </Box>
    );
  }

  const { windows, projects, activeProjects, source } = claudeUsage;
  const daily = (windows || []).find((w) => w.type === 'daily');
  const weekly = (windows || []).find((w) => w.type === 'weekly');

  // Defaults preserve previous behavior (dailyBudget=5) while allowing explicit overrides.
  const dailyUsdLimit = readPositiveNumberEnv('WORKBENCH_CLAUDE_DAILY_USD_LIMIT') ?? 5;
  const weeklyUsdLimit = readPositiveNumberEnv('WORKBENCH_CLAUDE_WEEKLY_USD_LIMIT') ?? (dailyUsdLimit * 7);

  const dailyCost = daily?.costUsd || 0;
  const weeklyCost = weekly?.costUsd || 0;

  const dailyPct = clampPercent((dailyCost / dailyUsdLimit) * 100);
  const weeklyPct = clampPercent((weeklyCost / weeklyUsdLimit) * 100);

  // Extract short project name from hash (e.g., "-home-user-projects-foo" -> "foo")
  const getShortName = (hash) => {
    if (!hash) return 'unknown';
    const parts = hash.split('-').filter(Boolean);
    return parts[parts.length - 1] || hash.slice(0, 12);
  };

  const visibleProjects = (projects || []).slice(0, maxProjects);
  const hiddenCount = (projects?.length || 0) - visibleProjects.length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="magenta">Claude </Text>
        <Text color="green">{activeProjects || 0}</Text>
        <Text dimColor> project{activeProjects !== 1 ? 's' : ''}</Text>
        {source && <Text dimColor> [{source}]</Text>}
      </Box>

      {/* Daily/Weekly usage bars (Codex-style) */}
      <Box paddingLeft={1} flexDirection="column">
        <Box>
          <Text dimColor>day: </Text>
          <UsageBar percentage={dailyPct} width={8} />
          <Text dimColor> {formatCost(dailyCost)} / ${dailyUsdLimit}</Text>
          {daily?.resetAtMs && <Text dimColor> reset: {formatResetTime(daily.resetAtMs)}</Text>}
        </Box>
        <Box>
          <Text dimColor>week:</Text>
          <UsageBar percentage={weeklyPct} width={8} />
          <Text dimColor> {formatCost(weeklyCost)} / ${weeklyUsdLimit}</Text>
          {weekly?.resetAtMs && <Text dimColor> reset: {formatResetTime(weekly.resetAtMs)}</Text>}
        </Box>
        {(daily?.totalTokens || weekly?.totalTokens) ? (
          <Box>
            <Text dimColor>      </Text>
            <Text dimColor>tokens </Text>
            <Text color="cyan">{formatTokens(daily?.totalTokens || 0)}</Text>
            <Text dimColor> day · </Text>
            <Text color="cyan">{formatTokens(weekly?.totalTokens || 0)}</Text>
            <Text dimColor> week</Text>
          </Box>
        ) : null}
      </Box>

      {/* Optional: show top recent projects (compact) */}
      {visibleProjects.length > 0 && (
        <Box paddingLeft={1} marginTop={1} flexDirection="column">
          <Text dimColor>Recent projects (24h):</Text>
          {visibleProjects.map((project) => {
            const shortName = getShortName(project.projectHash);
            const isCurrentProject = project.projectHash?.includes('myLLMworkbench');
            return (
              <Box key={project.projectHash} paddingLeft={1}>
                <Text dimColor>• </Text>
                <Text bold={isCurrentProject} color={isCurrentProject ? 'green' : undefined}>
                  {shortName}
                </Text>
                <Text dimColor> </Text>
                <Text color="cyan">{formatTokens(project.totalTokens || 0)}</Text>
                <Text dimColor> tok</Text>
              </Box>
            );
          })}
          {hiddenCount > 0 && (
            <Text dimColor paddingLeft={1}>+{hiddenCount} more</Text>
          )}
        </Box>
      )}

      {(!projects || projects.length === 0) && !(daily?.totalTokens || dailyCost || weekly?.totalTokens || weeklyCost) && (
        <Text dimColor paddingLeft={1}>No usage yet</Text>
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

// MCP Detail View - shows MCP servers + tool list from registry
const MCPDetailView = memo(function MCPDetailView({ mcpStatus, onBack, backRef }) {
  const servers = mcpStatus?.servers || [];

  return (
    <Box flexDirection="column" padding={1}>
      <Box ref={backRef} borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">MCP Servers</Text>
        <Text dimColor> | </Text>
        <Text color="blue">[b] back</Text>
      </Box>

      {servers.length === 0 ? (
        <Text dimColor>No MCP servers configured</Text>
      ) : (
        servers.map((server, i) => (
          <Box key={server.name} flexDirection="column" paddingLeft={1} marginBottom={1}>
            <Box>
              <Text color={server.connected ? 'green' : 'red'}>
                {server.connected ? '●' : '○'}{' '}
              </Text>
              <Text bold>{server.name}</Text>
              <Text dimColor> ({server.transport})</Text>
            </Box>
            {!server.connected ? (
              <Box paddingLeft={2}>
                <Text color="red">{server.lastError || 'Not connected'}</Text>
              </Box>
            ) : server.tools && server.tools.length > 0 ? (
              <Box paddingLeft={2} flexDirection="column">
                <Text dimColor>Tools ({server.tools.length}):</Text>
                {server.tools.map((tool) => (
                  <Text key={tool} dimColor>
                    {'  '}• {tool}
                  </Text>
                ))}
              </Box>
            ) : (
              <Box paddingLeft={2}>
                <Text dimColor>Tools: 0</Text>
              </Box>
            )}
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text dimColor>Press </Text>
        <Text color="blue">b</Text>
        <Text dimColor> or </Text>
        <Text color="blue">Escape</Text>
        <Text dimColor> to go back</Text>
      </Box>
    </Box>
  );
});

// MCP and Executor Status Section
const SystemSection = memo(function SystemSection({ mcpStatus, executorStatus, sessionInfo, systemLastResult, mcpRef }) {
  const mcpConnected = mcpStatus?.connected || 0;
  const mcpTotal = mcpStatus?.total || 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">System</Text>

      {/* Session Info */}
      {sessionInfo && (
        <Box paddingLeft={1} flexDirection="column">
          <Box>
            <Text dimColor>Mode: </Text>
            <Text color="green">{sessionInfo.mode || 'B'}</Text>
            <Text dimColor> │ Runtime: </Text>
            <Text>{sessionInfo.runtime || 'codex-cli'}</Text>
          </Box>
          <Box>
            <Text dimColor>Model: </Text>
            <Text>{sessionInfo.model || 'gpt-5.2'}</Text>
          </Box>
        </Box>
      )}

      {/* MCP Status - clickable */}
      <Box ref={mcpRef} paddingLeft={1}>
        <Text dimColor>MCP: </Text>
        <Text color={mcpConnected > 0 ? 'green' : 'yellow'}>{mcpConnected}</Text>
        <Text dimColor>/{mcpTotal} connected</Text>
        <Text color="blue"> [m]</Text>
      </Box>

      {/* Executor Status */}
      <Box paddingLeft={1} flexDirection="column">
        <Box>
          <Text dimColor>Executors: </Text>
          <Text color={executorStatus?.system ? 'green' : 'red'}>
            {executorStatus?.system ? '✓' : '✗'}
          </Text>
          <Text dimColor> sys </Text>
          <Text color={executorStatus?.codex ? 'green' : 'red'}>
            {executorStatus?.codex ? '✓' : '✗'}
          </Text>
          <Text dimColor> codex </Text>
          <Text color={executorStatus?.opencode ? 'green' : 'red'}>
            {executorStatus?.opencode ? '✓' : '✗'}
          </Text>
          <Text dimColor> opencode</Text>
        </Box>
      </Box>

      {/* Last system action result */}
      {systemLastResult && (
        <Box paddingLeft={1} flexDirection="column">
          <Box>
            <Text dimColor>Last: </Text>
            <Text>{String(systemLastResult.action || '').slice(0, 18)}</Text>
            <Text dimColor> </Text>
            <Text color={systemLastResult.ok ? 'green' : 'red'}>
              {systemLastResult.ok ? '✓' : '✗'}
            </Text>
            <Text dimColor> </Text>
            <Text dimColor>{String(systemLastResult.summary || '').slice(0, 40)}</Text>
          </Box>
          {systemLastResult.detail ? (
            <Text dimColor>{String(systemLastResult.detail).replaceAll(/\s+/g, ' ').slice(0, 80)}</Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
});

// Alerts Section
const AlertsSection = memo(function AlertsSection({ alerts, maxAlerts = 5 }) {
  if (!alerts || alerts.length === 0) {
    return null;
  }

  const recentAlerts = alerts.slice(-maxAlerts);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">Alerts</Text>
      {recentAlerts.map((alert, i) => {
        const color = alert.severity === 'error' || alert.severity === 'critical'
          ? 'red'
          : alert.severity === 'warn'
            ? 'yellow'
            : 'gray';
        const icon = alert.severity === 'error' || alert.severity === 'critical'
          ? '✗'
          : alert.severity === 'warn'
            ? '!'
            : '·';
        return (
          <Box key={i} paddingLeft={1}>
            <Text color={color}>{icon} </Text>
            <Text color={color}>{alert.message}</Text>
          </Box>
        );
      })}
    </Box>
  );
});

const TmuxSection = memo(function TmuxSection({ tmuxStatus }) {
  const { installed, sessionExists, sessions, panes, paneSlots, emptySlots, error } = tmuxStatus;
  const sessionLabel = sessions.length > 0 ? sessions.join(', ') : 'none';
  const SLOT_NAMES = ['main', 'docker', 'status', 'command'];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">tmux</Text>
        <Text dimColor> | {installed ? 'available' : 'missing'}</Text>
        {sessionExists && emptySlots && emptySlots.length > 0 && (
          <Text color="yellow"> ({emptySlots.length} empty)</Text>
        )}
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
          <Text dimColor>Keys: F1 control · F2 ui · F3 workbench · F6 next pane · F7 last pane</Text>
          <Text dimColor>Mouse: click pane to focus · drag divider to resize</Text>
          <Text dimColor>Sessions: {sessionLabel}</Text>
          {/* Show pane slots with null for empty slots */}
          {paneSlots && paneSlots.map((slot, idx) => (
            <Box key={`slot-${idx}`}>
              <Text color={slot === null ? 'gray' : slot.active ? 'green' : undefined}>
                [{idx}] {SLOT_NAMES[idx]}: {slot === null ? '(empty)' : `${slot.command || 'shell'}`}
              </Text>
              {slot && slot.title && slot.title !== slot.command && (
                <Text dimColor> ({slot.title})</Text>
              )}
              {slot && slot.role && slot.role !== SLOT_NAMES[idx] && (
                <Text color="yellow"> role={slot.role}</Text>
              )}
            </Box>
          ))}
          {/* Show extra panes beyond the 4 slots */}
          {panes && panes.length > 4 && (
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
  const mouseEnabled = shouldEnableMouse();

  // Minimum size thresholds to prevent layout instability (flicker)
  const MIN_COLS = 30;
  const MIN_ROWS = 10;
  const isTooSmall = cols < MIN_COLS || rows < MIN_ROWS;

  // Calculate available height for content (account for padding, borders, header)
  // This prevents content overflow which causes terminal scrolling and top clipping
  const availableRows = Math.max(MIN_ROWS, rows - 2); // Reserve 2 for padding

  const pollIntervalMs = embedded ? EMBEDDED_POLL_INTERVAL_MS : POLL_INTERVAL_MS;

  // Countdown tick state - forces OAuthSection to re-render every second for live countdown updates
  const [countdownTick, setCountdownTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setCountdownTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const [state, setState] = useState({
    oauthPool: null,
    usageData: new Map(), // profile name -> usage data
    claudeUsage: null, // Claude Code usage data
    verifyGates: [],
    verifyRunId: null,
    runnerStatus: null,
    lastUpdate: null,
    mcpStatus: { connected: 0, total: 0, servers: [] },
    executorStatus: { system: false, codex: false, opencode: false },
    sessionInfo: { mode: 'B', runtime: 'codex-cli', model: 'gpt-5.2' },
    systemLastResult: null,
    alerts: [],
  });

  // Expanded view state: 'main' | 'mcp'
  const [expandedView, setExpandedView] = useState('main');
  const mcpClickRef = useRef(null);
  const mcpBackRef = useRef(null);
  const hitRectsRef = useRef({ mcp: null, back: null });
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
    if (!mouseEnabled) return;
    enableMouseTracking(stdout);
    return () => disableMouseTracking(stdout);
  }, [mouseEnabled, stdout]);

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

      // Read MCP status
      let mcpStatus = { connected: 0, total: 0, servers: [] };
      const mcpPath = join(stateDir, 'registry', 'mcp.json');
      const mcpData = safeReadJson(mcpPath);
      if (mcpData?.servers) {
        const serverEntries = Object.entries(mcpData.servers);
        mcpStatus.total = serverEntries.length;
        mcpStatus.connected = serverEntries.filter(([, s]) => s.lastHandshakeOk).length;
        mcpStatus.servers = serverEntries.map(([name, s]) => ({
          name,
          connected: s.lastHandshakeOk || false,
          transport: s?.manifest?.transport || s.transport || 'unknown',
          tools: Array.isArray(s.tools) ? s.tools : [],
          toolCount: Array.isArray(s.tools) ? s.tools.length : (s.toolCount || 0),
          lastError: s.lastError || null,
        }));
      }

      // Read executor status (check heartbeat file mtime)
      const sessionId = current?.sessionId;
      const executorStatus = { system: false, codex: false, opencode: false };
      const HEARTBEAT_MAX_AGE_MS = 30000;
      const now = Date.now();
      if (sessionId) {
        try {
          const systemHeartbeat = join(stateDir, sessionId, 'system.executor.json');
          if (existsSync(systemHeartbeat)) {
            const stat = statSync(systemHeartbeat);
            executorStatus.system = (now - stat.mtimeMs) < HEARTBEAT_MAX_AGE_MS;
          }
        } catch {}
        try {
          const codexHeartbeat = join(stateDir, sessionId, 'codex.executor.json');
          if (existsSync(codexHeartbeat)) {
            const stat = statSync(codexHeartbeat);
            executorStatus.codex = (now - stat.mtimeMs) < HEARTBEAT_MAX_AGE_MS;
          }
        } catch {}
        try {
          const opencodeHeartbeat = join(stateDir, sessionId, 'opencode.executor.json');
          if (existsSync(opencodeHeartbeat)) {
            const stat = statSync(opencodeHeartbeat);
            executorStatus.opencode = (now - stat.mtimeMs) < HEARTBEAT_MAX_AGE_MS;
          }
        } catch {}
      }

      // Read session info (mode, runtime, model)
      const sessionInfo = {
        mode: current?.mode || 'B',
        runtime: current?.runtime || 'codex-cli',
        model: current?.model || 'gpt-5.2',
      };

      // Read last system result (tail system.responses.jsonl)
      let systemLastResult = null;
      if (sessionId) {
        const sysPath = join(stateDir, sessionId, 'system.responses.jsonl');
        if (existsSync(sysPath)) {
          try {
            const st = statSync(sysPath);
            const maxBytes = 64 * 1024;
            const readBytes = Math.max(0, Math.min(st.size, maxBytes));
            const start = Math.max(0, st.size - readBytes);
            const fd = openSync(sysPath, 'r');
            const buf = Buffer.alloc(readBytes);
            readSync(fd, buf, 0, readBytes, start);
            closeSync(fd);
            const lines = buf
              .toString('utf8')
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const obj = JSON.parse(lines[i]);
                if (obj?.type === 'system.result' && obj?.version === 1) {
                  systemLastResult = obj;
                  break;
                }
              } catch {}
            }
          } catch {}
        }
      }

      // Read recent alerts from session events
      let alerts = [];
      if (sessionId) {
        const eventsPath = join(stateDir, sessionId, 'events.jsonl');
        if (existsSync(eventsPath)) {
          try {
            const content = readFileSync(eventsPath, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean).slice(-50); // last 50 events
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === 'alert' || ev.kind === 'alert') {
                  alerts.push({
                    severity: ev.severity || 'info',
                    message: ev.message || ev.text || '',
                    at: ev.at || ev.timestamp,
                  });
                }
              } catch {}
            }
            alerts = alerts.slice(-5); // keep last 5 alerts
          } catch {}
        }
      }

      // Fetch usage data for all profiles (async, throttled)
      const nowForUsage = Date.now();
      if (oauthPool && oauthPool.profiles && nowForUsage - lastUsageFetchAt > USAGE_REFRESH_MS) {
        lastUsageFetchAt = nowForUsage;
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

        // Fetch Claude Code usage (async, same throttle)
        fetchAllClaudeUsage().then((data) => {
          setState((s) => {
            if (JSON.stringify(s.claudeUsage) === JSON.stringify(data)) return s;
            return { ...s, claudeUsage: data };
          });
        }).catch(() => {});
      }

      // Flicker prevention: only update state if data actually changed
      setState((s) => {
        const oauthChanged = JSON.stringify(s.oauthPool) !== JSON.stringify(oauthPool);
        const verifyChanged = JSON.stringify(s.verifyGates) !== JSON.stringify(verifyGates);
        const runnerChanged = JSON.stringify(s.runnerStatus) !== JSON.stringify(runnerStatus);
        const mcpChanged = JSON.stringify(s.mcpStatus) !== JSON.stringify(mcpStatus);
        const execChanged = JSON.stringify(s.executorStatus) !== JSON.stringify(executorStatus);
        const sessionChanged = JSON.stringify(s.sessionInfo) !== JSON.stringify(sessionInfo);
        const sysChanged = JSON.stringify(s.systemLastResult) !== JSON.stringify(systemLastResult);
        const alertsChanged = JSON.stringify(s.alerts) !== JSON.stringify(alerts);
        const newLastUpdate = embedded ? s.lastUpdate : new Date().toLocaleTimeString();

        // Skip update if nothing changed (prevents unnecessary re-renders)
        if (!oauthChanged && !verifyChanged && !runnerChanged && !mcpChanged &&
            !execChanged && !sessionChanged && !sysChanged && !alertsChanged && s.lastUpdate === newLastUpdate) {
          return s;
        }

        return {
          ...s,
          oauthPool: oauthChanged ? oauthPool : s.oauthPool,
          verifyGates: verifyChanged ? verifyGates : s.verifyGates,
          verifyRunId,
          runnerStatus: runnerChanged ? runnerStatus : s.runnerStatus,
          mcpStatus: mcpChanged ? mcpStatus : s.mcpStatus,
          executorStatus: execChanged ? executorStatus : s.executorStatus,
          sessionInfo: sessionChanged ? sessionInfo : s.sessionInfo,
          systemLastResult: sysChanged ? systemLastResult : s.systemLastResult,
          alerts: alertsChanged ? alerts : s.alerts,
          lastUpdate: newLastUpdate,
        };
      });
    };

    poll();
    const interval = setInterval(poll, pollIntervalMs);
    return () => clearInterval(interval);
  }, [stateDir, embedded, pollIntervalMs]);

  // Update mouse hit rectangles after layout settles.
  useEffect(() => {
    if (!mouseEnabled) return;
    const update = () => {
      hitRectsRef.current = {
        mcp: getAbsoluteRect(mcpClickRef.current),
        back: getAbsoluteRect(mcpBackRef.current),
      };
    };
    const t = setTimeout(update, 0);
    return () => clearTimeout(t);
  }, [mouseEnabled, expandedView, cols, rows, state.mcpStatus]);

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

  // Keyboard navigation for expanded views
  useInput((input, key) => {
    const mouse = parseSgrMouse(input);
    if (mouseEnabled && mouse && mouse.kind === 'press') {
      const col0 = mouse.col - 1;
      const row0 = mouse.row - 1;
      const button = mouse.b & 3; // 0=left,1=middle,2=right,3=release
      if (button === 0) {
        if (expandedView === 'main' && pointInRect(col0, row0, hitRectsRef.current.mcp)) {
          setExpandedView('mcp');
          return;
        }
        if (expandedView === 'mcp' && pointInRect(col0, row0, hitRectsRef.current.back)) {
          setExpandedView('main');
          return;
        }
      }
    }

    if (embedded) return;
    if (expandedView === 'main') {
      // 'm' to open MCP detail view
      if (input === 'm' || input === 'M') {
        setExpandedView('mcp');
      }
    } else {
      // 'b', 'q', or Escape to go back
      if (input === 'b' || input === 'B' || input === 'q' || key.escape) {
        setExpandedView('main');
      }
    }
  }, { isActive: true });

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

  // Show MCP detail view when expanded
  if (expandedView === 'mcp') {
    return (
      <Box flexDirection="column" height={availableRows}>
        <MCPDetailView
          mcpStatus={state.mcpStatus}
          onBack={() => setExpandedView('main')}
          backRef={mcpBackRef}
        />
      </Box>
    );
  }

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

      <SystemSection
        mcpStatus={state.mcpStatus}
        executorStatus={state.executorStatus}
        sessionInfo={state.sessionInfo}
        systemLastResult={state.systemLastResult}
        mcpRef={mcpClickRef}
      />
      <OAuthSection oauthPool={state.oauthPool} usageData={state.usageData} maxProfiles={maxProfiles} _tick={countdownTick} />
      <ClaudeUsageSection claudeUsage={state.claudeUsage} maxProjects={maxProfiles} />
      <AlertsSection alerts={state.alerts} maxAlerts={3} />
      <TmuxSection tmuxStatus={tmuxStatus} />
      <VerifySection verifyGates={state.verifyGates} runId={state.verifyRunId} maxGates={maxVerifyGates} />
      <RunnerSection runnerStatus={state.runnerStatus} />

      {!embedded && (
        <Box marginTop={1}>
          <Text dimColor>Auto-refreshing every {pollIntervalMs / 1000}s | </Text>
          <Text color="blue">[m]</Text>
          <Text dimColor> MCP details</Text>
          {mouseEnabled && <Text dimColor> (or click MCP)</Text>}
        </Box>
      )}
    </Box>
  );
}
