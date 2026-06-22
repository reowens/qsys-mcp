import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startMockQrc } from './mock-qrc.js';
import { QrcClient } from '../src/qrc.js';

/**
 * Transparent auto-reconnect, offline against the mock QRC server. Covers:
 *  1. Replay after a Core-restart (state wiped): logon + named-control group +
 *     component-control group are all re-established on the fresh socket.
 *  2. Send-driven recovery — a tool call alone drives the reconnect.
 *  3. `reconnect: false` opt-out — stays down after a drop.
 *  4. A timeout (socket still up) must NOT trigger a reconnect.
 *  5. Give-up after maxAttempts (`reconnectFailed`) + on-demand re-trigger on
 *     the next request.
 *
 * The replay proof: after the socket drops AND the server forgets its change
 * groups (resetState), polling the same group id still works — only possible if
 * the client replayed its registrations; without replay the mock answers
 * "Unknown change group".
 */
const HOST = '127.0.0.1';

function once(emitter: EventEmitter, event: string, timeoutMs: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    t.unref?.();
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args);
    });
  });
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error('FAIL: reconnect test watchdog fired (something hung)');
    process.exit(1);
  }, 15_000);
  watchdog.unref?.();

  const mock = await startMockQrc();
  const client = new QrcClient({
    host: HOST,
    port: mock.port,
    reconnectInitialMs: 20,
    reconnectMaxMs: 60,
    reconnectMaxAttempts: 50,
    requestTimeoutMs: 1000,
    keepAliveMs: 60_000, // keep NoOp out of the way of the test
  });

  await client.connect();
  await client.logon('admin', 'secret'); // so reconnect must replay the logon
  const logonsBefore = mock.logonCount();

  // Register both a named-control group and a component-control group.
  await client.changeGroupAddControl('cg1', ['MainGain']);
  await client.changeGroupAddComponentControl('cgc', 'Gain1', ['gain']);
  assert.ok(
    (await client.changeGroupPoll('cg1')).Changes.find((c) => c.Name === 'MainGain'),
    'initial poll includes MainGain',
  );
  assert.ok(
    (await client.changeGroupPoll('cgc')).Changes.find((c) => c.Name === 'gain'),
    'initial component-group poll includes gain',
  );

  // 1) Event-driven reconnect + full replay across a Core-restart (state wiped).
  const reconnected = once(client, 'reconnected', 5000);
  mock.resetState();        // server forgets cg1 + cgc
  mock.dropConnections();   // socket drops
  await reconnected;
  assert.equal(mock.logonCount(), logonsBefore + 1, 'logon was replayed on reconnect');
  assert.ok(
    (await client.changeGroupPoll('cg1')).Changes.find((c) => c.Name === 'MainGain'),
    'named-control group replayed (poll works on the fresh server)',
  );
  assert.ok(
    (await client.changeGroupPoll('cgc')).Changes.find((c) => c.Name === 'gain'),
    'component-control group replayed (poll works on the fresh server)',
  );

  // 2) Transparent send-driven recovery: a tool call alone drives the reconnect.
  mock.resetState();
  mock.dropConnections();
  const status = await client.statusGet(); // no manual reconnect, no waiting on events
  assert.equal(status.IsEmulator, true, 'statusGet transparently reconnects and returns');

  // A write also round-trips after recovery.
  await client.setControl('MainGain', -8);
  assert.equal((await client.getControl(['MainGain']))[0].Value, -8, 'set/get works post-reconnect');

  client.close();

  // 3) reconnect:false stays down after a drop — the opt-out works.
  const noReconnect = new QrcClient({ host: HOST, port: mock.port, reconnect: false, requestTimeoutMs: 1000, keepAliveMs: 60_000 });
  let sawReconnecting = false;
  noReconnect.on('reconnecting', () => {
    sawReconnecting = true;
  });
  await noReconnect.connect();
  await noReconnect.statusGet(); // round-trip so the mock has registered the socket before we drop it
  mock.dropConnections();
  await assert.rejects(
    () => noReconnect.statusGet(),
    /QRC not connected|QRC connection closed/,
    'reconnect:false → no auto-recovery',
  );
  assert.equal(sawReconnecting, false, 'reconnect:false never attempts a reconnect');
  noReconnect.close();

  // 4) A request timeout (socket still up) must NOT be mistaken for a drop.
  const slow = new QrcClient({ host: HOST, port: mock.port, requestTimeoutMs: 200, keepAliveMs: 60_000 });
  let slowReconnecting = false;
  slow.on('reconnecting', () => {
    slowReconnecting = true;
  });
  await slow.connect();
  await slow.statusGet();
  mock.swallowNext('Control.Get'); // Core goes silent for one request
  await assert.rejects(() => slow.getControl(['MainGain']), /timed out/, 'a silent Core times out the request');
  assert.equal(slowReconnecting, false, 'a timeout (socket still up) must not trigger a reconnect');
  assert.ok((await slow.getControl(['MainGain'])).length >= 1, 'connection still usable after a timeout');
  slow.close();

  // 5) Give up after maxAttempts, then re-trigger on the next request.
  // Reconnect backoff timers are unref'd (in production the stdio transport keeps
  // the loop alive); an isolated test must hold the loop open itself.
  const anchor = setInterval(() => {}, 1000);
  const dying = new QrcClient({
    host: HOST,
    port: mock.port,
    reconnectInitialMs: 20,
    reconnectMaxMs: 40,
    reconnectMaxAttempts: 3,
    requestTimeoutMs: 300,
    keepAliveMs: 60_000,
  });
  let attempts = 0;
  dying.on('reconnecting', () => {
    attempts++;
  });
  dying.on('error', () => {}); // swallow ECONNRESET stderr noise
  const failed = once(dying, 'reconnectFailed', 5000);
  await dying.connect();
  await dying.statusGet();
  const closing = mock.close(); // stop accepting first...
  mock.dropConnections();       // ...then drop, so reconnect attempts hit a closed port
  await failed;
  assert.ok(attempts >= 3, 'tried reconnectMaxAttempts (3) before giving up');
  const attemptsAfterGiveUp = attempts;
  await assert.rejects(() => dying.statusGet(), /QRC not connected/, 'a request after give-up still rejects');
  assert.ok(attempts > attemptsAfterGiveUp, 'a request after give-up re-triggers reconnection');
  dying.close();
  clearInterval(anchor);
  await closing;

  clearTimeout(watchdog);
  console.log('PASS: auto-reconnect (logon+named+component replay, send-driven, opt-out, timeout≠drop, give-up+re-trigger)');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
