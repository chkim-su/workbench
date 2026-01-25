import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CURRENT_STATE = (stateDir) => join(stateDir, 'state', 'current.json');

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function ensureFile(path) {
  ensureDir(dirname(path));
  if (!existsSync(path)) {
    writeFileSync(path, '', { encoding: 'utf8', mode: 0o644 });
  }
}

function ensureSessionId(stateDir) {
  const currentPath = CURRENT_STATE(stateDir);
  ensureDir(dirname(currentPath));
  let current = { schemaVersion: 1 };
  if (existsSync(currentPath)) {
    try {
      const json = readFileSync(currentPath, 'utf8');
      if (json.trim()) {
        current = JSON.parse(json);
      }
    } catch {
      current = { schemaVersion: 1 };
    }
  }

  if (typeof current.sessionId === 'string' && current.sessionId.trim()) {
    return current.sessionId.trim();
  }

  const id = `sess_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  current.sessionId = id;
  current.updatedAt = now;
  writeFileSync(currentPath, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  return id;
}

function getSystemPaths(stateDir) {
  const sessionId = ensureSessionId(stateDir);
  const base = join(stateDir, sessionId);
  return {
    sessionId,
    base,
    requestsPath: join(base, 'system.requests.jsonl'),
    responsesPath: join(base, 'system.responses.jsonl'),
    readyPath: join(base, 'system.executor.json'),
  };
}

export function appendSystemRequest(stateDir, request) {
  const { requestsPath } = getSystemPaths(stateDir);
  ensureFile(requestsPath);
  const payload = { version: 1, ...request };
  appendFileSync(requestsPath, JSON.stringify(payload) + '\n', { encoding: 'utf8' });
  return payload;
}

export function readSystemResponses(stateDir, offset = 0) {
  const { responsesPath } = getSystemPaths(stateDir);
  ensureFile(responsesPath);
  let stats = null;
  try {
    stats = statSync(responsesPath);
  } catch {
    return { responses: [], offset };
  }
  const total = stats.size;
  if (offset > total) offset = total;
  if (total === 0 || offset === total) {
    return { responses: [], offset: total };
  }
  const content = readFileSync(responsesPath, 'utf8');
  const chunk = content.slice(offset);
  const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
  const responses = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.version === 1 && typeof obj.type === 'string') {
        responses.push(obj);
      }
    } catch {
      // ignore
    }
  }
  return { responses, offset: total };
}

export function isSystemExecutorReady(stateDir, maxAgeMs = 30_000) {
  const { readyPath } = getSystemPaths(stateDir);
  try {
    const stats = statSync(readyPath);
    return Date.now() - stats.mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

export function newCorrelationId() {
  return `cid_${crypto.randomBytes(4).toString('hex')}`;
}

export function readSessionState(stateDir) {
  const path = CURRENT_STATE(stateDir);
  ensureDir(dirname(path));
  try {
    const json = readFileSync(path, 'utf8');
    return json.trim() ? JSON.parse(json) : { schemaVersion: 1 };
  } catch {
    return { schemaVersion: 1 };
  }
}

export function updateSessionState(stateDir, updates) {
  const path = CURRENT_STATE(stateDir);
  ensureDir(dirname(path));
  const current = readSessionState(stateDir);
  const next = { ...current, ...updates, updatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  return next;
}

export function getClaudeConnectionMode(stateDir) {
  const state = readSessionState(stateDir);
  return state?.claudeConnectionMode === 'managed' ? 'managed' : 'tmux';
}

export function setClaudeConnectionMode(stateDir, mode) {
  const normalized = mode === 'managed' ? 'managed' : 'tmux';
  return updateSessionState(stateDir, { claudeConnectionMode: normalized });
}
