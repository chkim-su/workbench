/**
 * Claude Code Provider
 * Checks Claude Code CLI availability and provides model configuration
 */

import { spawn } from 'node:child_process';

/**
 * Check if Claude Code CLI is available
 * @returns {Promise<{available: boolean, version: string|null, path: string|null}>}
 */
export function checkClaudeCode() {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));

    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('Claude Code')) {
        const version = stdout.trim().split(' ')[0] || null;
        resolve({ available: true, version, path: 'claude' });
      } else {
        resolve({ available: false, version: null, path: null });
      }
    });

    proc.on('error', () => {
      resolve({ available: false, version: null, path: null });
    });
  });
}

/**
 * Available Claude Code models
 */
export const CLAUDE_MODELS = [
  { label: 'Claude Sonnet (fast, balanced)', value: 'sonnet' },
  { label: 'Claude Opus (powerful, slower)', value: 'opus' },
  { label: 'Claude Haiku (fastest, lightweight)', value: 'haiku' },
];
