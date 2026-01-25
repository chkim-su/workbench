/**
 * Output formatter for CLI responses.
 *
 * Features:
 * - JSON mode: structured envelope with schema version
 * - Human mode: clean progress messages
 * - Quiet mode: errors only
 */

const OUTPUT_SCHEMA_VERSION = 1;

/**
 * @typedef {Object} CLIResponse
 * @property {number} schemaVersion
 * @property {string} command
 * @property {string} timestamp
 * @property {number} duration_ms
 * @property {boolean} success
 * @property {any} [data]
 * @property {Object} [error]
 * @property {string} [error.code]
 * @property {string} [error.message]
 * @property {any} [error.details]
 * @property {string} [logs]
 */

/**
 * Output formatter class.
 */
export class OutputFormatter {
  /**
   * @param {Object} options
   * @param {boolean} [options.json] - JSON output mode
   * @param {boolean} [options.quiet] - Suppress non-essential output
   * @param {string} [options.logFile] - Path to log file for inclusion in response
   */
  constructor(options = {}) {
    this.jsonMode = options.json || process.env.WORKBENCH_JSON === '1';
    this.quiet = options.quiet || false;
    this.logFile = options.logFile || null;
    this.startTime = Date.now();
    this.command = '';
  }

  /**
   * Set the current command name.
   * @param {string} command
   */
  setCommand(command) {
    this.command = command;
    this.startTime = Date.now();
  }

  /**
   * Calculate duration since command start.
   * @returns {number}
   */
  _getDuration() {
    return Date.now() - this.startTime;
  }

  /**
   * Create a success response.
   * @param {any} data - Command-specific data
   * @returns {CLIResponse}
   */
  success(data) {
    const response = {
      schemaVersion: OUTPUT_SCHEMA_VERSION,
      command: this.command,
      timestamp: new Date().toISOString(),
      duration_ms: this._getDuration(),
      success: true,
      data,
    };

    if (this.logFile) {
      response.logs = this.logFile;
    }

    return response;
  }

  /**
   * Create an error response.
   * @param {string} code - Machine-readable error code
   * @param {string} message - Human-readable error message
   * @param {any} [details] - Additional error details
   * @returns {CLIResponse}
   */
  error(code, message, details) {
    const response = {
      schemaVersion: OUTPUT_SCHEMA_VERSION,
      command: this.command,
      timestamp: new Date().toISOString(),
      duration_ms: this._getDuration(),
      success: false,
      error: {
        code,
        message,
      },
    };

    if (details !== undefined) {
      response.error.details = details;
    }

    if (this.logFile) {
      response.logs = this.logFile;
    }

    return response;
  }

  /**
   * Write a success response to stdout.
   * @param {any} data - Command-specific data
   */
  writeSuccess(data) {
    const response = this.success(data);

    if (this.jsonMode) {
      console.log(JSON.stringify(response, null, 2));
    } else if (!this.quiet) {
      this._writeHumanSuccess(data);
    }
  }

  /**
   * Write an error response to stderr.
   * @param {string} code - Machine-readable error code
   * @param {string} message - Human-readable error message
   * @param {any} [details] - Additional error details
   */
  writeError(code, message, details) {
    const response = this.error(code, message, details);

    if (this.jsonMode) {
      console.error(JSON.stringify(response, null, 2));
    } else {
      console.error(`\x1b[31mError:\x1b[0m ${message}`);
      if (details && !this.quiet) {
        console.error(`Details: ${JSON.stringify(details, null, 2)}`);
      }
    }
  }

  /**
   * Write human-friendly success output.
   * @param {any} data
   */
  _writeHumanSuccess(data) {
    if (data === null || data === undefined) {
      console.log('\x1b[32mDone.\x1b[0m');
      return;
    }

    if (typeof data === 'string') {
      console.log(data);
      return;
    }

    if (typeof data === 'object') {
      // Handle common patterns
      if (data.message) {
        console.log(data.message);
      }

      if (data.status) {
        const statusColor = data.status === 'healthy' ? '\x1b[32m' : '\x1b[33m';
        console.log(`Status: ${statusColor}${data.status}\x1b[0m`);
      }

      if (data.gates && Array.isArray(data.gates)) {
        console.log('\nGates:');
        for (const gate of data.gates) {
          const icon = gate.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
          console.log(`  ${icon} ${gate.name}${gate.message ? `: ${gate.message}` : ''}`);
        }
      }

      if (data.checks && Array.isArray(data.checks)) {
        console.log('\nChecks:');
        for (const check of data.checks) {
          const icon = check.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
          console.log(`  ${icon} ${check.name}`);
        }
      }

      if (data.summary) {
        console.log(`\n${data.summary}`);
      }

      return;
    }

    // Fallback: stringify
    console.log(JSON.stringify(data, null, 2));
  }

  /**
   * Write a progress message (human mode only).
   * @param {string} message
   */
  progress(message) {
    if (!this.jsonMode && !this.quiet) {
      console.log(`\x1b[90m${message}\x1b[0m`);
    }
  }

  /**
   * Write a section header (human mode only).
   * @param {string} title
   */
  section(title) {
    if (!this.jsonMode && !this.quiet) {
      console.log(`\n\x1b[1m${title}\x1b[0m`);
    }
  }

  /**
   * Write a list of items (human mode only).
   * @param {string[]} items
   * @param {string} [prefix='  - ']
   */
  list(items, prefix = '  - ') {
    if (!this.jsonMode && !this.quiet) {
      for (const item of items) {
        console.log(`${prefix}${item}`);
      }
    }
  }

  /**
   * Write a key-value pair (human mode only).
   * @param {string} key
   * @param {string} value
   */
  keyValue(key, value) {
    if (!this.jsonMode && !this.quiet) {
      console.log(`  \x1b[90m${key}:\x1b[0m ${value}`);
    }
  }

  /**
   * Write a newline (human mode only).
   */
  newline() {
    if (!this.jsonMode && !this.quiet) {
      console.log('');
    }
  }
}

/**
 * Create an output formatter with the given options.
 * @param {Object} options
 * @returns {OutputFormatter}
 */
export function createOutput(options = {}) {
  return new OutputFormatter(options);
}

export default OutputFormatter;
