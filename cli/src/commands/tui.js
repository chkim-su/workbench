/**
 * TUI command - Launch interactive TUI.
 *
 * Delegates to `scripts/workbench.sh tui` (Go Bubble Tea with Docker fallback, then Ink fallback).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Run the tui command.
 * @param {string[]} args
 * @param {Object} context
 * @returns {Promise<number>}
 */
export async function run(args, context) {
  const { logger, output, flags, headless } = context;
  logger.info('tui_start', 'Starting TUI (delegating to scripts/workbench.sh tui)', { args, headless });

  // Check for headless mode
  if (headless) {
    logger.warn('tui_headless', 'Cannot launch TUI in headless mode');
    output.writeError(
      'HEADLESS_MODE',
      'Cannot launch interactive TUI in headless mode (--no-tty)',
      { suggestion: 'Use specific commands like "verify" or "doctor" instead' }
    );
    return 1;
  }

  // Check for TTY
  if (!process.stdin.isTTY) {
    logger.warn('tui_no_tty', 'No TTY detected');
    output.writeError(
      'NO_TTY',
      'No TTY detected for interactive mode',
      { suggestion: 'Use "workbench dev start --mode B --json" for headless control' }
    );
    return 1;
  }

  if (flags.json) {
    output.writeSuccess({
      ok: true,
      interactive: true,
      message: 'Run without --json to launch the interactive TUI',
    });
    return 0;
  }

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'scripts', 'workbench.sh');

  return new Promise((resolve) => {
    const proc = spawn('bash', [script, 'tui', ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    proc.on('close', code => {
      logger.info('tui_exit', `tui exited with code ${code}`);
      resolve(code ?? 0);
    });

    proc.on('error', err => {
      logger.error('tui_error', `Failed to launch tui: ${err.message}`);
      output.writeError('LAUNCH_FAILED', `Failed to launch tui: ${err.message}`);
      resolve(1);
    });
  });
}

export default { run };
