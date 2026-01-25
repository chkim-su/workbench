/**
 * Logs command - View and tail log files.
 *
 * Options:
 *   --follow, -f       Continuously follow new log entries
 *   --lines, -n <num>  Number of lines to show (default: 50)
 *   --level <level>    Filter by log level (debug|info|warn|error)
 *   --component <c>    Filter by component name
 *   --since <time>     Show logs since time (e.g., "1h", "30m", ISO date)
 *   --raw              Show raw JSONL without formatting
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Parse command-line arguments for logs command.
 * @param {string[]} args
 * @returns {Object}
 */
function parseLogsArgs(args) {
  const result = {
    follow: false,
    lines: 50,
    level: null,
    component: null,
    since: null,
    raw: false,
    logFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--follow' || arg === '-f') {
      result.follow = true;
    } else if (arg === '--lines' || arg === '-n') {
      result.lines = parseInt(args[++i], 10) || 50;
    } else if (arg === '--level') {
      result.level = args[++i];
    } else if (arg === '--component') {
      result.component = args[++i];
    } else if (arg === '--since') {
      result.since = args[++i];
    } else if (arg === '--raw') {
      result.raw = true;
    } else if (!arg.startsWith('-')) {
      result.logFile = arg;
    }
  }

  return result;
}

/**
 * Parse time string to Date.
 * @param {string} timeStr - Time string like "1h", "30m", "2d", or ISO date
 * @returns {Date|null}
 */
function parseTime(timeStr) {
  if (!timeStr) return null;

  // Try ISO date first
  const isoDate = new Date(timeStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }

  // Parse relative time
  const match = timeStr.match(/^(\d+)([smhd])$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const now = new Date();

    switch (unit) {
      case 's': return new Date(now.getTime() - value * 1000);
      case 'm': return new Date(now.getTime() - value * 60 * 1000);
      case 'h': return new Date(now.getTime() - value * 60 * 60 * 1000);
      case 'd': return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    }
  }

  return null;
}

/**
 * Format a log entry for human display.
 * @param {Object} entry
 * @returns {string}
 */
function formatEntry(entry) {
  const levelColors = {
    debug: '\x1b[90m',
    info: '\x1b[34m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
  };

  const reset = '\x1b[0m';
  const color = levelColors[entry.level] || '';

  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString()
    : '??:??:??';

  const level = (entry.level || 'info').padEnd(5);
  const component = (entry.component || 'cli').padEnd(10);
  const event = (entry.event || '-').padEnd(20);

  return `${color}${time} [${level}] ${component} ${event}${reset} ${entry.message}`;
}

/**
 * Read and filter log lines.
 * @param {string} logFile
 * @param {Object} filters
 * @param {number} maxLines
 * @returns {Object[]}
 */
function readLogLines(logFile, filters, maxLines) {
  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);

  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Apply filters
      if (filters.level && entry.level !== filters.level) continue;
      if (filters.component && entry.component !== filters.component) continue;
      if (filters.since) {
        const entryTime = new Date(entry.timestamp);
        if (entryTime < filters.since) continue;
      }

      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  // Return last N entries
  return entries.slice(-maxLines);
}

/**
 * Follow log file for new entries.
 * @param {string} logFile
 * @param {Object} filters
 * @param {boolean} raw
 */
async function followLog(logFile, filters, raw) {
  let lastSize = 0;
  let lastInode = null;

  // Track file size to detect new content
  const checkForNewContent = () => {
    if (!fs.existsSync(logFile)) {
      return;
    }

    const stats = fs.statSync(logFile);

    // Check if file was rotated (different inode)
    if (lastInode && stats.ino !== lastInode) {
      lastSize = 0;
      lastInode = stats.ino;
    } else {
      lastInode = stats.ino;
    }

    if (stats.size > lastSize) {
      // Read new content
      const fd = fs.openSync(logFile, 'r');
      const buffer = Buffer.alloc(stats.size - lastSize);
      fs.readSync(fd, buffer, 0, buffer.length, lastSize);
      fs.closeSync(fd);

      const newContent = buffer.toString('utf8');
      const lines = newContent.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Apply filters
          if (filters.level && entry.level !== filters.level) continue;
          if (filters.component && entry.component !== filters.component) continue;

          if (raw) {
            console.log(line);
          } else {
            console.log(formatEntry(entry));
          }
        } catch {
          // Print raw line if not valid JSON
          console.log(line);
        }
      }

      lastSize = stats.size;
    }
  };

  // Initial check
  checkForNewContent();

  // Poll for changes
  console.log('\x1b[90m--- Following log file (Ctrl+C to stop) ---\x1b[0m');

  const interval = setInterval(checkForNewContent, 500);

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\n\x1b[90m--- Stopped following ---\x1b[0m');
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Run the logs command.
 * @param {string[]} args
 * @param {Object} context
 * @returns {Promise<number>}
 */
export async function run(args, context) {
  const { logger, output, stateDir, flags } = context;
  const logsArgs = parseLogsArgs(args);

  // Determine log file path
  const logFile = logsArgs.logFile || path.join(stateDir, 'logs', 'cli.jsonl');

  logger.debug('logs_start', 'Reading logs', { logFile, args: logsArgs });

  // Check if log file exists
  if (!fs.existsSync(logFile)) {
    if (flags.json) {
      output.writeSuccess({
        logFile,
        entries: [],
        message: 'Log file does not exist yet',
      });
    } else {
      console.log(`Log file does not exist: ${logFile}`);
      console.log('Logs will be created when CLI commands are run.');
    }
    return 0;
  }

  // Build filters
  const filters = {
    level: logsArgs.level,
    component: logsArgs.component,
    since: parseTime(logsArgs.since),
  };

  // Follow mode
  if (logsArgs.follow && !flags.json) {
    await followLog(logFile, filters, logsArgs.raw);
    return 0;
  }

  // Read entries
  const entries = readLogLines(logFile, filters, logsArgs.lines);

  if (flags.json) {
    output.writeSuccess({
      logFile,
      entries,
      filters: {
        level: logsArgs.level,
        component: logsArgs.component,
        since: logsArgs.since,
      },
      count: entries.length,
    });
  } else {
    if (entries.length === 0) {
      console.log('No log entries found matching filters.');
    } else {
      for (const entry of entries) {
        if (logsArgs.raw) {
          console.log(JSON.stringify(entry));
        } else {
          console.log(formatEntry(entry));
        }
      }
      console.log(`\n\x1b[90m--- Showing ${entries.length} entries from ${logFile} ---\x1b[0m`);
    }
  }

  return 0;
}

export default { run };
