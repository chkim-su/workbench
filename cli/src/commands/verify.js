/**
 * Verify command - Run real-test gates.
 *
 * Delegates to `verify/run.js` (MCP-first, durable artifacts under `.workbench/`).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse command-line arguments for verify command.
 * @param {string[]} args
 * @returns {{full: boolean, quick: boolean, gate: string | null}}
 */
function parseVerifyArgs(args) {
  const result = {
    full: false,
    quick: false,
    gate: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--full') {
      result.full = true;
    } else if (arg === '--quick') {
      result.quick = true;
    } else if (arg === '--gate') {
      result.gate = args[++i] ?? null;
    }
  }

  return result;
}

function resolveRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

function resolveStateDir(repoRoot, stateDir) {
  if (!stateDir) return path.join(repoRoot, '.workbench');
  return path.isAbsolute(stateDir) ? stateDir : path.join(repoRoot, stateDir);
}

function normalizeGate(gate) {
  if (!gate) return null;
  const g = String(gate).trim();
  if (!g) return null;
  if (/^[0-9]+$/.test(g)) return `gate${g}`;
  return g;
}

function readLatestVerifySummary(stateDirAbs) {
  try {
    const currentPath = path.join(stateDirAbs, 'state', 'current.json');
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    const verifyRunId = current?.verifyRunId;
    if (typeof verifyRunId !== 'string' || !verifyRunId) return null;
    const summaryPath = path.join(stateDirAbs, 'verify', 'gates', verifyRunId, 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    return { verifyRunId, summaryPath, summary };
  } catch {
    return null;
  }
}

async function runVerifyScript({ repoRoot, stateDirAbs, verifyArgs, jsonMode }) {
  const env = { ...process.env, WORKBENCH_STATE_DIR: stateDirAbs };
  const wantsFull = verifyArgs.full === true;
  const wantsQuick = verifyArgs.quick === true;
  const isFast = wantsQuick || !wantsFull;

  if (isFast) {
    env.WORKBENCH_VERIFY_FAST = '1';
    env.WORKBENCH_SKIP_DOCKER = '1';
  }

  const nodeArgs = ['verify/run.js'];
  const gate = normalizeGate(verifyArgs.gate);
  if (gate) nodeArgs.push('--gate', gate);

  const stdio = jsonMode ? ['ignore', 'pipe', 'pipe'] : 'inherit';
  const proc = spawn('node', nodeArgs, { cwd: repoRoot, env, stdio });

  let stdout = '';
  let stderr = '';
  if (jsonMode) {
    proc.stdout?.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr?.on('data', d => { stderr += d.toString('utf8'); });
  }

  const exitCode = await new Promise((resolve) => proc.on('close', code => resolve(code ?? 1)));
  const latest = readLatestVerifySummary(stateDirAbs);

  return { exitCode, latest, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Run the verify command.
 * @param {string[]} args
 * @param {Object} context
 * @returns {Promise<number>}
 */
export async function run(args, context) {
  const { logger, output, stateDir } = context;
  const verifyArgs = parseVerifyArgs(args);

  const repoRoot = resolveRepoRoot();
  const stateDirAbs = resolveStateDir(repoRoot, stateDir);

  logger.info('verify_start', 'Starting verification (delegating to verify/run.js)', { args: verifyArgs, repoRoot, stateDir: stateDirAbs });
  output.progress('Running verification gates via verify/run.js...');

  const { exitCode, latest, stdout, stderr } = await runVerifyScript({
    repoRoot,
    stateDirAbs,
    verifyArgs,
    jsonMode: output.jsonMode === true,
  });

  const ok = exitCode === 0;
  const result = latest?.summary
    ? latest.summary
    : {
        ok,
        exitCode,
        message: ok ? 'Verification completed.' : 'Verification failed.',
        details: output.jsonMode ? { stdout, stderr } : undefined,
      };

  if (ok) {
    logger.info('verify_complete', 'Verification passed', { exitCode, verifyRunId: latest?.verifyRunId });
    output.writeSuccess(result);
    return 0;
  }

  logger.error('verify_failed', 'Verification failed', { exitCode, verifyRunId: latest?.verifyRunId, summaryPath: latest?.summaryPath });
  output.writeError('VERIFY_FAILED', 'Verification failed', {
    exitCode,
    verifyRunId: latest?.verifyRunId,
    summaryPath: latest?.summaryPath,
    summary: latest?.summary ?? null,
    ...(output.jsonMode ? { stdout, stderr } : {}),
  });
  return exitCode || 1;
}

export default { run };
