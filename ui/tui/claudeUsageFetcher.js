/**
 * Claude Code Usage Fetcher
 * Reads usage statistics from Claude Code's local storage
 *
 * Reference: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
 *
 * Claude Code stores data in ~/.claude/ including:
 * - usage_log.jsonl: Recent usage events
 * - projects/<hash>/... : Per-project data
 *
 * Since Claude Code doesn't have a public API for usage stats,
 * we parse the project files to track session-level token usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CACHE_TTL_MS = 30 * 1000; // 30 second cache
const DEFAULT_USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB tail read (recent events)

let cachedAll = null;
let cachedAt = 0;

/**
 * Calculate cost estimate based on token counts
 * Prices are approximate for Claude 3.5/4 Sonnet (Dec 2024)
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @returns {number} Estimated cost in USD
 */
function estimateCostFromTokens(inputTokens, outputTokens) {
  // Claude 3.5 Sonnet pricing (approximate, Dec 2024)
  // $3 per 1M input tokens, $15 per 1M output tokens
  const inputCost = (inputTokens / 1_000_000) * 3;
  const outputCost = (outputTokens / 1_000_000) * 15;
  return inputCost + outputCost;
}

/**
 * Read and parse JSONL file (one JSON object per line)
 * @param {string} filePath - Path to JSONL file
 * @returns {Array<Object>} Parsed objects
 */
function readJsonl(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read JSON file safely
 * @param {string} filePath - Path to JSON file
 * @returns {Object|null} Parsed JSON or null
 */
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlTail(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    const bytes = Math.max(0, Math.min(st.size, maxBytes));
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, start);
      const txt = buf.toString('utf8');
      const lines = txt.split('\n');
      // First line may be partial if we started mid-file.
      if (start > 0) lines.shift();
      return lines
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  } catch {
    return [];
  }
}

function toMs(ts) {
  if (!ts) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Heuristic: seconds vs ms
    return ts > 10_000_000_000 ? ts : ts * 1000;
  }
  if (typeof ts === 'string' && ts.trim()) {
    const n = Number(ts);
    if (Number.isFinite(n)) return toMs(n);
    const d = new Date(ts);
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function extractClaudeEventUsage(ev) {
  if (!ev || typeof ev !== 'object') return null;

  const atMs =
    toMs(ev.timestamp) ??
    toMs(ev.at) ??
    toMs(ev.created_at) ??
    toMs(ev.createdAt) ??
    toMs(ev.message?.timestamp) ??
    null;

  // Claude Code event shapes vary; be permissive.
  const usage =
    ev.message?.usage ??
    ev.usage ??
    ev.message?.metadata?.usage ??
    null;

  const inputTokens =
    (usage && (usage.input_tokens ?? usage.inputTokens)) ??
    ev.input_tokens ??
    ev.inputTokens ??
    0;
  const outputTokens =
    (usage && (usage.output_tokens ?? usage.outputTokens)) ??
    ev.output_tokens ??
    ev.outputTokens ??
    0;

  const costUsd =
    ev.costUsd ??
    ev.cost_usd ??
    usage?.costUsd ??
    usage?.cost_usd ??
    null;

  const model =
    ev.message?.model ??
    ev.model ??
    null;

  const inTok = Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : 0;
  const outTok = Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : 0;
  let cUsd = costUsd === null || costUsd === undefined ? null : (Number.isFinite(Number(costUsd)) ? Number(costUsd) : null);
  if (cUsd === null && (inTok > 0 || outTok > 0)) {
    cUsd = estimateCostFromTokens(inTok, outTok);
  }

  if (!atMs) return null;
  if (inTok <= 0 && outTok <= 0 && (cUsd === null || cUsd <= 0)) return null;

  return {
    atMs,
    inputTokens: inTok,
    outputTokens: outTok,
    totalTokens: inTok + outTok,
    costUsd: cUsd,
    model,
  };
}

function startOfLocalDayMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfLocalWeekMs(nowMs, weekStartsOn = 1 /* Monday */) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun
  const diff = (day - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function nextLocalDayMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function nextLocalWeekMs(nowMs, weekStartsOn = 1 /* Monday */) {
  const start = startOfLocalWeekMs(nowMs, weekStartsOn);
  const d = new Date(start);
  d.setDate(d.getDate() + 7);
  return d.getTime();
}

function sumUsage(items) {
  const out = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, messageCount: 0, models: new Map() };
  for (const it of items) {
    if (!it) continue;
    out.inputTokens += it.inputTokens || 0;
    out.outputTokens += it.outputTokens || 0;
    out.totalTokens += it.totalTokens || 0;
    if (typeof it.costUsd === 'number' && Number.isFinite(it.costUsd)) out.costUsd += it.costUsd;
    out.messageCount += 1;
    if (it.model) out.models.set(it.model, (out.models.get(it.model) || 0) + 1);
  }
  return out;
}

/**
 * Find the most recent session file for a project
 * @param {string} projectDir - Project directory path
 * @returns {string|null} Path to most recent session file
 */
function findRecentSession(projectDir) {
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        path: path.join(projectDir, f),
        stat: fs.statSync(path.join(projectDir, f))
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Parse session events to calculate usage
 * @param {Array<Object>} events - Session events
 * @returns {Object} Usage statistics
 */
function parseSessionUsage(events) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  let messageCount = 0;
  let lastActivity = null;
  let model = null;

  for (const event of events) {
    if (event.type === 'assistant' && event.message) {
      messageCount++;
      if (event.message.usage) {
        inputTokens += event.message.usage.input_tokens || 0;
        outputTokens += event.message.usage.output_tokens || 0;
      }
      if (event.message.model) {
        model = event.message.model;
      }
      // Claude Code tracks cost in costUsd
      if (event.costUsd) {
        totalCost += event.costUsd;
      }
      lastActivity = event.timestamp || event.message.timestamp;
    }

    // Also check for 'summary' events that might have aggregated stats
    if (event.type === 'summary') {
      if (event.inputTokens) inputTokens = Math.max(inputTokens, event.inputTokens);
      if (event.outputTokens) outputTokens = Math.max(outputTokens, event.outputTokens);
      if (event.totalCost) totalCost = Math.max(totalCost, event.totalCost);
    }
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    messageCount,
    costUsd: totalCost,
    model,
    lastActivity: lastActivity ? new Date(lastActivity).getTime() : null,
  };
}

/**
 * Get project hash from current working directory
 * Claude Code uses a hash of the project path for the directory name
 * @param {string} projectPath - Project directory path
 * @returns {string} Hashed project identifier
 */
function getProjectHash(projectPath) {
  // Claude Code uses a specific hash algorithm - we'll try to match directories
  // by checking which project directories exist and match our path
  const normalizedPath = path.resolve(projectPath);

  // Try to find a projects directory that matches
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    // Claude Code stores project metadata - check for a match
    for (const dir of dirs) {
      // Directory name format: -path-to-project (slashes replaced with dashes)
      const expectedPattern = normalizedPath.replace(/\//g, '-');
      if (dir === expectedPattern || dir.includes(expectedPattern)) {
        return dir;
      }
    }

    // Fallback: return most recently modified project
    const recent = dirs
      .map(d => ({
        name: d,
        stat: fs.statSync(path.join(projectsDir, d))
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    return recent.length > 0 ? recent[0].name : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Claude Code usage for the current or specified project
 * @param {string} projectPath - Optional project path (defaults to cwd)
 * @returns {Promise<Object|null>} Usage data or null
 */
export async function fetchClaudeUsage(projectPath = process.cwd()) {
  if (!fs.existsSync(CLAUDE_DIR)) {
    return null;
  }

  const projectHash = getProjectHash(projectPath);
  if (!projectHash) {
    return { error: 'Project not found in Claude Code' };
  }

  const projectDir = path.join(CLAUDE_DIR, 'projects', projectHash);
  const sessionFile = findRecentSession(projectDir);

  if (!sessionFile) {
    return { error: 'No session files found' };
  }

  const events = readJsonl(sessionFile);
  if (events.length === 0) {
    return { error: 'No events in session' };
  }

  const usage = parseSessionUsage(events);

  // If no cost was tracked, estimate it
  if (!usage.costUsd && usage.totalTokens > 0) {
    usage.costUsd = estimateCostFromTokens(usage.inputTokens, usage.outputTokens);
    usage.costEstimated = true;
  }

  return {
    fetchedAt: Date.now(),
    projectHash,
    sessionFile: path.basename(sessionFile),
    ...usage,
  };
}

/**
 * Fetch aggregated Claude Code usage across all recent projects
 * @returns {Promise<Object>} Aggregated usage data
 */
export async function fetchAllClaudeUsage() {
  const now = Date.now();
  if (cachedAll && (now - cachedAt) < CACHE_TTL_MS) {
    return cachedAll;
  }

  if (!fs.existsSync(CLAUDE_DIR)) {
    cachedAll = { available: false, error: 'Claude Code not installed' };
    cachedAt = now;
    return cachedAll;
  }

  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) {
    cachedAll = { available: true, fetchedAt: now, projects: [], totals: null, activeProjects: 0, windows: [] };
    cachedAt = now;
    return cachedAll;
  }

  const projects = [];
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      const projectDir = path.join(projectsDir, dir.name);
      const stat = fs.statSync(projectDir);

      // Only include recently active projects
      if (stat.mtimeMs < oneDayAgo) continue;

      const sessionFile = findRecentSession(projectDir);
      if (!sessionFile) continue;

      const events = readJsonl(sessionFile);
      const usage = parseSessionUsage(events);

      if (!usage.costUsd && usage.totalTokens > 0) {
        usage.costUsd = estimateCostFromTokens(usage.inputTokens, usage.outputTokens);
        usage.costEstimated = true;
      }

      if (usage.totalTokens > 0) {
        projects.push({
          projectHash: dir.name,
          ...usage,
        });
      }
    }

    // Sort by last activity
    projects.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));

    // Calculate totals
    const totals = projects.reduce((acc, p) => ({
      inputTokens: acc.inputTokens + p.inputTokens,
      outputTokens: acc.outputTokens + p.outputTokens,
      totalTokens: acc.totalTokens + p.totalTokens,
      costUsd: acc.costUsd + (p.costUsd || 0),
      messageCount: acc.messageCount + p.messageCount,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, messageCount: 0 });

    // Prefer usage_log.jsonl for daily/weekly windows (account-level), fallback to project scan.
    const usageLogPath = path.join(CLAUDE_DIR, 'usage_log.jsonl');
    const maxBytesRaw = (process.env.WORKBENCH_CLAUDE_USAGE_LOG_MAX_BYTES || '').trim();
    const maxBytes = Number.isFinite(Number(maxBytesRaw)) ? Math.max(128 * 1024, Math.min(100 * 1024 * 1024, Number(maxBytesRaw))) : DEFAULT_USAGE_LOG_MAX_BYTES;

    const weekStartsOnRaw = (process.env.WORKBENCH_CLAUDE_WEEK_STARTS_ON || '').trim();
    const weekStartsOn = Number.isFinite(Number(weekStartsOnRaw)) ? Math.max(0, Math.min(6, Number(weekStartsOnRaw))) : 1; // 1=Mon

    let extracted = [];
    let source = 'projects';
    if (fs.existsSync(usageLogPath)) {
      const rawEvents = readJsonlTail(usageLogPath, maxBytes);
      extracted = rawEvents.map(extractClaudeEventUsage).filter(Boolean);
      if (extracted.length) source = 'usage_log';
    }

    // If usage log isn't available/parseable, approximate windows from project sessions.
    if (!extracted.length) {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      for (const p of projects) {
        // Reconstruct a minimal "event" timestamp from lastActivity, and use the session totals as a coarse sample.
        const atMs = p.lastActivity ?? null;
        if (!atMs || atMs < weekAgo) continue;
        extracted.push({
          atMs,
          inputTokens: p.inputTokens || 0,
          outputTokens: p.outputTokens || 0,
          totalTokens: p.totalTokens || 0,
          costUsd: typeof p.costUsd === 'number' ? p.costUsd : null,
          model: p.model || null,
        });
      }
    }

    const dayStart = startOfLocalDayMs(now);
    const weekStart = startOfLocalWeekMs(now, weekStartsOn);
    const dailyItems = extracted.filter((e) => e.atMs >= dayStart);
    const weeklyItems = extracted.filter((e) => e.atMs >= weekStart);
    const daily = sumUsage(dailyItems);
    const weekly = sumUsage(weeklyItems);

    const windows = [
      { type: 'daily', ...daily, resetAtMs: nextLocalDayMs(now) },
      { type: 'weekly', ...weekly, resetAtMs: nextLocalWeekMs(now, weekStartsOn) },
    ];

    cachedAll = {
      available: true,
      fetchedAt: now,
      source,
      projects,
      totals,
      activeProjects: projects.length,
      windows,
    };
    cachedAt = now;
    return cachedAll;
  } catch (err) {
    cachedAll = { available: true, fetchedAt: now, error: err.message };
    cachedAt = now;
    return cachedAll;
  }
}

/**
 * Format token count for display
 * @param {number} tokens - Token count
 * @returns {string} Formatted string (e.g., "1.2K", "45.3K", "1.2M")
 */
export function formatTokens(tokens) {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

/**
 * Format cost for display
 * @param {number} cost - Cost in USD
 * @returns {string} Formatted string (e.g., "$0.12", "$1.50")
 */
export function formatCost(cost) {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}
