import { QrcClient, type QrcComponent } from '../src/qrc.js';

/**
 * Read-only smoke test against a LIVE Q-SYS target (real Core or Designer in
 * Emulate mode). Does not mutate the design. Usage:
 *   npx tsx test/live-smoke.ts [host] [port]
 */
async function main(): Promise<void> {
  const host = process.argv[2] ?? '127.0.0.1';
  const port = Number(process.argv[3] ?? 1710);

  const c = new QrcClient({ host, port });
  c.on('engineStatus', (s) => console.log('EngineStatus:', JSON.stringify(s)));
  await c.connect();

  const status = await c.statusGet();
  console.log(`Design: ${status.DesignName} | Platform: ${status.Platform} | State: ${status.State} | Emulator: ${status.IsEmulator}`);

  const comps = (await c.getComponents()) as QrcComponent[];
  console.log(`Components (${comps.length}):`);
  for (const x of comps.slice(0, 15)) console.log(`  - ${x.Name} [${x.Type}]`);
  if (comps.length > 15) console.log(`  … and ${comps.length - 15} more`);

  if (comps.length) {
    const first = comps[0].Name;
    try {
      const ctrls = await c.getComponentControls(first);
      console.log(`Controls of "${first}" (${ctrls.Controls.length}):`);
      for (const ctl of ctrls.Controls.slice(0, 10)) console.log(`  ${ctl.Name} = ${ctl.Value}`);
    } catch (e) {
      console.log(`  (could not read controls of ${first}: ${(e as Error).message})`);
    }
  }

  c.close();
  console.log('LIVE SMOKE OK');
}

main().catch((e) => {
  console.error('LIVE SMOKE FAIL:', e);
  process.exit(1);
});
