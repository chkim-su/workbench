/**
 * Session ID management utilities
 * Extracted from system-executor.js, codex-executor.js
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, readJson, writeJson } from './fs.js';
import { nowIso } from './time.js';

/**
 * Generate a random session ID
 * @returns {string} Session ID like "sess_a1b2c3d4"
 */
export function randomSessionId() {
  return `sess_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Read current session ID from state directory
 * @param {string} stateDir - State directory path
 * @returns {string} Session ID or empty string if not found
 */
export function readCurrentSessionId(stateDir) {
  const currentPath = path.join(stateDir, 'state', 'current.json');
  ensureDir(path.dirname(currentPath));
  let cur = { schemaVersion: 1 };
  if (fs.existsSync(currentPath)) {
    try {
      cur = readJson(currentPath);
    } catch {
      // Ignore read errors
    }
  }
  if (typeof cur.sessionId === 'string' && cur.sessionId.trim()) {
    return cur.sessionId.trim();
  }
  return '';
}

/**
 * Ensure a session ID exists, creating one if needed
 * @param {string} stateDir - State directory path
 * @returns {string} Session ID
 */
export function ensureSessionId(stateDir) {
  const existing = readCurrentSessionId(stateDir);
  if (existing) return existing;

  const currentPath = path.join(stateDir, 'state', 'current.json');
  ensureDir(path.dirname(currentPath));
  const cur = { schemaVersion: 1, sessionId: randomSessionId(), updatedAt: nowIso() };
  writeJson(currentPath, cur, 0o644);
  return cur.sessionId;
}
