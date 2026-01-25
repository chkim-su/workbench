#!/usr/bin/env node

/**
 * My LLM Workbench CLI - Main dispatcher
 *
 * CLI-first interface for controlling the workbench.
 *
 * Global Flags:
 *   --json               Machine-parseable JSON output
 *   --quiet, -q          Suppress non-essential output
 *   --log-level <level>  debug|info|warn|error (default: info)
 *   --log-file <path>    Override log path
 *   --no-tty             Force headless mode
 *   --state-dir <path>   Override state directory
 *
 * Commands:
 *   tui                  Launch interactive TUI (default)
 *   doctor               Probe environment capabilities
 *   verify [--full]      Run verification gates
 *   workflow <action>    Workflow operations
 *   state <action>       State inspection
 *   logs [--follow]      View/tail logs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { Logger, getLogger } from './logger.js';
import { OutputFormatter, createOutput } from './output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package version
const packageJsonPath = path.join(__dirname, '..', 'package.json');
let VERSION = '0.1.0';
try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  VERSION = pkg.version || VERSION;
} catch {
  // Use default version
}

/**
 * Parse command-line arguments.
 * @param {string[]} args
 * @returns {Object}
 */
function parseArgs(args) {
  const result = {
    command: null,
    commandArgs: [],
    flags: {
      json: false,
      quiet: false,
      logLevel: 'info',
      logFile: null,
      noTty: false,
      stateDir: null,
      help: false,
      version: false,
    },
  };

  // Global flags that can appear anywhere (before or after command)
  const globalFlags = new Set(['--json', '--quiet', '-q', '--no-tty', '--help', '-h', '--version', '-v']);
  const globalFlagsWithValue = new Set(['--log-level', '--log-file', '--state-dir']);

  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // Check for global flags (can appear anywhere)
    if (arg === '--json') {
      result.flags.json = true;
      i++;
    } else if (arg === '--quiet' || arg === '-q') {
      result.flags.quiet = true;
      i++;
    } else if (arg === '--log-level') {
      result.flags.logLevel = args[++i] || 'info';
      i++;
    } else if (arg === '--log-file') {
      result.flags.logFile = args[++i];
      i++;
    } else if (arg === '--no-tty') {
      result.flags.noTty = true;
      i++;
    } else if (arg === '--state-dir') {
      result.flags.stateDir = args[++i];
      i++;
    } else if (arg === '--help' || arg === '-h') {
      result.flags.help = true;
      i++;
    } else if (arg === '--version' || arg === '-v') {
      result.flags.version = true;
      i++;
    } else if (arg.startsWith('-')) {
      // Unknown flag - pass to command
      result.commandArgs.push(arg);
      i++;
    } else if (!result.command) {
      // First non-flag argument is command name
      result.command = arg;
      i++;
    } else {
      // Subsequent non-flag arguments are command args
      result.commandArgs.push(arg);
      i++;
    }
  }

  // Apply environment variable overrides
  if (process.env.WORKBENCH_JSON === '1') {
    result.flags.json = true;
  }
  if (process.env.WORKBENCH_HEADLESS === '1') {
    result.flags.noTty = true;
  }
  if (process.env.WORKBENCH_LOG_LEVEL) {
    result.flags.logLevel = process.env.WORKBENCH_LOG_LEVEL;
  }
  if (process.env.WORKBENCH_LOG_FILE) {
    result.flags.logFile = process.env.WORKBENCH_LOG_FILE;
  }
  if (process.env.WORKBENCH_STATE_DIR) {
    result.flags.stateDir = process.env.WORKBENCH_STATE_DIR;
  }

  return result;
}

/**
 * Show help message.
 * @param {OutputFormatter} output
 */
function showHelp(output) {
  const helpText = `
My LLM Workbench CLI v${VERSION}

Usage: workbench [global-flags] <command> [command-flags]

Global Flags:
  --json               Machine-parseable JSON output
  --quiet, -q          Suppress non-essential output
  --log-level <level>  debug|info|warn|error (default: info)
  --log-file <path>    Override log path (default: .workbench/logs/cli.jsonl)
  --no-tty             Force headless mode
  --state-dir <path>   Override state directory
  --help, -h           Show this help message
  --version, -v        Show version

Commands:
  tui                  Launch interactive TUI (default)
  doctor               Probe environment capabilities
  verify [--full]      Run verification gates
  workflow <action>    Workflow operations (status, init, cancel)
  state <action>       State inspection (show, export, clear)
  logs [--follow]      View/tail logs

Environment Variables:
  WORKBENCH_STATE_DIR      Override .workbench location
  WORKBENCH_LOG_LEVEL      Default log level
  WORKBENCH_LOG_FILE       Override log file path
  WORKBENCH_HEADLESS       Force headless mode (1=true)
  WORKBENCH_JSON           Force JSON output (1=true)

Examples:
  workbench                          # Launch TUI (default)
  workbench doctor --json            # Check environment, JSON output
  workbench verify --full --json     # Run full verification
  workbench logs --follow            # Tail log file
  workbench workflow status          # Show workflow status
`;

  if (output.jsonMode) {
    output.writeSuccess({ help: helpText.trim() });
  } else {
    console.log(helpText);
  }
}

/**
 * Show version.
 * @param {OutputFormatter} output
 */
function showVersion(output) {
  if (output.jsonMode) {
    output.writeSuccess({ version: VERSION });
  } else {
    console.log(`workbench v${VERSION}`);
  }
}

/**
 * Load and run a command.
 * @param {string} name
 * @param {string[]} args
 * @param {Object} context
 * @returns {Promise<number>}
 */
async function runCommand(name, args, context) {
  const { logger, output } = context;

  const commandPath = path.join(__dirname, 'commands', `${name}.js`);

  if (!fs.existsSync(commandPath)) {
    logger.error('command_not_found', `Unknown command: ${name}`);
    output.writeError('UNKNOWN_COMMAND', `Unknown command: ${name}`, {
      command: name,
      availableCommands: ['tui', 'doctor', 'verify', 'workflow', 'state', 'logs'],
    });
    return 1;
  }

  try {
    const module = await import(commandPath);
    const command = module.default || module;

    if (typeof command.run !== 'function') {
      throw new Error(`Command ${name} does not export a run function`);
    }

    return await command.run(args, context);
  } catch (err) {
    logger.error('command_failed', `Command ${name} failed: ${err.message}`, {
      error: err.stack,
    });
    output.writeError('COMMAND_FAILED', err.message, {
      command: name,
      stack: err.stack,
    });
    return 1;
  }
}

/**
 * Main entry point.
 */
async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  // Initialize logger
  const logger = new Logger({
    stateDir: parsed.flags.stateDir,
    consoleLevel: parsed.flags.logLevel,
    logFile: parsed.flags.logFile,
  });

  // In JSON mode, suppress all console output from logger
  if (parsed.flags.quiet || parsed.flags.json) {
    logger.setQuiet(true);
  }

  // Initialize output formatter
  const output = createOutput({
    json: parsed.flags.json,
    quiet: parsed.flags.quiet,
    logFile: logger.getLogFilePath(),
  });

  // Build context for commands
  const context = {
    logger,
    output,
    flags: parsed.flags,
    stateDir: parsed.flags.stateDir || '.workbench',
    headless: parsed.flags.noTty,
  };

  // Log command invocation
  logger.info('cli_start', `CLI invoked: ${args.join(' ')}`, {
    command: parsed.command,
    flags: parsed.flags,
    args: parsed.commandArgs,
  });

  // Handle --version
  if (parsed.flags.version) {
    output.setCommand('version');
    showVersion(output);
    return 0;
  }

  // Handle --help
  if (parsed.flags.help) {
    output.setCommand('help');
    showHelp(output);
    return 0;
  }

  // Default command is 'tui'
  const command = parsed.command || 'tui';
  output.setCommand(command);

  // Run the command
  const exitCode = await runCommand(command, parsed.commandArgs, context);

  logger.info('cli_end', `CLI completed with exit code ${exitCode}`, {
    command,
    exitCode,
  });

  return exitCode;
}

// Run main and exit with appropriate code
main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
