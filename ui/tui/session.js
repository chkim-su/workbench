import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { DEFAULT_PERMISSION_MODE } from './permissionModes.js';

/**
 * Session management for TUI
 * Handles session creation, persistence, and lifecycle
 */
export class SessionManager {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.sessionsDir = join(stateDir, 'sessions');
    this.current = null;
  }

  /**
   * Create a new session with the given mode and permission mode
   * @param {string} mode - 'A' for Controlled, 'B' for Compatibility
   * @param {string} permissionMode - 'plan' or 'bypass' (defaults to 'plan')
   * @returns {object} The created session
   */
  createSession(mode, permissionMode = DEFAULT_PERMISSION_MODE) {
    const id = randomUUID();
    this.current = {
      id,
      mode,
      permissionMode,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    this._ensureDir();
    return this.current;
  }

  /**
   * Start a new session, saving the current one first
   * @param {string} mode - Session mode
   * @returns {object} The new session
   */
  newSession(mode) {
    this.saveSession();
    return this.createSession(mode);
  }

  /**
   * Add a message to the current session
   * @param {object} message - Message with role and content
   */
  addMessage(message) {
    if (!this.current) return;
    this.current.messages.push({
      ...message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get current session info
   * @returns {object|null} Current session or null
   */
  getSession() {
    return this.current;
  }

  /**
   * Get session mode
   * @returns {string|null} 'A', 'B', or null
   */
  getMode() {
    return this.current?.mode ?? null;
  }

  /**
   * Get permission mode
   * @returns {string} 'plan' or 'bypass' (defaults to 'plan')
   */
  getPermissionMode() {
    return this.current?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  }

  /**
   * Set permission mode for current session
   * @param {string} permissionMode - 'plan' or 'bypass'
   */
  setPermissionMode(permissionMode) {
    if (this.current) {
      this.current.permissionMode = permissionMode;
      this.current.permissionModeChangedAt = new Date().toISOString();
    }
  }

  /**
   * Save current session to disk
   */
  saveSession() {
    if (!this.current) return;

    this._ensureDir();
    const sessionDir = join(this.sessionsDir, this.current.id);
    mkdirSync(sessionDir, { recursive: true });

    const sessionPath = join(sessionDir, 'session.json');
    const data = {
      ...this.current,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(sessionPath, JSON.stringify(data, null, 2));
  }

  /**
   * Load a session by ID
   * @param {string} id - Session ID
   * @returns {object|null} Loaded session or null
   */
  loadSession(id) {
    const sessionPath = join(this.sessionsDir, id, 'session.json');
    if (!existsSync(sessionPath)) {
      return null;
    }
    try {
      const data = JSON.parse(readFileSync(sessionPath, 'utf8'));
      this.current = data;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * List all saved sessions
   * @returns {Array} List of session metadata
   */
  listSessions() {
    if (!existsSync(this.sessionsDir)) {
      return [];
    }

    const { readdirSync } = require('node:fs');
    const dirs = readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    return dirs.map(id => {
      const sessionPath = join(this.sessionsDir, id, 'session.json');
      if (!existsSync(sessionPath)) return null;
      try {
        const data = JSON.parse(readFileSync(sessionPath, 'utf8'));
        return {
          id: data.id,
          mode: data.mode,
          createdAt: data.createdAt,
          messageCount: data.messages?.length ?? 0,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /**
   * Ensure sessions directory exists
   */
  _ensureDir() {
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }
}

/**
 * Create a session manager with default state directory
 * @param {string} stateDir - State directory path
 * @returns {SessionManager} Session manager instance
 */
export function createSessionManager(stateDir) {
  return new SessionManager(stateDir);
}
