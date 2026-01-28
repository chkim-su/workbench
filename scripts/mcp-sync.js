#!/usr/bin/env node
/**
 * MCP Sync - Auto-register all Workbench MCP servers
 *
 * Registers MCP servers into:
 * - .mcp.json (Claude Code)
 * - ~/.codex/config.toml (Codex CLI)
 *
 * Usage:
 *   node scripts/mcp-sync.js [--check] [--claude-only] [--codex-only]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

// MCP servers to register
const MCP_SERVERS = [
  {
    name: 'workbench',
    entry: 'mcp/servers/workbench/bin/stdio.js',
    runtime: 'node',
    description: 'Main Workbench MCP (sandbox, tmux, results)'
  },
  {
    name: 'workbench-docker',
    entry: 'mcp/servers/docker/src/index.js',
    runtime: 'bun',
    description: 'Docker harness operations'
  },
  {
    name: 'workbench-workflow',
    entry: 'mcp/servers/workflow/src/index.js',
    runtime: 'bun',
    description: 'Workflow management'
  },
  {
    name: 'workbench-registry',
    entry: 'mcp/servers/registry/src/index.js',
    runtime: 'bun',
    description: 'MCP server registry'
  },
  {
    name: 'workbench-container',
    entry: 'mcp/servers/workbench-docker/src/index.js',
    runtime: 'bun',
    description: 'Containerized Workbench control'
  },
];

function parseArgs(argv) {
  return {
    check: argv.includes('--check'),
    claudeOnly: argv.includes('--claude-only'),
    codexOnly: argv.includes('--codex-only'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  ensureDir(p);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Build Claude Code .mcp.json content
 */
function buildClaudeMcpJson(repoRoot) {
  const stateDir = path.join(repoRoot, '.workbench');
  const mcpServers = {};

  for (const srv of MCP_SERVERS) {
    mcpServers[srv.name] = {
      command: srv.runtime,
      args: [path.join(repoRoot, srv.entry)],
      env: { WORKBENCH_STATE_DIR: stateDir }
    };
  }

  return { mcpServers };
}

/**
 * Sync Claude Code .mcp.json
 */
function syncClaudeMcp(repoRoot, checkOnly = false) {
  const mcpPath = path.join(repoRoot, '.mcp.json');
  const desired = buildClaudeMcpJson(repoRoot);
  const existing = readJson(mcpPath);

  // Check if update needed
  const desiredStr = JSON.stringify(desired, null, 2);
  const existingStr = existing ? JSON.stringify(existing, null, 2) : '';

  if (desiredStr === existingStr) {
    console.log('[mcp-sync] .mcp.json: up to date');
    return { updated: false, path: mcpPath };
  }

  if (checkOnly) {
    console.log('[mcp-sync] .mcp.json: needs update');
    return { updated: false, needsUpdate: true, path: mcpPath };
  }

  writeJson(mcpPath, desired);
  console.log(`[mcp-sync] .mcp.json: updated with ${MCP_SERVERS.length} servers`);
  return { updated: true, path: mcpPath };
}

/**
 * Parse TOML (minimal - handles [sections] and key = value)
 */
function parseToml(content) {
  const result = {};
  let currentSection = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section header: [section.subsection]
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionPath = sectionMatch[1].split('.');
      let target = result;
      for (const part of sectionPath) {
        if (!target[part]) target[part] = {};
        target = target[part];
      }
      currentSection = target;
      continue;
    }

    // Key = value
    const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1].trim();
      let value = kvMatch[2].trim();

      // Parse value type
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Array
        value = value.slice(1, -1).split(',').map(v => {
          v = v.trim();
          if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
          return v;
        }).filter(Boolean);
      } else if (value.startsWith('{') && value.endsWith('}')) {
        // Inline table
        const inner = value.slice(1, -1);
        value = {};
        for (const part of inner.split(',')) {
          const partMatch = part.match(/([^=]+?)\s*=\s*(.+)/);
          if (partMatch) {
            let pKey = partMatch[1].trim();
            let pVal = partMatch[2].trim();
            if (pVal.startsWith('"') && pVal.endsWith('"')) pVal = pVal.slice(1, -1);
            value[pKey] = pVal;
          }
        }
      } else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      } else if (/^\d+$/.test(value)) {
        value = parseInt(value, 10);
      }

      currentSection[key] = value;
    }
  }

  return result;
}

/**
 * Serialize to TOML (minimal - handles nested sections)
 * Special handling for mcp_servers section which has nested env objects
 */
function serializeToml(obj, prefix = '') {
  let lines = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Special handling for MCP server entries (has command, args, env)
      if (value.command && value.args && value.env) {
        lines.push(`\n[${fullKey}]`);
        lines.push(`command = "${value.command}"`);
        if (Array.isArray(value.args)) {
          lines.push(`args = [${value.args.map(x => `"${x}"`).join(', ')}]`);
        }
        // Write env as sub-section
        lines.push(`\n[${fullKey}.env]`);
        for (const [ek, ev] of Object.entries(value.env)) {
          lines.push(`${ek} = "${ev}"`);
        }
        continue;
      }

      // Check if it's a leaf object (all values are primitives or arrays)
      const isLeaf = Object.values(value).every(v =>
        typeof v !== 'object' || Array.isArray(v) || v === null
      );

      if (isLeaf) {
        lines.push(`\n[${fullKey}]`);
        for (const [k, v] of Object.entries(value)) {
          if (Array.isArray(v)) {
            lines.push(`${k} = [${v.map(x => `"${x}"`).join(', ')}]`);
          } else if (typeof v === 'object' && v !== null) {
            const inlineEntries = Object.entries(v).map(([ik, iv]) => `${ik} = "${iv}"`);
            lines.push(`${k} = { ${inlineEntries.join(', ')} }`);
          } else if (typeof v === 'string') {
            lines.push(`${k} = "${v}"`);
          } else if (typeof v === 'boolean') {
            lines.push(`${k} = ${v}`);
          } else {
            lines.push(`${k} = ${v}`);
          }
        }
      } else {
        // Nested object - recurse
        lines.push(...serializeToml(value, fullKey));
      }
    }
  }

  return lines;
}

/**
 * Sync Codex config.toml mcp_servers section
 */
function syncCodexConfig(repoRoot, checkOnly = false) {
  const homedir = os.homedir();
  const configPath = path.join(homedir, '.codex', 'config.toml');
  const stateDir = path.join(repoRoot, '.workbench');

  // Build desired mcp_servers section
  const mcpServers = {};
  for (const srv of MCP_SERVERS) {
    mcpServers[srv.name] = {
      command: srv.runtime,
      args: [path.join(repoRoot, srv.entry)],
      env: { WORKBENCH_STATE_DIR: stateDir }
    };
  }

  // Read existing config
  let existingContent = '';
  let existingConfig = {};
  try {
    existingContent = fs.readFileSync(configPath, 'utf8');
    existingConfig = parseToml(existingContent);
  } catch {
    // Config doesn't exist
  }

  // Check if mcp_servers section needs update
  const existingMcpServers = existingConfig.mcp_servers || {};
  let needsUpdate = false;

  for (const srv of MCP_SERVERS) {
    const existing = existingMcpServers[srv.name];
    if (!existing) {
      needsUpdate = true;
      break;
    }
    if (existing.command !== srv.runtime) {
      needsUpdate = true;
      break;
    }
    const desiredArgs = [path.join(repoRoot, srv.entry)];
    if (JSON.stringify(existing.args) !== JSON.stringify(desiredArgs)) {
      needsUpdate = true;
      break;
    }
  }

  if (!needsUpdate) {
    console.log('[mcp-sync] ~/.codex/config.toml: up to date');
    return { updated: false, path: configPath };
  }

  if (checkOnly) {
    console.log('[mcp-sync] ~/.codex/config.toml: needs update');
    return { updated: false, needsUpdate: true, path: configPath };
  }

  // Merge: preserve non-mcp_servers sections, update mcp_servers
  existingConfig.mcp_servers = mcpServers;

  // Rebuild TOML
  const newLines = [];

  // Add non-mcp sections first (preserve original order if possible)
  for (const [key, value] of Object.entries(existingConfig)) {
    if (key === 'mcp_servers') continue;
    if (value && typeof value === 'object') {
      newLines.push(...serializeToml({ [key]: value }));
    }
  }

  // Add mcp_servers section
  newLines.push(...serializeToml({ mcp_servers: mcpServers }));

  // Write
  ensureDir(configPath);
  fs.writeFileSync(configPath, newLines.join('\n') + '\n', 'utf8');
  console.log(`[mcp-sync] ~/.codex/config.toml: updated with ${MCP_SERVERS.length} MCP servers`);
  return { updated: true, path: configPath };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
mcp-sync - Auto-register Workbench MCP servers

Usage: node scripts/mcp-sync.js [options]

Options:
  --check       Check if updates are needed (don't modify files)
  --claude-only Only sync .mcp.json
  --codex-only  Only sync ~/.codex/config.toml
  --help, -h    Show this help

MCP servers registered:
${MCP_SERVERS.map(s => `  - ${s.name}: ${s.description}`).join('\n')}
`);
    process.exit(0);
  }

  console.log(`[mcp-sync] Syncing ${MCP_SERVERS.length} MCP servers...`);

  const results = [];

  if (!args.codexOnly) {
    results.push(syncClaudeMcp(REPO_ROOT, args.check));
  }

  if (!args.claudeOnly) {
    results.push(syncCodexConfig(REPO_ROOT, args.check));
  }

  if (args.check) {
    const needsUpdate = results.some(r => r.needsUpdate);
    if (needsUpdate) {
      console.log('[mcp-sync] Some files need updating. Run without --check to apply.');
      process.exit(1);
    }
    console.log('[mcp-sync] All files up to date.');
  } else {
    const updated = results.filter(r => r.updated).length;
    console.log(`[mcp-sync] Done. ${updated} file(s) updated.`);
  }
}

main();
