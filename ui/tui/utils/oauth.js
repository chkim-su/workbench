/**
 * OAuth/JWT token utilities
 * Extracted from OAuthStatus.jsx, StatusPane.jsx, control-popup-entry.jsx
 */

import { formatTimeRemaining } from './time.js';

/**
 * Extract email from a JWT token
 * @param {string} token - JWT access/id token
 * @returns {string|null} Email address or null
 */
export function extractEmailFromToken(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload['https://api.openai.com/profile']?.email ||
           payload.email ||
           null;
  } catch {
    return null;
  }
}

/**
 * Extract full token info from a JWT
 * @param {string} token - JWT access/id token
 * @returns {{ email: string|null, plan: string|null, exp: number|null }|null}
 */
export function extractTokenInfo(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return {
      email: payload['https://api.openai.com/profile']?.email || payload.email || null,
      plan: payload['https://api.openai.com/auth']?.chatgpt_plan_type || null,
      exp: payload.exp ? payload.exp * 1000 : null, // Convert to ms
    };
  } catch {
    return null;
  }
}

/**
 * Determine profile status from OAuth profile data
 * @param {Object} profile - OAuth profile object
 * @returns {{ status: string, color: string, icon: string, text: string }}
 */
export function getProfileStatus(profile) {
  const now = Date.now();

  // Check if rate limited
  if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > now) {
    const remaining = profile.rateLimitedUntilMs - now;
    return {
      status: 'rate_limited',
      color: 'yellow',
      icon: '!',
      text: `Rate limited (${formatTimeRemaining(remaining)})`,
    };
  }

  // Check if disabled
  if (profile.disabled || profile.enabled === false) {
    return {
      status: 'disabled',
      color: 'gray',
      icon: '-',
      text: 'Disabled',
    };
  }

  // Check if expired
  if (profile.expiresAtMs && profile.expiresAtMs < now) {
    return {
      status: 'expired',
      color: 'red',
      icon: 'x',
      text: 'Token expired (will refresh)',
    };
  }

  // Ready
  return {
    status: 'ready',
    color: 'green',
    icon: '●',
    text: 'Ready',
  };
}

/**
 * Get a simpler profile status for popup/quick displays
 * Returns 'ready' | 'limited' | 'disabled' | 'expired'
 * @param {Object} profile - OAuth profile object
 * @returns {{ status: string, statusColor: string }}
 */
export function getSimpleProfileStatus(profile) {
  const now = Date.now();

  if (profile.disabled || profile.enabled === false) {
    return { status: 'disabled', statusColor: 'gray' };
  }
  if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > now) {
    return { status: 'limited', statusColor: 'yellow' };
  }
  if (profile.expiresAtMs && profile.expiresAtMs < now) {
    return { status: 'expired', statusColor: 'red' };
  }
  return { status: 'ready', statusColor: 'green' };
}
