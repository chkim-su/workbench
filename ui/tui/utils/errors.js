/**
 * Error handling utilities
 */

/**
 * Execute a function safely, returning fallback on error
 * @template T
 * @param {() => T} fn - Function to execute
 * @param {T} fallback - Value to return on error
 * @param {string} [context] - Optional context for debug logging
 * @returns {T} Result or fallback
 */
export function trySafe(fn, fallback, context) {
  try {
    return fn();
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`[trySafe${context ? `:${context}` : ''}]`, err?.message || err);
    }
    return fallback;
  }
}

/**
 * Execute an async function safely, returning fallback on error
 * @template T
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {T} fallback - Value to return on error
 * @param {string} [context] - Optional context for debug logging
 * @returns {Promise<T>} Result or fallback
 */
export async function trySafeAsync(fn, fallback, context) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`[trySafeAsync${context ? `:${context}` : ''}]`, err?.message || err);
    }
    return fallback;
  }
}
