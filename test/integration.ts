import assert from 'node:assert/strict';
import { startMockQrc } from './mock-qrc.js';
import { QrcClient } from '../src/qrc.js';

async function main(): Promise<void> {
  const mock = await startMockQrc();
  const client = new QrcClient({ host: '127.0.0.1', port: mock.port });

  let gotEngineStatus = false;
  client.on('engineStatus', () => {
    gotEngineStatus = true;
  });

  await client.connect();
  await new Promise((r) => setTimeout(r, 50)); // let the unsolicited EngineStatus arrive
  assert.ok(gotEngineStatus, 'should receive an EngineStatus notification on connect');

  const status = await client.statusGet();
  assert.equal(status.State, 'Active');
  assert.equal(status.Platform, 'MockEmulator');
  assert.equal(status.IsEmulator, true);

  const comps = await client.getComponents();
  assert.ok(Array.isArray(comps) && comps.length > 0, 'components should be a non-empty array');
  assert.equal(comps[0].Name, 'Gain1');

  const cc = await client.getComponentControls('Gain1');
  assert.equal(cc.Name, 'Gain1');
  assert.ok(cc.Controls.find((c) => c.Name === 'gain'), 'Gain1 should expose a "gain" control');

  // Named-control write round-trip
  await client.setControl('MainGain', -3);
  const got = await client.getControl(['MainGain']);
  assert.equal(got[0].Value, -3, 'MainGain should read back as -3 after set');

  // Ramped set should also succeed
  await client.setControl('MainGain', -20, 1.5);
  assert.equal((await client.getControl(['MainGain']))[0].Value, -20);

  // Component control write round-trip
  await client.setComponent('Gain1', [{ Name: 'gain', Value: -12 }]);
  const cget = await client.getComponent('Gain1', ['gain']);
  assert.equal(cget.Controls[0].Value, -12, 'Gain1.gain should read back as -12');

  // Change group: first poll returns initial state, second returns only the change
  await client.changeGroupAddControl('cg1', ['MainGain']);
  const poll1 = await client.changeGroupPoll('cg1');
  assert.ok(poll1.Changes.find((c) => c.Name === 'MainGain'), 'first poll should include MainGain');
  await client.setControl('MainGain', 5);
  const poll2 = await client.changeGroupPoll('cg1');
  assert.equal(poll2.Changes.length, 1, 'second poll should report exactly one change');
  assert.equal(poll2.Changes[0].Value, 5);

  // Component-control change group (ChangeGroup.AddComponentControl)
  await client.changeGroupAddComponentControl('cg2', 'Gain1', ['gain']);
  const cpoll1 = await client.changeGroupPoll('cg2');
  assert.ok(cpoll1.Changes.find((c) => c.Name === 'gain'), 'first poll should include the component control');
  await client.setComponent('Gain1', [{ Name: 'gain', Value: 7 }]);
  const cpoll2 = await client.changeGroupPoll('cg2');
  assert.equal(cpoll2.Changes.length, 1, 'second poll should report exactly one component-control change');
  assert.equal(cpoll2.Changes[0].Value, 7);

  // Invalidate forces a full resend on the next poll (ChangeGroup.Invalidate)
  assert.equal((await client.changeGroupPoll('cg1')).Changes.length, 0, 'no changes since last poll');
  await client.changeGroupInvalidate('cg1');
  assert.ok(
    (await client.changeGroupPoll('cg1')).Changes.find((c) => c.Name === 'MainGain'),
    'invalidate resends MainGain on the next poll',
  );

  // Remove drops a single control, leaving the group in place (ChangeGroup.Remove)
  await client.changeGroupAddControl('cg1', ['MainMute']);
  await client.changeGroupPoll('cg1'); // baseline both
  await client.setControl('MainGain', 11);
  await client.setControl('MainMute', 1);
  await client.changeGroupRemove('cg1', ['MainGain']);
  const afterRemove = await client.changeGroupPoll('cg1');
  assert.ok(afterRemove.Changes.find((c) => c.Name === 'MainMute'), 'MainMute still watched after remove');
  assert.ok(!afterRemove.Changes.find((c) => c.Name === 'MainGain'), 'MainGain no longer watched after remove');

  // Clear empties the group but keeps it pollable (ChangeGroup.Clear)
  await client.changeGroupClear('cg1');
  assert.equal((await client.changeGroupPoll('cg1')).Changes.length, 0, 'cleared group reports nothing');

  // Snapshots: assert the wire shape — the tool's whole job is mapping bank->Name,
  // number->Bank (QRC's confusingly-named param), plus optional Ramp.
  await client.snapshotSave('MyBank', 3);
  assert.deepEqual(mock.lastSnapshotSave(), { Name: 'MyBank', Bank: 3 }, 'save maps bank->Name, number->Bank');
  await client.snapshotLoad('OtherBank', 5, 2.5);
  assert.deepEqual(mock.lastSnapshotLoad(), { Name: 'OtherBank', Bank: 5, Ramp: 2.5 }, 'load maps params incl. ramp');
  await client.snapshotLoad('OtherBank', 2);
  assert.deepEqual(mock.lastSnapshotLoad(), { Name: 'OtherBank', Bank: 2 }, 'load omits Ramp when not given');

  // Destroy frees the group (ChangeGroup.Destroy)
  await client.changeGroupDestroy('cg2');
  await assert.rejects(() => client.changeGroupPoll('cg2'), /Unknown change group/);

  // Error propagation: unknown component should reject as QrcError
  await assert.rejects(() => client.getComponentControls('NoSuchComponent'), /Unknown component/);

  client.close();
  await mock.close();
  console.log('PASS: all QRC integration assertions (snapshot param mapping + full change-group lifecycle)');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
