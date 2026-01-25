/**
 * State command - State inspection and management.
 *
 * Subcommands:
 *   show               Show current state summary
 *   export [path]      Export state to file
 *   clear              Clear all state (with confirmation)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Parse command-line arguments for state command.
 * @param {string[]} args
 * @returns {Object}
 */
function parseStateArgs(args) {
  const result = {
    action: args[0] || 'show',
    path: null,
    force: false,
    sessionId: process.env.CSC_SESSION_ID,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force' || arg === '-f') {
      result.force = true;
    } else if (arg === '--session-id' || arg === '-s') {
      result.sessionId = args[++i];
    } else if (!arg.startsWith('-')) {
      result.path = arg;
    }
  }

  return result;
}

/**
 * Get the workflows root directory.
 * @returns {string}
 */
function getWorkflowsRoot() {
  return process.env.WORKFLOWS_ROOT || path.join(process.env.HOME || '', '.claude', 'local', 'workflows');
}

/**
 * Recursively get directory size.
 * @param {string} dir
 * @returns {number}
 */
function getDirSize(dir) {
  if (!fs.existsSync(dir)) {
    return 0;
  }

  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      try {
        const stats = fs.statSync(fullPath);
        size += stats.size;
      } catch {
        // Ignore unreadable files
      }
    }
  }

  return size;
}

/**
 * Format bytes to human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Show state summary.
 * @param {Object} context
 * @param {Object} args
 * @returns {Promise<Object>}
 */
async function showState(context, args) {
  const { logger, stateDir } = context;
  const workflowsRoot = getWorkflowsRoot();

  const result = {
    stateDir,
    workflowsRoot,
    directories: {},
    sessions: [],
    totalSize: 0,
  };

  // Check state directory
  if (fs.existsSync(stateDir)) {
    const logsDir = path.join(stateDir, 'logs');
    result.directories.state = {
      path: stateDir,
      exists: true,
      size: getDirSize(stateDir),
    };
    result.directories.logs = {
      path: logsDir,
      exists: fs.existsSync(logsDir),
      size: fs.existsSync(logsDir) ? getDirSize(logsDir) : 0,
    };
    result.totalSize += result.directories.state.size;
  } else {
    result.directories.state = {
      path: stateDir,
      exists: false,
      size: 0,
    };
  }

  // Check workflows root
  if (fs.existsSync(workflowsRoot)) {
    const entries = fs.readdirSync(workflowsRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDir = path.join(workflowsRoot, entry.name);
        const stateFile = path.join(sessionDir, 'workflow-daemon-state.json');

        const session = {
          id: entry.name,
          path: sessionDir,
          size: getDirSize(sessionDir),
          hasStateFile: fs.existsSync(stateFile),
        };

        // Try to read last modified time
        try {
          const stats = fs.statSync(sessionDir);
          session.lastModified = stats.mtime.toISOString();
        } catch {
          // Ignore
        }

        // Try to read workflow count from state file
        if (session.hasStateFile) {
          try {
            const stateContent = fs.readFileSync(stateFile, 'utf8');
            const state = JSON.parse(stateContent);
            session.workflowCount = state.workflows ? Object.keys(state.workflows).length : 0;
          } catch {
            session.workflowCount = 0;
          }
        }

        result.sessions.push(session);
        result.totalSize += session.size;
      }
    }
  }

  result.totalSizeFormatted = formatBytes(result.totalSize);
  result.sessionCount = result.sessions.length;

  return result;
}

/**
 * Export state to file.
 * @param {Object} context
 * @param {Object} args
 * @returns {Promise<Object>}
 */
async function exportState(context, args) {
  const { logger, stateDir } = context;
  const workflowsRoot = getWorkflowsRoot();

  const exportPath = args.path || `workbench-state-${Date.now()}.json`;

  const exportData = {
    exportedAt: new Date().toISOString(),
    stateDir,
    workflowsRoot,
    sessions: {},
    logs: null,
  };

  // Export session data
  if (fs.existsSync(workflowsRoot)) {
    const entries = fs.readdirSync(workflowsRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDir = path.join(workflowsRoot, entry.name);
        const stateFile = path.join(sessionDir, 'workflow-daemon-state.json');

        if (fs.existsSync(stateFile)) {
          try {
            const stateContent = fs.readFileSync(stateFile, 'utf8');
            exportData.sessions[entry.name] = JSON.parse(stateContent);
          } catch {
            exportData.sessions[entry.name] = { error: 'Could not parse state file' };
          }
        }
      }
    }
  }

  // Export recent logs
  const logsDir = path.join(stateDir, 'logs');
  const logFile = path.join(logsDir, 'cli.jsonl');
  if (fs.existsSync(logFile)) {
    try {
      const logContent = fs.readFileSync(logFile, 'utf8');
      const lines = logContent.trim().split('\n').slice(-100); // Last 100 entries
      exportData.logs = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    } catch {
      exportData.logs = [];
    }
  }

  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf8');

  return {
    success: true,
    message: `State exported to ${exportPath}`,
    path: exportPath,
    sessionCount: Object.keys(exportData.sessions).length,
    logEntries: exportData.logs?.length || 0,
  };
}

/**
 * Clear all state.
 * @param {Object} context
 * @param {Object} args
 * @returns {Promise<Object>}
 */
async function clearState(context, args) {
  const { logger, stateDir, output, headless } = context;
  const workflowsRoot = getWorkflowsRoot();

  // Require confirmation unless forced
  if (!args.force && !headless) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const confirmed = await new Promise((resolve) => {
      rl.question('Are you sure you want to clear all state? (yes/no): ', (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
      });
    });

    if (!confirmed) {
      return {
        success: false,
        message: 'Operation cancelled',
      };
    }
  } else if (!args.force && headless) {
    throw new Error('Cannot clear state in headless mode without --force flag');
  }

  let cleared = {
    stateDir: false,
    workflowsRoot: false,
  };

  // Clear state directory
  if (fs.existsSync(stateDir)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    cleared.stateDir = true;
    logger.info('state_cleared', `Cleared state directory: ${stateDir}`);
  }

  // Clear workflows root
  if (fs.existsSync(workflowsRoot)) {
    fs.rmSync(workflowsRoot, { recursive: true, force: true });
    cleared.workflowsRoot = true;
    logger.info('state_cleared', `Cleared workflows root: ${workflowsRoot}`);
  }

  return {
    success: true,
    message: 'State cleared',
    cleared,
  };
}

/**
 * Run the state command.
 * @param {string[]} args
 * @param {Object} context
 * @returns {Promise<number>}
 */
export async function run(args, context) {
  const { logger, output } = context;
  const stateArgs = parseStateArgs(args);

  logger.info('state_start', `State action: ${stateArgs.action}`, stateArgs);

  try {
    let result;

    switch (stateArgs.action) {
      case 'show':
        output.progress('Gathering state information...');
        result = await showState(context, stateArgs);
        break;

      case 'export':
        output.progress('Exporting state...');
        result = await exportState(context, stateArgs);
        break;

      case 'clear':
        output.progress('Clearing state...');
        result = await clearState(context, stateArgs);
        break;

      default:
        throw new Error(`Unknown state action: ${stateArgs.action}. Valid actions: show, export, clear`);
    }

    logger.info('state_complete', `State action ${stateArgs.action} completed`, result);
    output.writeSuccess(result);
    return result.success === false ? 1 : 0;

  } catch (err) {
    logger.error('state_error', `State action failed: ${err.message}`);
    output.writeError('STATE_ERROR', err.message);
    return 1;
  }
}

export default { run };
