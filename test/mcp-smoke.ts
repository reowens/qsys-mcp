import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Full-path smoke: spawn the built MCP server over stdio and drive it as a
 * client would (list tools, connect, list components) against a live target.
 *   npx tsx test/mcp-smoke.ts [host] [port]
 */
async function main(): Promise<void> {
  const host = process.argv[2] ?? '127.0.0.1';
  const port = Number(process.argv[3] ?? 1710);

  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
  const client = new Client({ name: 'q-sys-mcp-smoke', version: '0.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(', '));

  const text = (r: any): string => (r?.content?.[0]?.text ?? '').toString();

  const conn = await client.callTool({ name: 'qsys_connect', arguments: { host, port } });
  console.log('qsys_connect ->', text(conn).slice(0, 220).replace(/\s+/g, ' '));

  const comps = await client.callTool({ name: 'qsys_list_components', arguments: {} });
  const list = text(comps);
  const names = [...list.matchAll(/"Name":\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log(`qsys_list_components -> ${names.length} components:`, names.slice(0, 6).join(', '), names.length > 6 ? '…' : '');

  await client.close();
  console.log('MCP SMOKE OK');
}

main().catch((e) => {
  console.error('MCP SMOKE FAIL:', e);
  process.exit(1);
});
