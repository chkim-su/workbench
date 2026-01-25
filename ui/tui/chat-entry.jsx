#!/usr/bin/env bun
/**
 * Entry point for Ink-based Chat component
 * Launched from the main TUI when Chat is selected
 *
 * Uses alternate screen buffer to prevent flickering:
 * - Provides isolated drawing surface
 * - No interference with main scrollback
 * - Instant buffer switch (no visible clear)
 *
 * Debounces resize events to prevent flicker during window resize.
 */

import React from 'react';
import { render } from 'ink';
import Chat from './Chat.jsx';

// ANSI sequences for alternate screen buffer (flicker prevention)
const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H'; // Enter alt screen + cursor home
const EXIT_ALT_SCREEN = '\x1b[?1049l'; // Exit alt screen (restores main)
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Debounce resize events to prevent Ink's aggressive clear-on-resize
// Ink clears screen when width decreases, causing flicker during resize drag
const RESIZE_DEBOUNCE_MS = 100;
let resizeTimeout = null;
let lastCols = process.stdout.columns;
let lastRows = process.stdout.rows;
const originalEmit = process.stdout.emit.bind(process.stdout);
process.stdout.emit = function(event, ...args) {
  if (event === 'resize') {
    // Debounce resize events
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      // Only emit if size actually changed
      const newCols = process.stdout.columns;
      const newRows = process.stdout.rows;
      if (newCols !== lastCols || newRows !== lastRows) {
        lastCols = newCols;
        lastRows = newRows;
        originalEmit('resize', ...args);
      }
    }, RESIZE_DEBOUNCE_MS);
    return true;
  }
  return originalEmit(event, ...args);
};

// Enter alternate screen buffer before Ink starts rendering
process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);

// Ensure we exit alt screen on any exit path
function cleanup() {
  process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

const provider = process.env.WORKBENCH_PROVIDER || 'openai-oauth';

const { waitUntilExit } = render(
  <Chat
    provider={provider}
    onClose={() => {
      cleanup();
      process.exit(0);
    }}
  />,
  { exitOnCtrlC: false }
);

waitUntilExit().then(() => {
  cleanup();
  process.exit(0);
});
