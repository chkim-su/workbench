import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, TextInput } from '@inkjs/ui';
import open from 'open';

// OAuth Configuration (must match OpenCode/Codex exactly for the client_id to work)
const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_PORT = 1455; // Must be 1455 - this is registered with the client_id
const SCOPE = 'openid profile email offline_access';

// PKCE helpers
async function generatePKCE() {
  const verifier = generateRandomString(43);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function buildAuthorizeUrl(redirectUri, pkce, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    audience: 'https://api.openai.com/v1',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'opencode',
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code, redirectUri, pkce) {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
}

function extractAccountId(tokens) {
  const parseJwt = (token) => {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      return null;
    }
  };

  const claims = parseJwt(tokens.id_token) || parseJwt(tokens.access_token);
  if (!claims) return null;

  return claims.chatgpt_account_id ||
         claims['https://api.openai.com/auth']?.chatgpt_account_id ||
         claims.organizations?.[0]?.id;
}

async function saveToPool(tokens, poolPath, accountId) {
  const { writeFile, readFile, mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname } = await import('node:path');

  let pool = { version: 1, profiles: {}, strategy: 'sticky' };
  try {
    if (existsSync(poolPath)) {
      pool = JSON.parse(await readFile(poolPath, 'utf8'));
    }
  } catch {
    // Start fresh
  }

  const profileCount = Object.keys(pool.profiles || {}).length;
  const profileName = `account${profileCount + 1}`;

  pool.profiles = pool.profiles || {};
  pool.profiles[profileName] = {
    profile: profileName,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    accountId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAtMs: Date.now() + (tokens.expires_in || 3600) * 1000,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(poolPath), { recursive: true });
  await writeFile(poolPath, JSON.stringify(pool, null, 2) + '\n', 'utf8');
  return profileName;
}

// HTML responses for OAuth callback
const HTML_SUCCESS = `<!doctype html>
<html>
<head><title>Authorization Successful</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
.c{text-align:center}h1{color:#4ade80}</style></head>
<body><div class="c"><h1>Authorization Successful</h1><p>You can close this window and return to the terminal.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;

const HTML_ERROR = (msg) => `<!doctype html>
<html>
<head><title>Authorization Failed</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
.c{text-align:center}h1{color:#f87171}.e{color:#fca5a5;font-family:monospace;margin-top:1rem;padding:1rem;background:#1c0a0a;border-radius:0.5rem}</style></head>
<body><div class="c"><h1>Authorization Failed</h1><div class="e">${msg}</div></div></body></html>`;

// Save manual token to pool
async function saveManualToken(refreshToken, poolPath) {
  const { writeFile, readFile, mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname } = await import('node:path');

  let pool = { version: 1, profiles: {}, strategy: 'sticky' };
  try {
    if (existsSync(poolPath)) {
      pool = JSON.parse(await readFile(poolPath, 'utf8'));
    }
  } catch {
    // Start fresh
  }

  const profileCount = Object.keys(pool.profiles || {}).length;
  const profileName = `manual${profileCount + 1}`;

  pool.profiles = pool.profiles || {};
  pool.profiles[profileName] = {
    profile: profileName,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    refreshToken: refreshToken.trim(),
    expiresAtMs: 0, // Will be refreshed on first use
    enabled: true,
    updatedAt: new Date().toISOString(),
    manual: true,
  };

  await mkdir(dirname(poolPath), { recursive: true });
  await writeFile(poolPath, JSON.stringify(pool, null, 2) + '\n', 'utf8');
  return profileName;
}

// OAuth Login Component
export default function OAuthLogin({ onComplete, onCancel }) {
  const [stage, setStage] = useState('starting'); // starting, waiting, manual, success, error
  const [authUrl, setAuthUrl] = useState(null);
  const [error, setError] = useState(null);
  const [savedProfile, setSavedProfile] = useState(null);
  const [manualToken, setManualToken] = useState('');
  const serverRef = useRef(null);

  useEffect(() => {
    let cleanup = () => {
      if (serverRef.current) {
        serverRef.current.stop();
        serverRef.current = null;
      }
    };

    const start = async () => {
      try {
        const pkce = await generatePKCE();
        const state = generateState();
        const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`;
        const url = buildAuthorizeUrl(redirectUri, pkce, state);

        // Start local server using Bun.serve
        serverRef.current = Bun.serve({
          port: OAUTH_PORT,
          fetch: async (req) => {
            const reqUrl = new URL(req.url);

            if (reqUrl.pathname === '/auth/callback') {
              const code = reqUrl.searchParams.get('code');
              const returnedState = reqUrl.searchParams.get('state');
              const errorParam = reqUrl.searchParams.get('error');
              const errorDesc = reqUrl.searchParams.get('error_description');

              if (errorParam) {
                const errorMsg = errorDesc || errorParam;
                setError(errorMsg);
                setStage('error');
                cleanup();
                return new Response(HTML_ERROR(errorMsg), {
                  headers: { 'Content-Type': 'text/html' },
                });
              }

              if (!code || returnedState !== state) {
                const errorMsg = !code ? 'Missing authorization code' : 'Invalid state - potential CSRF attack';
                setError(errorMsg);
                setStage('error');
                cleanup();
                return new Response(HTML_ERROR(errorMsg), {
                  status: 400,
                  headers: { 'Content-Type': 'text/html' },
                });
              }

              try {
                const tokens = await exchangeCodeForTokens(code, redirectUri, pkce);
                const accountId = extractAccountId(tokens);

                // Save to pool
                const { join } = await import('node:path');
                const stateDir = process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench');
                const poolPath = process.env.WORKBENCH_OPENAI_OAUTH_POOL_PATH || join(stateDir, 'auth', 'openai_codex_oauth_pool.json');

                const profileName = await saveToPool(tokens, poolPath, accountId);
                setSavedProfile(profileName);
                setStage('success');

                setTimeout(() => {
                  cleanup();
                  onComplete?.(profileName);
                }, 2000);

                return new Response(HTML_SUCCESS, {
                  headers: { 'Content-Type': 'text/html' },
                });
              } catch (e) {
                setError(e.message);
                setStage('error');
                cleanup();
                return new Response(HTML_ERROR(e.message), {
                  headers: { 'Content-Type': 'text/html' },
                });
              }
            }

            return new Response('Not found', { status: 404 });
          },
        });

        setAuthUrl(url);
        setStage('waiting');

        // Try to open browser
        try {
          await open(url);
        } catch {
          // Browser open failed, user needs to manually open
        }

        // Timeout after 5 minutes
        setTimeout(() => {
          if (stage !== 'success') {
            setError('Authorization timed out. Please try again.');
            setStage('error');
            cleanup();
          }
        }, 5 * 60 * 1000);

      } catch (e) {
        setError(e.message);
        setStage('error');
        cleanup();
      }
    };

    start();
    return cleanup;
  }, []);

  // Handle switching to manual mode
  const switchToManual = () => {
    // Stop the callback server
    if (serverRef.current) {
      serverRef.current.stop();
      serverRef.current = null;
    }
    setStage('manual');
  };

  // Handle manual token submission
  const handleManualSubmit = async (value) => {
    if (!value || !value.trim()) return;

    try {
      const { join } = await import('node:path');
      const stateDir = process.env.WORKBENCH_STATE_DIR || join(process.cwd(), '.workbench');
      const poolPath = process.env.WORKBENCH_OPENAI_OAUTH_POOL_PATH || join(stateDir, 'auth', 'openai_codex_oauth_pool.json');

      const profileName = await saveManualToken(value, poolPath);
      setSavedProfile(profileName);
      setStage('success');

      setTimeout(() => {
        onComplete?.(profileName);
      }, 2000);
    } catch (e) {
      setError(e.message);
      setStage('error');
    }
  };

  // Handle input
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      if (stage === 'manual') {
        setStage('waiting');
        return;
      }
      onCancel?.();
    }
    if ((stage === 'success' || stage === 'error') && key.return) {
      onComplete?.(savedProfile);
    }
    // Press 'T' to switch to manual token entry
    if (stage === 'waiting' && (input === 't' || input === 'T')) {
      switchToManual();
    }
  }, { isActive: stage !== 'manual' }); // Disable when in manual mode (TextInput handles input)

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold color="cyan"> OPENAI OAUTH LOGIN </Text>
      </Box>

      {stage === 'starting' && (
        <Box paddingX={2}>
          <Spinner label="Initializing OAuth flow..." />
        </Box>
      )}

      {stage === 'waiting' && authUrl && (
        <Box flexDirection="column" paddingX={2}>
          <Box marginBottom={1}>
            <Text bold color="yellow">Copy this URL and open in browser:</Text>
          </Box>
          <Box
            borderStyle="double"
            borderColor="cyan"
            paddingX={1}
            paddingY={1}
            marginBottom={1}
          >
            <Text color="cyan" wrap="wrap">
              {authUrl}
            </Text>
          </Box>

          <Box marginBottom={1}>
            <Text>1. Copy the URL above (select with mouse)</Text>
          </Box>
          <Box marginBottom={1}>
            <Text>2. Open in browser and sign in with ChatGPT Plus/Pro</Text>
          </Box>
          <Box marginBottom={1}>
            <Text>3. Authorize and wait for redirect</Text>
          </Box>

          <Box marginTop={1}>
            <Spinner label="Waiting for callback on localhost:1455..." />
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Press <Text color="yellow">T</Text> to enter token manually | <Text color="gray">Esc</Text> to cancel</Text>
          </Box>
        </Box>
      )}

      {stage === 'manual' && (
        <Box flexDirection="column" paddingX={2}>
          <Box marginBottom={1}>
            <Text bold color="yellow">Manual Token Entry</Text>
          </Box>
          <Box marginBottom={1}>
            <Text>Paste your refresh token from OpenCode/Codex:</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>Location: ~/.codex/auth.json or ~/.opencode/auth.json</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>Look for: "refresh_token": "rt_..."</Text>
          </Box>
          <Box
            borderStyle="single"
            borderColor="cyan"
            paddingX={1}
            marginBottom={1}
          >
            <TextInput
              placeholder="rt_..."
              onSubmit={handleManualSubmit}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press <Text color="gray">Enter</Text> to submit | <Text color="gray">Esc</Text> to go back</Text>
          </Box>
        </Box>
      )}

      {stage === 'success' && (
        <Box flexDirection="column" paddingX={2}>
          <Box marginBottom={1}>
            <Text color="green" bold>✓ Authorization successful!</Text>
          </Box>
          <Text>Saved to profile: <Text color="cyan" bold>{savedProfile}</Text></Text>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue...</Text>
          </Box>
        </Box>
      )}

      {stage === 'error' && (
        <Box flexDirection="column" paddingX={2}>
          <Box marginBottom={1}>
            <Text color="red" bold>✗ Authorization failed</Text>
          </Box>
          <Text color="red">{error}</Text>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to return to menu...</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
