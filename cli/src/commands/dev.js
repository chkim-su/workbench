/**
 * Dev command - deterministic, DevOps-grade control surface.
 *
 * Implements a file-backed command bus (`.workbench/<sessionId>/commands.jsonl`) and a
 * headless Go TUI session runner in Docker via the MCP docker server.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { StdioJsonRpcClient } from '../../../mcp/kit/src/index.js';

function resolveRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

function resolveStateDir(repoRoot, stateDir) {
  if (!stateDir) return path.join(repoRoot, '.workbench');
  return path.isAbsolute(stateDir) ? stateDir : path.join(repoRoot, stateDir);
}

function newSessionId() {
  return `sess_${crypto.randomBytes(4).toString('hex')}`;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function parseDevArgs(args) {
  const out = { sub: args[0] || null, rest: args.slice(1) };
  return out;
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--engine') flags.engine = args[++i];
    if (a === '--mode') flags.mode = args[++i];
    else if (a === '--session') flags.session = args[++i];
    else if (a === '--text') flags.text = args[++i];
    else if (a === '--keys') flags.keys = args[++i];
    else if (a === '--runtime') flags.runtime = args[++i];
    else if (a === '--model') flags.model = args[++i];
    else if (a === '--permission-mode') flags.permissionMode = args[++i];
    else if (a === '--thought-stream') flags.thoughtStream = args[++i];
    else rest.push(a);
  }
  flags._ = rest;
  return flags;
}

function ensureCurrentSessionId(stateDirAbs, sessionId) {
  const currentPath = path.join(stateDirAbs, 'state', 'current.json');
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  let current = { schemaVersion: 1 };
  try {
    if (fs.existsSync(currentPath)) current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  } catch {
    current = { schemaVersion: 1 };
  }
  current.sessionId = sessionId;
  current.updatedAt = new Date().toISOString();
  fs.writeFileSync(currentPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
}

function hasCommand(cmd) {
  try {
    const r = spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function spawnSidecar({ repoRoot, stateDirAbs, sessionId, name, args, logFile }) {
  const outPath = logFile || path.join(stateDirAbs, 'logs', `${name}.${sessionId}.log`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outFd = fs.openSync(outPath, 'a');
  const env = { ...process.env, WORKBENCH_STATE_DIR: stateDirAbs };
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', outFd, outFd],
  });
  child.unref();
  return { pid: child.pid, log: outPath };
}

function spawnHostTuiServe({ repoRoot, stateDirAbs, sessionId }) {
  const outPath = path.join(stateDirAbs, 'logs', `tui-serve.${sessionId}.log`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outFd = fs.openSync(outPath, 'a');
  const cacheBase = path.join(stateDirAbs, 'cache');
  const env = {
    ...process.env,
    WORKBENCH_STATE_DIR: stateDirAbs,
    HOME: path.join(stateDirAbs, 'home'),
    XDG_CACHE_HOME: path.join(cacheBase, 'xdg'),
    GOPATH: path.join(cacheBase, 'go', 'gopath'),
    GOMODCACHE: path.join(cacheBase, 'go', 'mod'),
    GOCACHE: path.join(cacheBase, 'go', 'build'),
  };
  for (const p of [env.HOME, env.XDG_CACHE_HOME, env.GOPATH, env.GOMODCACHE, env.GOCACHE]) {
    fs.mkdirSync(p, { recursive: true });
  }
  const cmd = `cd "${path.join(repoRoot, 'ui', 'tui')}" && go run . --serve --session-id ${sessionId}`;
  const child = spawn('bash', ['-lc', cmd], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', outFd, outFd],
  });
  child.unref();
  return { pid: child.pid, log: outPath };
}

async function withDockerMcp(repoRoot, stateDirAbs) {
  const env = { ...process.env, WORKBENCH_STATE_DIR: stateDirAbs };
  const docker = StdioJsonRpcClient.spawn(['bun', 'mcp/servers/docker/src/index.js'], { cwd: repoRoot, env });
  await docker.initialize(10_000);
  return docker;
}

async function devStart({ repoRoot, stateDirAbs, output, logger }, args) {
  const flags = parseFlags(args);
  const mode = (flags.mode || 'B').toUpperCase();
  if (mode !== 'A' && mode !== 'B') {
    output.writeError('INVALID_MODE', 'Invalid mode (expected A or B)', { mode });
    return 1;
  }

  const engine = String(flags.engine || 'docker').trim().toLowerCase();
  if (engine !== 'docker' && engine !== 'host') {
    output.writeError('INVALID_ENGINE', 'Invalid engine (expected docker or host)', { engine });
    return 1;
  }

  const sessionId = newSessionId();
  const sessionDir = path.join(stateDirAbs, sessionId);
  const commandsPath = path.join(sessionDir, 'commands.jsonl');
  const devPath = path.join(sessionDir, 'dev.json');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(commandsPath, '', 'utf8');

  const containerName = `workbench-dev-${sessionId}`;

  // Ensure host-side executors and state aggregation point at this session deterministically.
  ensureCurrentSessionId(stateDirAbs, sessionId);

  let containerId = null;
  let hostServe = null;
  if (engine === 'docker') {
    const docker = await withDockerMcp(repoRoot, stateDirAbs);
    try {
      const run = await docker.toolsCall(
        'workbench.docker.run_detached',
        {
          image: 'golang:1.22',
          name: containerName,
          pull: 'missing',
          user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          workdir: '/repo/ui/tui',
          env: {
            HOME: '/state/home',
            XDG_CACHE_HOME: '/state/cache/xdg',
            GOPATH: '/state/cache/go/gopath',
            GOMODCACHE: '/state/cache/go/mod',
            GOCACHE: '/state/cache/go/build',
            PATH: '/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            WORKBENCH_STATE_DIR: '/state',
          },
          mounts: [
            { hostPath: repoRoot, containerPath: '/repo', mode: 'ro' },
            { hostPath: stateDirAbs, containerPath: '/state', mode: 'rw' },
          ],
          cmd: ['bash', '-c', `cd /repo/ui/tui && go run . --serve --session-id ${sessionId}`],
        },
        120_000,
      );
      if (run.error) throw new Error(run.error.message ?? 'docker.run_detached jsonrpc error');
      const json = run.result?.content?.[0]?.json;
      if (run.result?.isError || !json?.containerId) {
        throw new Error(`docker.run_detached failed. artifacts=${json?.artifacts?.dir ?? '?'}`);
      }
      containerId = json.containerId;
    } finally {
      docker.kill();
    }
  } else {
    hostServe = spawnHostTuiServe({ repoRoot, stateDirAbs, sessionId });
  }

  // Start host-side executors so CLI/dev sessions can use Codex/OpenCode runtimes.
  const sidecars = [];
  try {
    sidecars.push(spawnSidecar({
      repoRoot,
      stateDirAbs,
      sessionId,
      name: 'system-executor',
      args: [path.join(repoRoot, 'ui', 'tui', 'system-executor.js'), '--state-dir', stateDirAbs, '--repo-root', repoRoot],
    }));
    if (hasCommand('codex')) {
      sidecars.push(spawnSidecar({
        repoRoot,
        stateDirAbs,
        sessionId,
        name: 'codex-executor',
        args: [path.join(repoRoot, 'ui', 'tui', 'codex-executor.js'), '--state-dir', stateDirAbs, '--repo-root', repoRoot],
      }));
    }
    if (hasCommand('opencode') || (process.env.WORKBENCH_OPENCODE_BIN || '').trim()) {
      sidecars.push(spawnSidecar({
        repoRoot,
        stateDirAbs,
        sessionId,
        name: 'opencode-executor',
        args: [path.join(repoRoot, 'ui', 'tui', 'opencode-executor.js'), '--state-dir', stateDirAbs, '--repo-root', repoRoot],
      }));
    }
  } catch (e) {
    // Non-fatal: dockerized session still works for chat-only flows; tool runtimes require these.
    logger.warn('dev_sidecars_failed', 'Failed to start one or more host-side executors', { error: String(e?.message ?? e) });
  }

  writeJson(devPath, {
    version: 1,
    sessionId,
    mode,
    startedAt: new Date().toISOString(),
    engine,
    containerName: engine === 'docker' ? containerName : null,
    containerId: engine === 'docker' ? containerId : null,
    hostServe,
    commandsPath,
    summaryPath: path.join(sessionDir, 'summary.json'),
    eventsPath: path.join(sessionDir, 'events.jsonl'),
    sidecars,
  });

  logger.info('dev_start', 'Started dev session', { sessionId, mode, containerName, containerId });

  // Drive deterministic bootstrap into cockpit so the session is immediately controllable.
  const bootstrapKeys = mode === 'B' ? 'down enter enter' : 'enter enter';
  appendJsonl(commandsPath, { version: 1, type: 'key', source: 'cli', keys: bootstrapKeys });

  output.writeSuccess({ ok: true, sessionId, mode, containerName, containerId });
  return 0;
}

async function devStatus({ stateDirAbs, output }, args) {
  const flags = parseFlags(args);
  const sessionId = flags.session;
  if (!sessionId) {
    output.writeError('MISSING_SESSION', 'Missing required --session <id>');
    return 1;
  }
  const sessionDir = path.join(stateDirAbs, sessionId);
  const devPath = path.join(sessionDir, 'dev.json');
  const summaryPath = path.join(sessionDir, 'summary.json');
  const eventsPath = path.join(sessionDir, 'events.jsonl');

  const dev = fs.existsSync(devPath) ? readJson(devPath) : null;
  const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : null;

  output.writeSuccess({
    ok: true,
    sessionId,
    dev,
    summary,
    paths: { sessionDir, devPath, summaryPath, eventsPath },
  });
  return 0;
}

async function devStop({ repoRoot, stateDirAbs, output, logger }, args) {
  const flags = parseFlags(args);
  const sessionId = flags.session;
  if (!sessionId) {
    output.writeError('MISSING_SESSION', 'Missing required --session <id>');
    return 1;
  }
  const sessionDir = path.join(stateDirAbs, sessionId);
  const devPath = path.join(sessionDir, 'dev.json');
  if (!fs.existsSync(devPath)) {
    output.writeError('SESSION_NOT_FOUND', 'Session not found', { sessionId, devPath });
    return 1;
  }
  const dev = readJson(devPath);

  // Try graceful stop via command bus first.
  appendJsonl(path.join(sessionDir, 'commands.jsonl'), { version: 1, type: 'stop', source: 'cli' });
  const summaryPath = path.join(sessionDir, 'summary.json');
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(summaryPath)) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const engine = String(dev.engine || 'docker').trim().toLowerCase();
  if (engine === 'docker') {
    const docker = await withDockerMcp(repoRoot, stateDirAbs);
    try {
      const stop = await docker.toolsCall('workbench.docker.stop', { container: dev.containerName, remove: true }, 60_000);
      if (stop.error) throw new Error(stop.error.message ?? 'docker.stop jsonrpc error');
      if (stop.result?.isError) {
        const json = stop.result?.content?.[0]?.json;
        throw new Error(`docker.stop failed. artifacts=${json?.artifacts?.dir ?? '?'}`);
      }
    } finally {
      docker.kill();
    }
  } else if (engine === 'host') {
    const pid = dev?.hostServe?.pid;
    if (typeof pid === 'number' && Number.isFinite(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }

  // Best-effort stop host-side executors (if they were started by devStart).
  const sidecars = Array.isArray(dev.sidecars) ? dev.sidecars : [];
  for (const s of sidecars) {
    const pid = s?.pid;
    if (typeof pid !== 'number' || !Number.isFinite(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  logger.info('dev_stop', 'Stopped dev session', { sessionId, containerName: dev.containerName });
  output.writeSuccess({ ok: true, sessionId });
  return 0;
}

async function devWriteCommand({ stateDirAbs, output }, type, args) {
  const flags = parseFlags(args);
  const sessionId = flags.session;
  if (!sessionId) {
    output.writeError('MISSING_SESSION', 'Missing required --session <id>');
    return 1;
  }
  const sessionDir = path.join(stateDirAbs, sessionId);
  const commandsPath = path.join(sessionDir, 'commands.jsonl');
  if (!fs.existsSync(commandsPath)) {
    output.writeError('SESSION_NOT_FOUND', 'Session not found', { sessionId, commandsPath });
    return 1;
  }

  const payload = { version: 1, type, source: 'cli' };
  if (type === 'send' || type === 'cmd') payload.text = flags.text ?? '';
  if (type === 'key') payload.keys = flags.keys ?? '';

  appendJsonl(commandsPath, payload);
  output.writeSuccess({ ok: true, sessionId, wrote: payload });
  return 0;
}

async function devAuthStatus({ stateDirAbs, output }) {
  const poolPath = path.join(stateDirAbs, 'auth', 'openai_codex_oauth_pool.json');
  if (!fs.existsSync(poolPath)) {
    output.writeError('POOL_NOT_FOUND', 'OAuth pool not found', { poolPath });
    return 1;
  }
  const pool = readJson(poolPath);
  const sel = pool.selection || {};
  const lastUsedProfile = sel.lastUsedProfile || null;
  const profiles = pool.profiles || {};
  const p = lastUsedProfile && profiles[lastUsedProfile] ? profiles[lastUsedProfile] : null;
  const email = (p && p.email) || lastUsedProfile || null;
  output.writeSuccess({ ok: true, poolPath, lastUsedProfile, email });
  return 0;
}

async function devAuthSwap({ stateDirAbs, output }) {
  const poolPath = path.join(stateDirAbs, 'auth', 'openai_codex_oauth_pool.json');
  if (!fs.existsSync(poolPath)) {
    output.writeError('POOL_NOT_FOUND', 'OAuth pool not found', { poolPath });
    return 1;
  }
  const pool = readJson(poolPath);
  const sel = pool.selection || {};
  const profiles = pool.profiles || {};
  const nowMs = Date.now();

  const current = sel.lastUsedProfile || null;
  const candidates = Object.entries(profiles)
    .map(([profile, obj]) => ({
      profile,
      email: obj.email || profile,
      disabled: !!obj.disabled,
      remaining: typeof obj.remaining === 'number' ? obj.remaining : 1e18,
      resetAtMs: typeof obj.resetAtMs === 'number' ? obj.resetAtMs : 1e18,
      rateLimitedUntilMs: typeof obj.rateLimitedUntilMs === 'number' ? obj.rateLimitedUntilMs : 0,
    }))
    .filter(p => !p.disabled && p.rateLimitedUntilMs <= nowMs)
    .sort((a, b) =>
      a.remaining !== b.remaining ? a.remaining - b.remaining :
      a.resetAtMs !== b.resetAtMs ? a.resetAtMs - b.resetAtMs :
      a.email.localeCompare(b.email)
    );

  const next = candidates.find(c => c.profile !== current) || candidates[0] || null;
  if (!next) {
    output.writeError('NO_CANDIDATES', 'No usable OAuth accounts available');
    return 1;
  }

  pool.selection = pool.selection || {};
  pool.selection.lastUsedProfile = next.profile;
  writeJson(poolPath, pool);

  output.writeSuccess({ ok: true, poolPath, from: current, to: next.profile, email: next.email });
  return 0;
}

async function devSnapshot({ stateDirAbs, output }, args) {
  const flags = parseFlags(args);
  const sessionId = flags.session;
  if (!sessionId) {
    output.writeError('MISSING_SESSION', 'Missing required --session <id>');
    return 1;
  }
  const sessionDir = path.join(stateDirAbs, sessionId);
  const snapId = `snap_${Date.now()}`;
  const outDir = path.join(stateDirAbs, 'snapshots', snapId);
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ['summary.json', 'events.jsonl']) {
    const src = path.join(sessionDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDir, name));
    }
  }
  output.writeSuccess({ ok: true, sessionId, snapshotDir: outDir });
  return 0;
}

async function devSet({ stateDirAbs, output }, args) {
  const flags = parseFlags(args);
  const sessionId = flags.session;
  if (!sessionId) {
    output.writeError('MISSING_SESSION', 'Missing required --session <id>');
    return 1;
  }
  const sessionDir = path.join(stateDirAbs, sessionId);
  const commandsPath = path.join(sessionDir, 'commands.jsonl');
  if (!fs.existsSync(commandsPath)) {
    output.writeError('SESSION_NOT_FOUND', 'Session not found', { sessionId, commandsPath });
    return 1;
  }

  const payload = { version: 1, type: 'set', source: 'cli' };
  if (flags.mode) payload.mode = String(flags.mode);
  if (flags.runtime) payload.runtime = String(flags.runtime);
  if (flags.model) payload.model = String(flags.model);
  if (flags.permissionMode) payload.permissionMode = String(flags.permissionMode);
  if (typeof flags.thoughtStream === 'string') {
    const v = flags.thoughtStream.trim().toLowerCase();
    payload.thoughtStream = v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  const changedKeys = Object.keys(payload).filter((k) => !['version', 'type', 'source'].includes(k));
  if (changedKeys.length === 0) {
    output.writeError('NO_CHANGES', 'No set fields provided (use --runtime/--model/--mode/--permission-mode/--thought-stream)');
    return 1;
  }

  appendJsonl(commandsPath, payload);
  output.writeSuccess({ ok: true, sessionId, wrote: payload });
  return 0;
}

async function devFollow({ stateDirAbs, output }, args) {
  const flags = parseFlags(args);
  const sessionId = flags.session;
  if (!sessionId) {
    output.writeError('MISSING_SESSION', 'Missing required --session <id>');
    return 1;
  }
  const sessionDir = path.join(stateDirAbs, sessionId);
  const files = [
    { name: 'events', path: path.join(sessionDir, 'events.jsonl') },
    { name: 'codex.events', path: path.join(sessionDir, 'codex.events.jsonl') },
    { name: 'codex.responses', path: path.join(sessionDir, 'codex.responses.jsonl') },
    { name: 'opencode.events', path: path.join(sessionDir, 'opencode.events.jsonl') },
    { name: 'opencode.responses', path: path.join(sessionDir, 'opencode.responses.jsonl') },
    { name: 'system.responses', path: path.join(sessionDir, 'system.responses.jsonl') },
  ];

  const offsets = new Map(files.map((f) => [f.name, 0]));

  // Follow is inherently streaming; force plain output even if global --json is set.
  // (Callers that want JSON can wrap this stream; or we can add ndjson later.)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let any = false;
    for (const f of files) {
      if (!fs.existsSync(f.path)) continue;
      let st;
      try { st = fs.statSync(f.path); } catch { continue; }
      const prev = offsets.get(f.name) || 0;
      if (prev > st.size) offsets.set(f.name, st.size);
      const cur = offsets.get(f.name) || 0;
      if (cur === st.size) continue;
      const fd = fs.openSync(f.path, 'r');
      const buf = Buffer.alloc(st.size - cur);
      fs.readSync(fd, buf, 0, buf.length, cur);
      fs.closeSync(fd);
      offsets.set(f.name, st.size);
      const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        any = true;
        process.stdout.write(`[${f.name}] ${line}\n`);
      }
    }
    if (!any) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export async function run(args, context) {
  const { logger, output, stateDir } = context;
  const repoRoot = resolveRepoRoot();
  const stateDirAbs = resolveStateDir(repoRoot, stateDir);
  const parsed = parseDevArgs(args);

  switch (parsed.sub) {
    case 'start':
      return devStart({ repoRoot, stateDirAbs, output, logger }, parsed.rest);
    case 'status':
      return devStatus({ stateDirAbs, output }, parsed.rest);
    case 'stop':
      return devStop({ repoRoot, stateDirAbs, output, logger }, parsed.rest);
    case 'send':
      return devWriteCommand({ stateDirAbs, output }, 'send', parsed.rest);
    case 'key':
      return devWriteCommand({ stateDirAbs, output }, 'key', parsed.rest);
    case 'cmd':
      return devWriteCommand({ stateDirAbs, output }, 'cmd', parsed.rest);
    case 'set':
      return devSet({ stateDirAbs, output }, parsed.rest);
    case 'follow':
      return devFollow({ stateDirAbs, output }, parsed.rest);
    case 'snapshot':
      return devSnapshot({ stateDirAbs, output }, parsed.rest);
    case 'auth': {
      const sub2 = parsed.rest[0] || null;
      const rest2 = parsed.rest.slice(1);
      if (sub2 === 'status') return devAuthStatus({ stateDirAbs, output }, rest2);
      if (sub2 === 'swap') return devAuthSwap({ stateDirAbs, output }, rest2);
      output.writeError('UNKNOWN_SUBCOMMAND', 'Unknown dev auth subcommand', { subcommand: sub2, available: ['status', 'swap'] });
      return 1;
    }
    default:
      output.writeError('UNKNOWN_SUBCOMMAND', 'Unknown dev subcommand', {
        subcommand: parsed.sub,
        available: ['start', 'status', 'stop', 'send', 'key', 'cmd', 'set', 'follow', 'auth status', 'auth swap', 'snapshot'],
      });
      return 1;
  }
}

export default { run };
