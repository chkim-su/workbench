/**
 * File system utilities
 * Extracted from StatusPane.jsx, system-executor.js, codex-executor.js
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Ensure directory exists, creating it recursively if needed
 * @param {string} p - Directory path
 */
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Read JSON file, return parsed object
 * @param {string} p - File path
 * @returns {any} Parsed JSON
 * @throws {Error} If file doesn't exist or is invalid JSON
 */
export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Safely read JSON file, returning null on any error
 * @param {string} p - File path
 * @returns {any|null} Parsed JSON or null
 */
export function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write JSON to file with optional permissions
 * @param {string} p - File path
 * @param {any} obj - Object to serialize
 * @param {number} mode - File mode (default 0o644)
 */
export function writeJson(p, obj, mode = 0o644) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode });
}

/**
 * Append JSON line to file (JSONL format)
 * @param {string} p - File path
 * @param {any} obj - Object to serialize
 * @param {number} mode - File mode (default 0o644)
 */
export function appendJsonl(p, obj, mode = 0o644) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', { encoding: 'utf8', mode });
}
