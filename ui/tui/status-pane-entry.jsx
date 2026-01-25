#!/usr/bin/env bun
/**
 * Entry point for Status Pane
 * Launched in tmux side panes to show live status
 *
 * Uses alternate screen buffer to prevent flickering
 * Debounces resize events to prevent flicker during window resize
 */

import React from 'react';
import { render } from 'ink';
import StatusPane from './StatusPane.jsx';

// ANSI sequences for alternate screen buffer (flicker prevention)
const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Debounce resize events to prevent Ink's aggressive clear-on-resize
const RESIZE_DEBOUNCE_MS = 100;
let resizeTimeout = null;
let lastCols = process.stdout.columns;
let lastRows = process.stdout.rows;
const originalEmit = process.stdout.emit.bind(process.stdout);
process.stdout.emit = function(event, ...args) {
  if (event === 'resize') {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
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

function cleanup() {
  process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

const { waitUntilExit } = render(<StatusPane />);

waitUntilExit().then(() => {
  cleanup();
  process.exit(0);
});
