/**
 * Usage Fetcher for Codex OAuth accounts
 * Fetches usage data from ChatGPT backend API
 */

import https from 'node:https';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

/**
 * Fetch usage data for a profile
 * @param {string} accessToken - OAuth access token
 * @param {string} accountId - ChatGPT account ID (optional)
 * @returns {Promise<Object|null>} Usage data or null on error
 */
export async function fetchUsage(accessToken, accountId = null) {
  return new Promise((resolve) => {
    const url = new URL(USAGE_ENDPOINT);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'MyLLMWorkbench/1.0',
      },
      timeout: 10000,
    };

    if (accountId) {
      options.headers['ChatGPT-Account-Id'] = accountId;
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(parseUsageResponse(json));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

/**
 * Parse usage response into a standardized format
 * @param {Object} data - Raw API response
 * @returns {Object} Parsed usage data
 */
function parseUsageResponse(data) {
  const result = {
    fetchedAt: Date.now(),
    planType: data.plan_type || null,
    windows: [],
    credits: null,
    allowed: true,
    limitReached: false,
  };

  // Parse rate_limit structure (official ChatGPT API format)
  if (data.rate_limit) {
    result.allowed = data.rate_limit.allowed !== false;
    result.limitReached = data.rate_limit.limit_reached === true;

    // Primary window (5h)
    if (data.rate_limit.primary_window) {
      const pw = data.rate_limit.primary_window;
      result.windows.push({
        type: '5h',
        percentage: pw.used_percent ?? 0,
        remaining: 100 - (pw.used_percent ?? 0),
        windowSeconds: pw.limit_window_seconds || 18000,
        resetAfterSeconds: pw.reset_after_seconds,
        resetAtMs: pw.reset_at ? pw.reset_at * 1000 : null, // Convert Unix timestamp to ms
      });
    }

    // Secondary window (weekly)
    if (data.rate_limit.secondary_window) {
      const sw = data.rate_limit.secondary_window;
      result.windows.push({
        type: 'weekly',
        percentage: sw.used_percent ?? 0,
        remaining: 100 - (sw.used_percent ?? 0),
        windowSeconds: sw.limit_window_seconds || 604800,
        resetAfterSeconds: sw.reset_after_seconds,
        resetAtMs: sw.reset_at ? sw.reset_at * 1000 : null, // Convert Unix timestamp to ms
      });
    }
  }

  // Parse credits
  if (data.credits) {
    result.credits = {
      balance: parseFloat(data.credits.balance) || 0,
      hasCredits: data.credits.has_credits === true,
      unlimited: data.credits.unlimited === true,
      approxLocalMessages: data.credits.approx_local_messages || [0, 0],
      approxCloudMessages: data.credits.approx_cloud_messages || [0, 0],
    };
  }

  // Fallback: parse older formats
  if (result.windows.length === 0) {
    // Try usage_windows array format
    if (data.usage_windows || data.windows) {
      const windows = data.usage_windows || data.windows || [];
      for (const w of (Array.isArray(windows) ? windows : [])) {
        result.windows.push({
          type: w.type || w.name || 'unknown',
          percentage: w.used_percent ?? w.percentage ?? 0,
          remaining: 100 - (w.used_percent ?? w.percentage ?? 0),
          resetAtMs: w.reset_at ? (w.reset_at > 9999999999 ? w.reset_at : w.reset_at * 1000) : null,
        });
      }
    }

    // Try direct percentage fields
    if (data.rate_limit_5h !== undefined) {
      result.windows.push({
        type: '5h',
        percentage: Math.round(data.rate_limit_5h * 100),
        remaining: Math.round((1 - data.rate_limit_5h) * 100),
        resetAtMs: data.reset_5h ? new Date(data.reset_5h).getTime() : null,
      });
    }
    if (data.rate_limit_weekly !== undefined) {
      result.windows.push({
        type: 'weekly',
        percentage: Math.round(data.rate_limit_weekly * 100),
        remaining: Math.round((1 - data.rate_limit_weekly) * 100),
        resetAtMs: data.reset_weekly ? new Date(data.reset_weekly).getTime() : null,
      });
    }
  }

  return result;
}

/**
 * Load cached usage data
 * @param {string} stateDir - State directory path
 * @param {string} profileName - Profile name
 * @returns {Object|null} Cached data or null
 */
export function loadCachedUsage(stateDir, profileName) {
  const cachePath = join(stateDir, 'cache', 'usage', `${profileName}.json`);
  try {
    if (!existsSync(cachePath)) return null;
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    // Check if cache is still valid
    if (data.fetchedAt && (Date.now() - data.fetchedAt) < CACHE_TTL_MS) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save usage data to cache
 * @param {string} stateDir - State directory path
 * @param {string} profileName - Profile name
 * @param {Object} data - Usage data to cache
 */
export function saveCachedUsage(stateDir, profileName, data) {
  const cacheDir = join(stateDir, 'cache', 'usage');
  const cachePath = join(cacheDir, `${profileName}.json`);
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch {}
}

/**
 * Fetch usage for all profiles in the pool
 * @param {Object} oauthPool - OAuth pool object
 * @param {string} stateDir - State directory path
 * @returns {Promise<Map<string, Object>>} Map of profile name to usage data
 */
export async function fetchAllUsage(oauthPool, stateDir) {
  const results = new Map();

  if (!oauthPool || !oauthPool.profiles) {
    return results;
  }

  const profiles = Object.entries(oauthPool.profiles);

  // Fetch in parallel with rate limiting (max 2 concurrent)
  const batchSize = 2;
  for (let i = 0; i < profiles.length; i += batchSize) {
    const batch = profiles.slice(i, i + batchSize);
    const promises = batch.map(async ([name, profile]) => {
      // Check cache first
      const cached = loadCachedUsage(stateDir, name);
      if (cached) {
        return [name, cached];
      }

      // Fetch fresh data
      const accessToken = profile.accessToken || profile.access_token;
      const accountId = profile.accountId || profile.account_id;

      if (!accessToken) {
        return [name, null];
      }

      const usage = await fetchUsage(accessToken, accountId);
      if (usage) {
        saveCachedUsage(stateDir, name, usage);
      }
      return [name, usage];
    });

    const batchResults = await Promise.all(promises);
    for (const [name, usage] of batchResults) {
      if (usage) {
        results.set(name, usage);
      }
    }
  }

  return results;
}

/**
 * Format reset time for display
 * @param {number|string} resetAt - Reset timestamp or ISO string
 * @returns {string} Formatted string like "2h 30m" or "Jan 25"
 */
export function formatResetTime(resetAt) {
  if (!resetAt) return '?';

  const resetMs = typeof resetAt === 'number' ? resetAt : new Date(resetAt).getTime();
  const now = Date.now();
  const diff = resetMs - now;

  if (diff <= 0) return 'now';

  const seconds = Math.floor(diff / 1000);
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
