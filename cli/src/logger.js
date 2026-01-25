/**
 * Always-on structured logging for CLI operations.
 *
 * Features:
 * - Writes to .workbench/logs/cli.jsonl regardless of verbosity
 * - Log rotation (10MB max, 5 files)
 * - Secret redaction (API keys, tokens, passwords)
 * - Schema versioning for all entries
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LOG_SCHEMA_VERSION = 1;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 5;

// Keys that should have their values redacted
const REDACT_KEYS = new Set([
  'authorization',
  'api_key',
  'apikey',
  'api-key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'password',
  'secret',
  'credential',
  'bearer',
  'token',
  'private_key',
  'privatekey',
]);

// Patterns that indicate sensitive data in string values
const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /sk-[A-Za-z0-9]{20,}/g,         // OpenAI
  /sk-ant-[A-Za-z0-9-]+/g,        // Anthropic
  /ghp_[A-Za-z0-9]{36}/g,         // GitHub PAT
  /gho_[A-Za-z0-9]{36}/g,         // GitHub OAuth
  /xox[baprs]-[A-Za-z0-9-]+/g,    // Slack tokens
  /AIza[A-Za-z0-9_-]{35}/g,       // Google API
  /[A-Za-z0-9+/]{40,}={0,2}/g,    // Base64 encoded secrets (40+ chars)
];

/**
 * @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel
 */

/**
 * @typedef {Object} LogEntry
 * @property {number} schemaVersion
 * @property {LogLevel} level
 * @property {string} timestamp
 * @property {string} sessionId
 * @property {string} component
 * @property {string} event
 * @property {string} message
 * @property {any} [data]
 * @property {boolean} [redacted]
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Redact sensitive values from an object recursively.
 * @param {any} obj - Object to redact
 * @param {Set<any>} [seen] - Set to track circular references
 * @returns {any} - Redacted object
 */
function redactSensitive(obj, seen = new Set()) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    let result = obj;
    for (const pattern of REDACT_PATTERNS) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  // Handle circular references
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitive(item, seen));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (REDACT_KEYS.has(lowerKey)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitive(value, seen);
    }
  }

  return result;
}

/**
 * Logger class for structured, always-on logging.
 */
export class Logger {
  /**
   * @param {Object} options
   * @param {string} [options.stateDir] - State directory (default: .workbench)
   * @param {LogLevel} [options.consoleLevel] - Minimum level for console output
   * @param {string} [options.logFile] - Override log file path
   * @param {string} [options.sessionId] - Session identifier
   * @param {string} [options.component] - Component name
   */
  constructor(options = {}) {
    this.stateDir = options.stateDir || process.env.WORKBENCH_STATE_DIR || '.workbench';
    this.consoleLevel = options.consoleLevel || process.env.WORKBENCH_LOG_LEVEL || 'info';
    this.logFile = options.logFile || process.env.WORKBENCH_LOG_FILE || null;
    this.sessionId = options.sessionId || this._generateSessionId();
    this.component = options.component || 'cli';
    this.quiet = false;

    this._ensureLogDir();
  }

  /**
   * Generate a unique session ID.
   * @returns {string}
   */
  _generateSessionId() {
    return `cli-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Get the log directory path.
   * @returns {string}
   */
  _getLogDir() {
    return path.join(this.stateDir, 'logs');
  }

  /**
   * Get the main log file path.
   * @returns {string}
   */
  _getLogFilePath() {
    if (this.logFile) {
      return this.logFile;
    }
    return path.join(this._getLogDir(), 'cli.jsonl');
  }

  /**
   * Ensure log directory exists.
   */
  _ensureLogDir() {
    const logDir = this._getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Rotate log files if needed.
   */
  _rotateIfNeeded() {
    const logPath = this._getLogFilePath();

    if (!fs.existsSync(logPath)) {
      return;
    }

    const stats = fs.statSync(logPath);
    if (stats.size < MAX_LOG_SIZE) {
      return;
    }

    // Rotate existing files
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const oldPath = `${logPath}.${i}`;
      const newPath = `${logPath}.${i + 1}`;
      if (fs.existsSync(oldPath)) {
        if (i === MAX_LOG_FILES - 1) {
          fs.unlinkSync(oldPath);
        } else {
          fs.renameSync(oldPath, newPath);
        }
      }
    }

    // Move current log to .1
    fs.renameSync(logPath, `${logPath}.1`);
  }

  /**
   * Write a log entry to file.
   * @param {LogEntry} entry
   */
  _writeToFile(entry) {
    try {
      this._rotateIfNeeded();
      const logPath = this._getLogFilePath();
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(logPath, line, 'utf8');
    } catch (err) {
      // Silently fail file logging to avoid breaking CLI
      if (process.env.WORKBENCH_DEBUG) {
        console.error('[Logger] Failed to write log:', err.message);
      }
    }
  }

  /**
   * Write a log entry to console if level meets threshold.
   * @param {LogLevel} level
   * @param {string} message
   */
  _writeToConsole(level, message) {
    if (this.quiet) {
      return;
    }

    const currentLevel = LOG_LEVELS[level];
    const thresholdLevel = LOG_LEVELS[this.consoleLevel] ?? LOG_LEVELS.info;

    if (currentLevel < thresholdLevel) {
      return;
    }

    const prefix = {
      debug: '\x1b[90m[debug]\x1b[0m',
      info: '\x1b[34m[info]\x1b[0m',
      warn: '\x1b[33m[warn]\x1b[0m',
      error: '\x1b[31m[error]\x1b[0m',
    };

    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${prefix[level]} ${message}\n`);
  }

  /**
   * Create a log entry.
   * @param {LogLevel} level
   * @param {string} event
   * @param {string} message
   * @param {any} [data]
   * @returns {LogEntry}
   */
  _createEntry(level, event, message, data) {
    const entry = {
      schemaVersion: LOG_SCHEMA_VERSION,
      level,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      component: this.component,
      event,
      message,
    };

    if (data !== undefined) {
      const redacted = redactSensitive(data);
      entry.data = redacted;
      if (JSON.stringify(data) !== JSON.stringify(redacted)) {
        entry.redacted = true;
      }
    }

    return entry;
  }

  /**
   * Log a message.
   * @param {LogLevel} level
   * @param {string} event
   * @param {string} message
   * @param {any} [data]
   */
  log(level, event, message, data) {
    const entry = this._createEntry(level, event, message, data);
    this._writeToFile(entry);
    this._writeToConsole(level, message);
  }

  /**
   * Log debug message.
   * @param {string} event
   * @param {string} message
   * @param {any} [data]
   */
  debug(event, message, data) {
    this.log('debug', event, message, data);
  }

  /**
   * Log info message.
   * @param {string} event
   * @param {string} message
   * @param {any} [data]
   */
  info(event, message, data) {
    this.log('info', event, message, data);
  }

  /**
   * Log warning message.
   * @param {string} event
   * @param {string} message
   * @param {any} [data]
   */
  warn(event, message, data) {
    this.log('warn', event, message, data);
  }

  /**
   * Log error message.
   * @param {string} event
   * @param {string} message
   * @param {any} [data]
   */
  error(event, message, data) {
    this.log('error', event, message, data);
  }

  /**
   * Create a child logger with a different component name.
   * @param {string} component
   * @returns {Logger}
   */
  child(component) {
    const child = new Logger({
      stateDir: this.stateDir,
      consoleLevel: this.consoleLevel,
      logFile: this.logFile,
      sessionId: this.sessionId,
      component,
    });
    child.quiet = this.quiet;
    return child;
  }

  /**
   * Set quiet mode (suppress console output).
   * @param {boolean} quiet
   */
  setQuiet(quiet) {
    this.quiet = quiet;
  }

  /**
   * Get the log file path for including in output.
   * @returns {string}
   */
  getLogFilePath() {
    return this._getLogFilePath();
  }
}

// Default logger instance
let defaultLogger = null;

/**
 * Get or create the default logger instance.
 * @param {Object} [options] - Options for creating logger
 * @returns {Logger}
 */
export function getLogger(options) {
  if (!defaultLogger) {
    defaultLogger = new Logger(options);
  }
  return defaultLogger;
}

/**
 * Reset the default logger (useful for testing).
 */
export function resetLogger() {
  defaultLogger = null;
}

export default Logger;
