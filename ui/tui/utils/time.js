/**
 * Time formatting utilities
 * Extracted from OAuthStatus.jsx and StatusPane.jsx
 */

/**
 * Format milliseconds as a human-readable duration
 * @param {number} ms - Duration in milliseconds
 * @returns {string|null} Formatted duration (e.g., "1h 30m") or null if <= 0
 */
export function formatTimeRemaining(ms) {
  if (ms <= 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h${minutes % 60}m${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format time until a future timestamp
 * @param {number} ms - Future timestamp in milliseconds
 * @returns {string|null} Formatted time until (e.g., "2h 30m") or "expired" if past
 */
export function formatTimeUntil(ms) {
  if (!ms) return null;
  const now = Date.now();
  const diff = ms - now;
  if (diff <= 0) return 'expired';

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Get current time as ISO string
 * @returns {string} ISO timestamp
 */
export function nowIso() {
  return new Date().toISOString();
}
