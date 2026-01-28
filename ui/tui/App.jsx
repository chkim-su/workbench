import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { Spinner } from '@inkjs/ui';
import { TuiState, aggregateState, probeCapabilities } from './state.js';
import { SessionManager } from './session.js';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import OAuthLogin from './OAuthLogin.jsx';
import OAuthStatus from './OAuthStatus.jsx';
import ModeSelector from './components/ModeSelector.jsx';
import PermissionModeSelector from './components/PermissionModeSelector.jsx';
import Menu from './components/Menu.jsx';
import { DEFAULT_PERMISSION_MODE } from './permissionModes.js';
import { appendSystemRequest, isSystemExecutorReady, newCorrelationId } from './system-client.js';

// ─── Constants ───

// Reduced polling to prevent flicker during menu navigation
// 500ms was too aggressive and caused re-renders during arrow key input
const POLL_INTERVAL = 3000;
const VERSION = '0.1.0';

// Menu structure with categories
const MAIN_MENU = [
  { label: 'Launch Provider', value: 'provider-menu', icon: '>' },
  { label: 'OAuth Management', value: 'oauth-menu', icon: '*' },
  { label: 'Run & Verify', value: 'run-menu', icon: '!' },
  { label: 'System Status', value: 'status', icon: '#' },
  { label: 'Exit', value: 'exit', icon: 'x' },
];

const PROVIDER_MENU = [
  { label: 'Codex (OAuth)', value: 'launch-codex', desc: 'Launch Codex in main pane with OAuth' },
  { label: 'Claude Code', value: 'launch-claude-code', desc: 'Launch Claude Code in main pane' },
  { label: 'Bash Shell', value: 'launch-bash', desc: 'Launch a bash shell in main pane' },
  { label: '<- Back', value: 'back' },
];

const OAUTH_MENU = [
  { label: 'View Profile Status', value: 'oauth-status', desc: 'See all profiles and rate limits' },
  { label: 'Login with Browser', value: 'oauth', desc: 'Add new OAuth profile' },
  { label: 'Import from Codex/OpenCode', value: 'oauth-import', desc: 'Import existing tokens' },
  { label: 'Sync Tokens', value: 'oauth-sync', desc: 'Refresh all tokens' },
  { label: '← Back', value: 'back' },
];

const RUN_MENU = [
  { label: 'Verify (Fast)', value: 'verify-fast', desc: 'Quick verification without Docker' },
  { label: 'Verify (Full)', value: 'verify-full', desc: 'Complete verification with Docker' },
  { label: 'Runner (Mock)', value: 'runner-mock', desc: 'Test run with mock provider' },
  { label: 'Runner (OAuth)', value: 'runner-oauth', desc: 'Real run with Codex OAuth' },
  { label: 'Install Dependencies', value: 'install', desc: 'Install all dependencies' },
  { label: '← Back', value: 'back' },
];

// ─── Helpers ───

function repoRoot() {
  return resolve(process.cwd());
}

function stateDir(root) {
  const env = (process.env.WORKBENCH_STATE_DIR ?? '').trim();
  return resolve(env || join(root, '.workbench'));
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function getProfileStatus(profile) {
  const now = Date.now();
  if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > now) {
    return { status: 'limited', color: 'yellow', icon: '!' };
  }
  if (profile.disabled || profile.enabled === false) {
    return { status: 'disabled', color: 'gray', icon: '-' };
  }
  if (profile.expiresAtMs && profile.expiresAtMs < now) {
    return { status: 'expired', color: 'red', icon: 'x' };
  }
  return { status: 'ready', color: 'green', icon: '●' };
}

// ─── Components ───

function Header({ capabilities, sessionMode }) {
  const caps = capabilities || {};
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="center">
        <Text bold color="cyan">
          ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        </Text>
      </Box>
      <Box justifyContent="center">
        <Text bold color="cyan">
          ┃     </Text>
        <Text bold color="white">MY LLM WORKBENCH</Text>
        <Text bold color="cyan">     v{VERSION}     ┃</Text>
      </Box>
      <Box justifyContent="center">
        <Text bold color="cyan">
          ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
        </Text>
      </Box>
      {sessionMode && (
        <Box justifyContent="center" marginTop={1}>
          <Text color="cyan">Mode: </Text>
          <Text color={sessionMode === 'A' ? 'green' : 'yellow'} bold>
            {sessionMode === 'A' ? 'CONTROLLED' : 'COMPAT'}
          </Text>
        </Box>
      )}
      <Box justifyContent="center" marginTop={1} gap={1}>
        {[
          { name: 'node', ok: caps.node },
          { name: 'python', ok: caps.python3 },
          { name: 'bun', ok: caps.bun },
          { name: 'tmux', ok: caps.tmux },
          { name: 'docker', ok: caps.docker },
        ].map((item) => (
          <Text key={item.name} color={item.ok ? 'green' : 'gray'} dimColor={!item.ok}>
            {item.ok ? '●' : '○'} {item.name}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function OAuthSummary({ oauthPool }) {
  if (!oauthPool || !oauthPool.profiles) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
        <Text dimColor>No OAuth profiles configured</Text>
      </Box>
    );
  }

  const profiles = Object.entries(oauthPool.profiles || {});
  const readyCount = profiles.filter(([, p]) => getProfileStatus(p).status === 'ready').length;
  const limitedCount = profiles.filter(([, p]) => getProfileStatus(p).status === 'limited').length;

  return (
    <Box
      borderStyle="round"
      borderColor={readyCount > 0 ? 'green' : 'yellow'}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">OAuth Profiles</Text>
      </Box>
      <Box gap={2}>
        <Text>
          <Text color="green">{readyCount}</Text> ready
        </Text>
        {limitedCount > 0 && (
          <Text>
            <Text color="yellow">{limitedCount}</Text> limited
          </Text>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {profiles.slice(0, 3).map(([name, profile]) => {
          const status = getProfileStatus(profile);
          return (
            <Text key={name} dimColor={status.status !== 'ready'}>
              <Text color={status.color}>{status.icon}</Text> {name}
              {status.status === 'limited' && profile.rateLimitedUntilMs && (
                <Text dimColor> ({formatTimeRemaining(profile.rateLimitedUntilMs - Date.now())})</Text>
              )}
            </Text>
          );
        })}
        {profiles.length > 3 && (
          <Text dimColor>  +{profiles.length - 3} more</Text>
        )}
      </Box>
    </Box>
  );
}

function VerifySummary({ verifyGates }) {
  if (!verifyGates || verifyGates.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
        <Text dimColor>No verify results</Text>
      </Box>
    );
  }

  const passed = verifyGates.filter(g => g.ok && !g.skipped).length;
  const failed = verifyGates.filter(g => !g.ok && !g.skipped).length;
  const skipped = verifyGates.filter(g => g.skipped).length;

  return (
    <Box
      borderStyle="round"
      borderColor={failed > 0 ? 'red' : 'green'}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">Last Verify</Text>
      </Box>
      <Box gap={2}>
        <Text><Text color="green">{passed}</Text> passed</Text>
        {failed > 0 && <Text><Text color="red">{failed}</Text> failed</Text>}
        {skipped > 0 && <Text><Text color="yellow">{skipped}</Text> skipped</Text>}
      </Box>
    </Box>
  );
}

function MainMenuView({ onSelect, oauthPool, verifyGates }) {
  const options = MAIN_MENU.map((item) => ({
    label: `${item.icon}  ${item.label}`,
    value: item.value,
  }));

  return (
    <Box flexDirection="column" alignItems="center">
      <Menu options={options} onSelect={onSelect} showHint={false} />

      {/* Quick status panels */}
      <Box marginTop={2} gap={2}>
        <OAuthSummary oauthPool={oauthPool} />
        <VerifySummary verifyGates={verifyGates} />
      </Box>
    </Box>
  );
}

function SubMenuView({ title, items, onSelect }) {
  const options = items.map((item) => ({
    label: item.label,
    value: item.value,
  }));

  return (
    <Box flexDirection="column" alignItems="center">
      <Menu options={options} onSelect={onSelect} title={title} />
    </Box>
  );
}

function StatusBar({ directory }) {
  return (
    <Box
      paddingX={2}
      paddingY={1}
      borderStyle="single"
      borderColor="gray"
      justifyContent="space-between"
    >
      <Text dimColor>{directory}</Text>
      <Text dimColor>Press Ctrl+C to exit</Text>
    </Box>
  );
}

function RunningOverlay({ message, onReturn }) {
  useInput((input, key) => {
    if (key.return || key.escape) {
      onReturn();
    }
  });

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      padding={2}
    >
      <Box
        borderStyle="round"
        borderColor="blue"
        paddingX={4}
        paddingY={2}
        flexDirection="column"
        alignItems="center"
      >
        <Spinner label={message} />
        <Box marginTop={1}>
          <Text dimColor>Output is shown in the adjacent pane</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Enter or Esc to return to menu</Text>
        </Box>
      </Box>
    </Box>
  );
}

function Notification({ message, type, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const colors = {
    success: 'green',
    error: 'red',
    info: 'cyan',
  };

  return (
    <Box
      borderStyle="round"
      borderColor={colors[type] || 'gray'}
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Text color={colors[type] || 'white'}>{message}</Text>
    </Box>
  );
}

// ─── Main App ───

export default function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const rows = stdout?.rows || 24;
  const [sessionMode, setSessionMode] = useState(null); // null = show mode selector, 'A' | 'B' = selected mode
  const [permissionMode, setPermissionMode] = useState(null); // null = show selector after mode, 'plan' | 'bypass'
  const [state, setState] = useState({
    mode: 'menu', // menu | provider-menu | oauth-menu | run-menu | oauth | oauth-status | running | status
    verifyGates: [],
    verifyRunId: null,
    runnerStatus: null,
    runnerRunId: null,
    oauthPool: null,
    lastError: null,
    notification: null,
    capabilities: {},
  });

  const root = repoRoot();
  const base = stateDir(root);
  const directory = root.split('/').pop() || root;

  // Session manager singleton
  const [sessionManager] = useState(() => new SessionManager(base));

  // Probe capabilities on mount
  useEffect(() => {
    const probe = async () => {
      const tuiState = new TuiState();
      await probeCapabilities(tuiState);
      setState((s) => ({ ...s, capabilities: tuiState.capabilities }));
    };
    probe();
  }, []);

  // Poll state
  useEffect(() => {
    const poll = async () => {
      const tuiState = new TuiState();
      tuiState.verifyRunId = state.verifyRunId;
      tuiState.runnerRunId = state.runnerRunId;
      await aggregateState(tuiState, base);
      setState((s) => ({
        ...s,
        verifyGates: tuiState.verifyGates,
        verifyRunId: tuiState.verifyRunId,
        runnerStatus: tuiState.runnerStatus,
        runnerRunId: tuiState.runnerRunId,
        oauthPool: tuiState.oauthPool,
      }));
    };

    const interval = setInterval(poll, POLL_INTERVAL);
    poll();
    return () => clearInterval(interval);
  }, [state.verifyRunId, state.runnerRunId]);

  // Global input handler
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
    // Escape returns to main menu from submenus
    if (key.escape && ['provider-menu', 'oauth-menu', 'run-menu'].includes(state.mode)) {
      setState((s) => ({ ...s, mode: 'menu' }));
    }
  });

  const showNotification = (message, type = 'info') => {
    setState((s) => ({ ...s, notification: { message, type } }));
  };

  const dismissNotification = () => {
    setState((s) => ({ ...s, notification: null }));
  };

  // Handle OAuth completion
  const handleOAuthComplete = (profileName) => {
    setState((s) => ({ ...s, mode: 'menu' }));
    if (profileName) {
      showNotification(`OAuth profile "${profileName}" added successfully!`, 'success');
    }
  };

  const requestSystemAction = ({ type, statusMessage, payload = {} }) => {
    if (!isSystemExecutorReady(base)) {
      showNotification('System executor offline. Start Workbench from a terminal so it can run host actions.', 'error');
      return false;
    }
    const correlationId = newCorrelationId();
    appendSystemRequest(base, { type, correlationId, ...payload });
    setState((s) => ({ ...s, mode: 'running', statusMessage }));
    return true;
  };

  // Handle main menu selection
  const handleMainSelect = (value) => {
    switch (value) {
      case 'provider-menu':
        setState((s) => ({ ...s, mode: 'provider-menu' }));
        break;
      case 'oauth-menu':
        setState((s) => ({ ...s, mode: 'oauth-menu' }));
        break;
      case 'run-menu':
        setState((s) => ({ ...s, mode: 'run-menu' }));
        break;
      case 'status':
        setState((s) => ({ ...s, mode: 'status' }));
        break;
      case 'exit':
        exit();
        break;
    }
  };

  // Handle provider menu selection
  const handleProviderSelect = (value) => {
    if (value === 'back') {
      setState((s) => ({ ...s, mode: 'menu' }));
      return;
    }

    const surfaceMap = {
      'launch-codex': 'codex',
      'launch-claude-code': 'claude-code',
      'launch-bash': 'bash',
    };

    const surface = surfaceMap[value];
    if (surface) {
      requestSystemAction({
        type: 'surface.launch',
        statusMessage: `Launching ${surface}...`,
        payload: {
          surface,
          cwd: root,
          syncOAuth: surface === 'codex',
        },
      });
    }
  };

  // Handle OAuth submenu selection
  const handleOAuthSelect = async (value) => {
    if (value === 'back') {
      setState((s) => ({ ...s, mode: 'menu' }));
      return;
    }

    switch (value) {
      case 'oauth-status':
        setState((s) => ({ ...s, mode: 'oauth-status' }));
        break;

      case 'oauth':
        setState((s) => ({ ...s, mode: 'oauth' }));
        break;

      case 'oauth-import':
        try {
          const homedir = process.env.HOME || '/home/' + process.env.USER;
          const sources = [
            join(homedir, '.codex', 'auth.json'),
            join(homedir, '.opencode', 'auth.json'),
          ];

          let imported = false;
          for (const source of sources) {
            if (existsSync(source)) {
              const auth = JSON.parse(readFileSync(source, 'utf8'));
              if (auth.tokens?.refresh_token) {
                const poolPath = join(base, 'auth', 'openai_codex_oauth_pool.json');
                mkdirSync(join(base, 'auth'), { recursive: true });

                let pool = { version: 1, strategy: 'sticky', profiles: {} };
                if (existsSync(poolPath)) {
                  try {
                    pool = JSON.parse(readFileSync(poolPath, 'utf8'));
                  } catch {}
                }

                const profileName = `imported_${Date.now()}`;
                pool.profiles[profileName] = {
                  profile: profileName,
                  issuer: 'https://auth.openai.com',
                  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
                  accountId: auth.tokens.account_id,
                  accessToken: auth.tokens.access_token,
                  refreshToken: auth.tokens.refresh_token,
                  idToken: auth.tokens.id_token,
                  expiresAtMs: Date.now() + 3600 * 1000,
                  enabled: true,
                  updatedAt: new Date().toISOString(),
                };

                writeFileSync(poolPath, JSON.stringify(pool, null, 2) + '\n', 'utf8');
                showNotification(`Imported from ${source.split('/').pop()}`, 'success');
                imported = true;
                break;
              }
            }
          }

          if (!imported) {
            showNotification('No Codex/OpenCode auth found. Run: opencode or codex first', 'error');
          }
        } catch (e) {
          showNotification(`Import failed: ${e.message}`, 'error');
        }
        break;

      case 'oauth-sync':
        requestSystemAction({
          type: 'oauth.sync',
          statusMessage: 'Syncing OAuth tokens...',
          payload: { watch: false },
        });
        break;
    }
  };

  // Handle Run submenu selection
  const handleRunSelect = async (value) => {
    if (value === 'back') {
      setState((s) => ({ ...s, mode: 'menu' }));
      return;
    }

    switch (value) {
      case 'verify-fast':
        requestSystemAction({
          type: 'verify',
          statusMessage: 'Running fast verification...',
          payload: { full: false },
        });
        break;

      case 'verify-full':
        requestSystemAction({
          type: 'verify',
          statusMessage: 'Running full verification...',
          payload: { full: true },
        });
        break;

      case 'runner-mock':
        requestSystemAction({
          type: 'runner.smoke',
          statusMessage: 'Running mock test...',
          payload: { provider: 'mock' },
        });
        break;

      case 'runner-oauth':
        requestSystemAction({
          type: 'runner.smoke',
          statusMessage: 'Running OAuth test...',
          payload: { provider: 'openai-oauth', syncOAuth: true },
        });
        break;

      case 'install':
        requestSystemAction({
          type: 'install',
          statusMessage: 'Installing dependencies...',
        });
        break;
    }
  };

  // Handle mode change (returning to mode selector)
  const handleModeChange = (mode) => {
    setSessionMode(mode);
    if (mode === null) {
      setPermissionMode(null); // Also reset permission mode to show selector again
      setState((s) => ({ ...s, mode: 'menu' }));
    }
  };

  // Handle permission mode change
  const handlePermissionModeChange = (pMode) => {
    setPermissionMode(pMode);
    sessionManager.setPermissionMode(pMode);
  };

  // Stable fallback: avoid complex layouts on tiny terminals (prevents wrap jitter/flicker).
  if (cols < 60 || rows < 18) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">My LLM Workbench</Text>
        <Text color="yellow">Terminal too small</Text>
        <Text dimColor>Minimum: 60x18 | Current: {cols}x{rows}</Text>
        <Text dimColor>Tip: resize the terminal window. Ctrl+C to exit.</Text>
      </Box>
    );
  }

  // Show mode selector first if no mode selected
  if (sessionMode === null) {
    return (
      <ModeSelector
        onSelect={(mode) => {
          setSessionMode(mode);
        }}
      />
    );
  }

  // Show permission mode selector after session mode selection
  if (permissionMode === null) {
    return (
      <PermissionModeSelector
        onSelect={(pMode) => {
          setPermissionMode(pMode);
          sessionManager.createSession(sessionMode, pMode);
        }}
        onBack={() => {
          setSessionMode(null);
        }}
      />
    );
  }

  // Render based on mode
  if (state.mode === 'oauth') {
    return (
      <OAuthLogin
        onComplete={handleOAuthComplete}
        onCancel={() => setState((s) => ({ ...s, mode: 'oauth-menu' }))}
      />
    );
  }

  if (state.mode === 'oauth-status') {
    return (
      <OAuthStatus
        oauthPool={state.oauthPool}
        onClose={() => setState((s) => ({ ...s, mode: 'oauth-menu' }))}
      />
    );
  }


  if (state.mode === 'status') {
    return (
      <OAuthStatus
        oauthPool={state.oauthPool}
        onClose={() => setState((s) => ({ ...s, mode: 'menu' }))}
      />
    );
  }

  if (state.mode === 'running') {
    return (
      <Box flexDirection="column" height={stdout?.rows || 24}>
        <Header capabilities={state.capabilities} sessionMode={sessionMode} />
        <Box flexGrow={1}>
          <RunningOverlay
            message={state.statusMessage}
            onReturn={() => setState((s) => ({ ...s, mode: 'menu', statusMessage: null }))}
          />
        </Box>
        <StatusBar directory={directory} />
      </Box>
    );
  }

  // Main view with menu or submenu
  return (
    <Box flexDirection="column" height={stdout?.rows || 24}>
      <Header capabilities={state.capabilities} sessionMode={sessionMode} />

      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        {state.mode === 'menu' && (
          <MainMenuView
            onSelect={handleMainSelect}
            oauthPool={state.oauthPool}
            verifyGates={state.verifyGates}
          />
        )}

        {state.mode === 'provider-menu' && (
          <SubMenuView
            title="Launch Provider"
            items={PROVIDER_MENU}
            onSelect={handleProviderSelect}
          />
        )}

        {state.mode === 'oauth-menu' && (
          <SubMenuView
            title="OAuth Management"
            items={OAUTH_MENU}
            onSelect={handleOAuthSelect}
          />
        )}

        {state.mode === 'run-menu' && (
          <SubMenuView
            title="Run & Verify"
            items={RUN_MENU}
            onSelect={handleRunSelect}
          />
        )}

        {state.notification && (
          <Notification
            message={state.notification.message}
            type={state.notification.type}
            onDismiss={dismissNotification}
          />
        )}
      </Box>

      <StatusBar directory={directory} />
    </Box>
  );
}
