import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Live Named-Control round-trip via the MCP server against a real target
 * (emulator/Core). Proves the Control.Get / Control.Set + ChangeGroup.* path that
 * the mock covers but no live design did — because the training worksheet exposes
 * component controls, not Named Controls. Requires a design with a Named Control
 * (Control Pin in the Named Controls pane) running in Emulate mode (F6).
 *
 *   npx tsx test/live-named.ts <controlName> [host] [port]
 *
 * Reads the control, watches it via a change group, sets it to a distinct value,
 * verifies the read-back AND that the poll reports the change, then RESTORES the
 * original value and destroys the change group. Nothing persists unless the design
 * is saved in Designer.
 */
async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: npx tsx test/live-named.ts <controlName> [host] [port]');
    process.exit(2);
  }
  const host = process.argv[3] ?? '127.0.0.1';
  const port = Number(process.argv[4] ?? 1710);

  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
  const client = new Client({ name: 'qsys-mcp-named', version: '0.0.0' });
  await client.connect(transport);

  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name: tool, arguments: args });
    const text = (r?.content?.[0]?.text ?? '').toString();
    if (r?.isError) throw new Error(`${tool} failed: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const cgId = 'live-named-smoke';
  await call('qsys_connect', { host, port });

  // 1. Read the Named Control (Control.Get returns an array).
  const got: Array<{ Name: string; Value: unknown; String?: string }> = await call('qsys_get_control', { names: [name] });
  if (!Array.isArray(got) || !got.length || got[0].Name !== name) {
    throw new Error(`Control.Get did not return "${name}" — is it exposed as a Named Control (Control Pin)? got: ${JSON.stringify(got)}`);
  }
  const orig = got[0].Value;
  console.log(`Named Control "${name}" | original value: ${JSON.stringify(orig)} (${typeof orig})`);

  // Derive a distinct, type-appropriate target. 0↔1 is valid for a gain (0 dB ↔ 1 dB),
  // a normalized position, and a 0/1 toggle alike; booleans just flip.
  let target: number | boolean;
  if (typeof orig === 'boolean') target = !orig;
  else if (typeof orig === 'number') target = orig === 0 ? 1 : 0;
  else throw new Error(`control "${name}" is type ${typeof orig}; expose a numeric/boolean Named Control (fader, mute, toggle) so the smoke can set & restore it`);
  console.log(`target value: ${JSON.stringify(target)}`);

  // 2. Watch it via a change group; first poll establishes the baseline.
  await call('qsys_create_change_group', { id: cgId, controls: [name] });
  const baseline: { Id: string; Changes: Array<{ Name: string; Value: unknown }> } = await call('qsys_poll_change_group', { id: cgId });
  console.log(`change group "${cgId}" baseline poll: ${baseline.Changes.length} change(s)`);

  try {
    // 3. Set → read back → assert changed.
    await call('qsys_set_control', { name, value: target });
    const after: Array<{ Name: string; Value: unknown }> = await call('qsys_get_control', { names: [name] });
    const read = after[0].Value;
    console.log(`set -> ${JSON.stringify(target)} | read back: ${JSON.stringify(read)}`);
    const matches = typeof target === 'number' ? Math.abs(Number(read) - target) < 0.6 : read === target;
    if (!matches) throw new Error(`write not reflected: expected ${JSON.stringify(target)}, got ${JSON.stringify(read)}`);
    if (read === orig) throw new Error('value did not change');

    // 4. Poll the change group — it must report the mutated control.
    const poll: { Id: string; Changes: Array<{ Name: string; Value: unknown }> } = await call('qsys_poll_change_group', { id: cgId });
    const hit = poll.Changes.find((c) => c.Name === name);
    if (!hit) throw new Error(`change group did not report "${name}" after the set — Changes: ${JSON.stringify(poll.Changes)}`);
    console.log(`change group reported "${name}" = ${JSON.stringify(hit.Value)} ✓`);
    console.log('NAMED CONTROL READ/SET + CHANGE GROUP CONFIRMED ✓');
  } finally {
    // 5. Restore the original value and free the change group.
    await call('qsys_set_control', { name, value: orig as number | string | boolean });
    const restored: Array<{ Value: unknown }> = await call('qsys_get_control', { names: [name] });
    console.log(`restored -> ${JSON.stringify(restored[0].Value)} (original ${JSON.stringify(orig)})`);
    await call('qsys_destroy_change_group', { id: cgId });
  }

  await client.close();
  console.log('LIVE NAMED OK');
}

main().catch((e) => {
  console.error('LIVE NAMED FAIL:', e);
  process.exit(1);
});
