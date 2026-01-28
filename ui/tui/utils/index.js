/**
 * Shared TUI utilities
 * Central re-export for clean imports
 */

// Time utilities
export {
  formatTimeRemaining,
  formatTimeUntil,
  nowIso,
} from './time.js';

// OAuth/JWT utilities
export {
  extractEmailFromToken,
  extractTokenInfo,
  getProfileStatus,
  getSimpleProfileStatus,
} from './oauth.js';

// File system utilities
export {
  ensureDir,
  readJson,
  safeReadJson,
  writeJson,
  appendJsonl,
} from './fs.js';

// Session utilities
export {
  randomSessionId,
  readCurrentSessionId,
  ensureSessionId,
} from './session.js';

// Error handling utilities
export {
  trySafe,
  trySafeAsync,
} from './errors.js';
