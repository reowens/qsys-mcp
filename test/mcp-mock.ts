import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMockQrc } from './mock-qrc.js';
import { buildServer } from '../src/server.js';

/**
 * Offline end-to-end test: drive the real MCP server (over an in-memory
 * transport) against the mock QRC server — no hardware. Proves tool
 * registration, the response-shaping params, the change-group tools, and
 * disconnect, all through the actual MCP request/response path.
 */
const EXPECTED_TOOLS = [
  'qsys_connect',
  'qsys_status',
  'qsys_list_components',
  'qsys_get_component_controls',
  'qsys_get_control',
  'qsys_get_component',
  'qsys_set_control',
  'qsys_set_component',
  'qsys_load_snapshot',
  'qsys_save_snapshot',
  'qsys_create_change_group',
  'qsys_poll_change_group',
  'qsys_change_group_add_component',
  'qsys_change_group_remove',
  'qsys_change_group_clear',
  'qsys_change_group_invalidate',
  'qsys_destroy_change_group',
  'qsys_disconnect',
].sort();

async function main(): Promise<void> {
  const mock = await startMockQrc();
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'qsys-mcp-mocktest', version: '0.0.0' });
  await client.connect(clientTransport);

  const text = (r: any): string => (r?.content?.[0]?.text ?? '').toString();
  const json = (r: any) => JSON.parse(text(r));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    if (r?.isError) throw new Error(`${name}: ${text(r)}`);
    return r;
  };

  // Tool registration
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, EXPECTED_TOOLS, `registered tools should be exactly the ${EXPECTED_TOOLS.length} expected`);

  await call('qsys_connect', { host: '127.0.0.1', port: mock.port });

  // Response shaping — qsys_list_components
  const all = json(await call('qsys_list_components'));
  assert.equal(all.length, 3, 'default list returns all 3 mock components');
  const gains = json(await call('qsys_list_components', { type: 'gain' }));
  assert.equal(gains.length, 2, 'type filter -> 2 gain components');
  const mixers = json(await call('qsys_list_components', { filter: 'mixer' }));
  assert.equal(mixers.length, 1, 'name filter -> 1 component');
  const compNamesOnly = json(await call('qsys_list_components', { names_only: true }));
  assert.deepEqual(Object.keys(compNamesOnly[0]).sort(), ['Name', 'Type'], 'names_only drops Properties/ID');

  // Response shaping — qsys_get_component_controls
  const cc = json(await call('qsys_get_component_controls', { name: 'Gain1' }));
  assert.ok(cc.Controls.length >= 2, 'Gain1 exposes >= 2 controls');
  const muteOnly = json(await call('qsys_get_component_controls', { name: 'Gain1', filter: 'mute' }));
  assert.equal(muteOnly.Controls.length, 1, 'control filter -> mute only');
  const ctrlNamesOnly = json(await call('qsys_get_component_controls', { name: 'Gain1', names_only: true }));
  assert.ok(
    ctrlNamesOnly.Controls.every((c: unknown) => typeof c === 'string'),
    'names_only returns control names as strings',
  );

  // New change-group tools
  await call('qsys_change_group_add_component', { id: 'g', component: 'Gain1', controls: ['gain'] });
  const poll = json(await call('qsys_poll_change_group', { id: 'g' }));
  assert.ok(poll.Changes.find((c: any) => c.Name === 'gain'), 'poll sees the watched component control');

  // Invalidate -> next poll resends the watched control
  json(await call('qsys_poll_change_group', { id: 'g' })); // drain (no changes)
  await call('qsys_change_group_invalidate', { id: 'g' });
  const reSent = json(await call('qsys_poll_change_group', { id: 'g' }));
  assert.ok(reSent.Changes.find((c: any) => c.Name === 'gain'), 'invalidate resends the control');

  // Remove + Clear leave the group pollable (no error), unlike Destroy
  await call('qsys_create_change_group', { id: 'g2', controls: ['MainGain', 'MainMute'] });
  await call('qsys_change_group_remove', { id: 'g2', controls: ['MainGain'] });
  await call('qsys_change_group_clear', { id: 'g2' });
  assert.ok(!(await client.callTool({ name: 'qsys_poll_change_group', arguments: { id: 'g2' } }) as any)?.isError, 'cleared group still polls');

  // Snapshots round-trip through the tool layer
  await call('qsys_save_snapshot', { bank: 'MyBank', number: 1 });
  await call('qsys_load_snapshot', { bank: 'MyBank', number: 1, ramp: 2 });

  await call('qsys_destroy_change_group', { id: 'g' });
  const afterDestroy: any = await client.callTool({ name: 'qsys_poll_change_group', arguments: { id: 'g' } });
  assert.ok(afterDestroy?.isError, 'polling a destroyed group errors');

  // Live-Core write warning: reconnect to a non-emulator mock and confirm writes warn.
  const liveMock = await startMockQrc(0, { isEmulator: false });
  await call('qsys_connect', { host: '127.0.0.1', port: liveMock.port });
  const setWarned = json(await call('qsys_set_control', { name: 'MainGain', value: -5 }));
  assert.ok(/LIVE/.test(setWarned.warning ?? ''), 'set_control on a live Core returns a warning');
  const loadWarned = json(await call('qsys_load_snapshot', { bank: 'B', number: 1 }));
  assert.ok(/LIVE/.test(loadWarned.warning ?? ''), 'load_snapshot on a live Core returns a warning');

  // Disconnect (from the live mock — clean, no reconnect storm)
  const disc = json(await call('qsys_disconnect'));
  assert.equal(disc.disconnected, true, 'disconnect reports success');
  const afterDisconnect: any = await client.callTool({ name: 'qsys_status', arguments: {} });
  assert.ok(afterDisconnect?.isError, 'tools error after disconnect (not connected)');

  await client.close();
  await liveMock.close();
  await mock.close();
  console.log(`PASS: MCP-over-mock (${EXPECTED_TOOLS.length} tools, shaping + snapshots + change-group lifecycle + live-Core warning + disconnect)`);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
