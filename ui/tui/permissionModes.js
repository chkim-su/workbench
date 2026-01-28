/**
 * Permission mode definitions for Codex executor.
 * Controls sandbox level and shell access.
 */

export const PERMISSION_MODES = {
  plan: {
    key: 'plan',
    label: 'Plan Mode (Restricted)',
    description: 'Read-only (shell allowed)',
    sandboxFlag: 'read-only',
    noShell: false,
    color: 'green',
    riskLevel: 'low',
  },
  bypass: {
    key: 'bypass',
    label: 'Bypass Mode (Override)',
    description: 'Workspace writes + shell allowed (still sandboxed)',
    sandboxFlag: 'workspace-write',
    noShell: false,
    color: 'red',
    riskLevel: 'high',
  },
};

export const DEFAULT_PERMISSION_MODE = 'plan';

/**
 * Get the sandbox CLI arguments for a given permission mode.
 * @param {string} mode - Permission mode key
 * @returns {string[]} CLI arguments for codex exec
 */
export function getSandboxArgs(mode) {
  const config = PERMISSION_MODES[mode] || PERMISSION_MODES[DEFAULT_PERMISSION_MODE];
  return ['--sandbox', config.sandboxFlag];
}

/**
 * Get the full permission mode configuration.
 * @param {string} mode - Permission mode key
 * @returns {object} Permission mode config object
 */
export function getPermissionModeConfig(mode) {
  return PERMISSION_MODES[mode] || PERMISSION_MODES[DEFAULT_PERMISSION_MODE];
}

/**
 * Get list of all permission modes for UI display.
 * @returns {object[]} Array of permission mode configs
 */
export function getPermissionModeList() {
  return [PERMISSION_MODES.plan, PERMISSION_MODES.bypass].filter(Boolean);
}
