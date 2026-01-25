/**
 * Doctor command - Probe environment capabilities.
 *
 * Checks for required dependencies and environment configuration.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Run a shell command and capture output.
 * @param {string} command
 * @param {string[]} args
 * @param {Object} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number}>}
 */
function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      timeout: options.timeout || 10000,
      shell: false,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', data => { stdout += data.toString(); });
    proc.stderr?.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? -1,
      });
    });

    proc.on('error', err => {
      resolve({
        ok: false,
        stdout: '',
        stderr: err.message,
        code: -1,
      });
    });
  });
}

/**
 * Check if a command exists in PATH.
 * @param {string} command
 * @returns {Promise<{ok: boolean, path?: string, version?: string}>}
 */
async function checkCommand(command) {
  const which = await runCommand('which', [command]);
  if (!which.ok) {
    return { ok: false };
  }

  const cmdPath = which.stdout;

  // Try to get version
  const versionResult = await runCommand(command, ['--version']);
  const version = versionResult.ok
    ? versionResult.stdout.split('\n')[0]
    : undefined;

  return { ok: true, path: cmdPath, version };
}

/**
 * Check Python package installation.
 * @param {string} packageName
 * @returns {Promise<{ok: boolean, version?: string}>}
 */
async function checkPythonPackage(packageName) {
  const result = await runCommand('python3', ['-c', `import ${packageName}; print(${packageName}.__version__ if hasattr(${packageName}, '__version__') else 'installed')`]);
  if (result.ok) {
    return { ok: true, version: result.stdout };
  }
  return { ok: false };
}

/**
 * Check if a port is available.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function checkPort(port) {
  const result = await runCommand('python3', ['-c', `
import socket
s = socket.socket()
try:
    s.bind(('127.0.0.1', ${port}))
    s.close()
    print('available')
except:
    print('in_use')
`]);
  return result.ok && result.stdout === 'available';
}

/**
 * Check workflow daemon health.
 * @param {string} url
 * @returns {Promise<{ok: boolean, status?: string}>}
 */
async function checkDaemonHealth(url) {
  const result = await runCommand('python3', ['-c', `
import urllib.request
import json
try:
    with urllib.request.urlopen('${url}/health', timeout=2) as resp:
        data = json.loads(resp.read())
        print(data.get('status', 'unknown'))
except Exception as e:
    print('error:' + str(e))
`]);

  if (result.ok && result.stdout === 'healthy') {
    return { ok: true, status: 'healthy' };
  }
  return { ok: false, status: result.stdout };
}

/**
 * Run the doctor command.
 * @param {string[]} args
 * @param {Object} context
 * @returns {Promise<number>}
 */
export async function run(args, context) {
  const { logger, output, flags } = context;

  logger.info('doctor_start', 'Starting environment check');
  output.progress('Checking environment...');

  const checks = [];

  // System info
  const systemInfo = {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    homeDir: os.homedir(),
  };

  // Check required commands
  output.progress('Checking required commands...');

  const requiredCommands = ['python3', 'tmux', 'node'];
  for (const cmd of requiredCommands) {
    const result = await checkCommand(cmd);
    checks.push({
      name: cmd,
      type: 'command',
      ok: result.ok,
      message: result.ok ? result.version : 'Not found',
      path: result.path,
    });
    logger.debug('check_command', `${cmd}: ${result.ok ? 'found' : 'not found'}`, result);
  }

  // Check optional commands
  output.progress('Checking optional commands...');

  const optionalCommands = ['docker', 'claude', 'uv'];
  for (const cmd of optionalCommands) {
    const result = await checkCommand(cmd);
    checks.push({
      name: cmd,
      type: 'optional_command',
      ok: result.ok,
      message: result.ok ? result.version : 'Not installed (optional)',
      path: result.path,
    });
    logger.debug('check_optional', `${cmd}: ${result.ok ? 'found' : 'not found'}`, result);
  }

  // Check Python packages
  output.progress('Checking Python packages...');

  const requiredPackages = ['fastapi', 'uvicorn', 'pydantic'];
  for (const pkg of requiredPackages) {
    const result = await checkPythonPackage(pkg);
    checks.push({
      name: `python:${pkg}`,
      type: 'python_package',
      ok: result.ok,
      message: result.ok ? `v${result.version}` : 'Not installed',
    });
    logger.debug('check_package', `${pkg}: ${result.ok ? 'installed' : 'not installed'}`, result);
  }

  // Check state directory
  output.progress('Checking state directory...');

  const stateDir = context.stateDir;
  const stateDirExists = fs.existsSync(stateDir);
  checks.push({
    name: 'state_directory',
    type: 'filesystem',
    ok: stateDirExists || true, // Will be created if needed
    message: stateDirExists ? `Exists: ${stateDir}` : `Will be created: ${stateDir}`,
  });

  // Check default daemon port
  output.progress('Checking daemon port...');

  const defaultPort = parseInt(process.env.WORKFLOW_ENGINE_PORT || '8766', 10);
  const portAvailable = await checkPort(defaultPort);
  checks.push({
    name: 'daemon_port',
    type: 'network',
    ok: true,
    message: portAvailable ? `Port ${defaultPort} available` : `Port ${defaultPort} in use`,
    port: defaultPort,
    available: portAvailable,
  });

  // Check daemon health if running
  output.progress('Checking daemon health...');

  const daemonUrl = process.env.WORKFLOW_ENGINE_URL || `http://127.0.0.1:${defaultPort}`;
  const daemonHealth = await checkDaemonHealth(daemonUrl);
  checks.push({
    name: 'workflow_daemon',
    type: 'service',
    ok: daemonHealth.ok,
    message: daemonHealth.ok ? 'Running and healthy' : 'Not running',
    url: daemonUrl,
    status: daemonHealth.status,
  });

  // Summary
  const requiredChecks = checks.filter(c => c.type === 'command' || c.type === 'python_package');
  const allRequiredOk = requiredChecks.every(c => c.ok);
  const failedRequired = requiredChecks.filter(c => !c.ok);

  const summary = allRequiredOk
    ? 'All required dependencies are installed.'
    : `Missing required dependencies: ${failedRequired.map(c => c.name).join(', ')}`;

  const result = {
    status: allRequiredOk ? 'healthy' : 'unhealthy',
    system: systemInfo,
    checks,
    summary,
  };

  logger.info('doctor_complete', summary, { checksCount: checks.length, allRequiredOk });

  output.writeSuccess(result);

  return allRequiredOk ? 0 : 1;
}

export default { run };
