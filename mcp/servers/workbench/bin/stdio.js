#!/usr/bin/env node
/**
 * Workbench MCP Server - stdio transport
 *
 * Usage:
 *   node bin/stdio.js
 *   npx @workbench/mcp
 *
 * Environment:
 *   WORKBENCH_STATE_DIR - State directory (default: .workbench in cwd)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamic import of core (handles ES module resolution)
const { TOOLS, WorkbenchMcpHandler } = await import(path.join(__dirname, '..', 'src', 'core.js'));

const stateDir = process.env.WORKBENCH_STATE_DIR || path.join(process.cwd(), '.workbench');
const handler = new WorkbenchMcpHandler(stateDir);

// Create MCP server
const server = new Server(
  {
    name: 'workbench-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.entries(TOOLS).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;

  if (!TOOLS[name]) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  return handler.handleToolCall(name, toolArgs || {});
});

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is for MCP protocol)
  console.error(`Workbench MCP server started (stdio)`);
  console.error(`State directory: ${stateDir}`);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
