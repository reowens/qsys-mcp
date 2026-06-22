import { QrcClient } from '../src/qrc.js';

/**
 * Keepalive smoke against a LIVE Q-SYS target (real Core or Designer Emulate mode).
 * QRC closes an idle socket after 60s; QrcClient sends a NoOp every 30s
 * (qrc.ts:142) to hold it open. We connect, idle past the 60s window, then prove
 * the SAME socket still answers StatusGet — i.e. the keepalive did its job.
 *   npx tsx test/keepalive.ts [host] [port] [idleMs]
 */
async function main(): Promise<void> {
  const host = process.argv[2] ?? '127.0.0.1';
  const port = Number(process.argv[3] ?? 1710);
  const idleMs = Number(process.argv[4] ?? 70_000);

  const c = new QrcClient({ host, port });
  c.on('error', (e) => console.error('socket error:', (e as Error).message));

  await c.connect();
  const before = await c.statusGet();
  console.log(`connected | design: ${before.DesignName} | emulator: ${before.IsEmulator}`);
  console.log(`idling ${Math.round(idleMs / 1000)}s (QRC idle close is 60s; NoOp keepalive fires every 30s)…`);

  let droppedDuringIdle = false;
  c.on('close', () => { droppedDuringIdle = true; });

  const tick = 10_000;
  let waited = 0;
  while (waited < idleMs) {
    const step = Math.min(tick, idleMs - waited);
    await new Promise((r) => setTimeout(r, step));
    waited += step;
    if (droppedDuringIdle) {
      throw new Error(`socket closed at ~${Math.round(waited / 1000)}s — keepalive did NOT hold the connection`);
    }
    console.log(`  …${Math.round(waited / 1000)}s elapsed, connected: ${c.isConnected()}`);
  }

  if (droppedDuringIdle || !c.isConnected()) {
    throw new Error('connection dropped during idle — keepalive failed');
  }

  const after = await c.statusGet();
  console.log(`post-idle StatusGet OK | design: ${after.DesignName} | state: ${after.State}`);

  c.close();
  console.log('KEEPALIVE OK');
}

main().catch((e) => {
  console.error('KEEPALIVE FAIL:', e);
  process.exit(1);
});
