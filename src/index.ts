#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; logs go to stderr.
  console.error('q-sys-mcp running on stdio');
}

main().catch((err) => {
  console.error('fatal error:', err);
  process.exit(1);
});
