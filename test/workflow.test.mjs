import test from 'node:test';
import assert from 'node:assert/strict';
import { endJob, checkAttempt } from '../src/workflow.mjs';

function fixture() {
  const events = []; const preview = { host: 'host', job: 'job', sol: { totalDebitLamports: 5000n } };
  const chain = {
    assertUnchanged: async () => events.push('recheck'),
    prepare: async () => { events.push('prepare'); return preview; },
    signPrepared: async () => { events.push('sign'); return { signature: 'signature', job: 'job' }; },
    submit: async () => events.push('submit'),
    reconcile: async () => { events.push('reconcile'); return { status: 'finalized', receivedNosBaseUnits: '0' }; },
  };
  const journals = {
    lock: async () => { events.push('lock'); return async () => events.push('unlock'); },
    list: async () => [], save: async signed => { events.push('save'); return { signed }; },
    update: async () => events.push('update'),
  };
  const resultStore = { publishVerified: async () => { events.push('pin'); return 'real-cid'; } };
  return { chain, preview, journals, resultStore, events, identity: { host: 'host', signer: {} }, resultChoice: {} };
}
test('no/Enter/cancel performs no publish, sign or send', async () => {
  const f = fixture();
  assert.equal((await endJob({ ...f, confirm: async () => false })).status, 'cancelled');
  assert.deepEqual(f.events, ['lock', 'unlock']);
});
test('sign only after confirmation, durable save before send, then reconcile receipt', async () => {
  const f = fixture();
  const result = await endJob({ ...f, confirm: async () => { f.events.push('yes'); return true; } });
  assert.equal(result.status, 'finalized');
  assert(f.events.indexOf('yes') < f.events.indexOf('pin'));
  assert(f.events.indexOf('pin') < f.events.indexOf('sign'));
  assert(f.events.indexOf('save') < f.events.indexOf('submit'));
  assert(f.events.indexOf('submit') < f.events.indexOf('reconcile'));
});
test('failed journal save cannot send; ambiguous send reconciles without resigning', async () => {
  const f = fixture(); f.journals.save = async () => { throw new Error('disk full'); };
  await assert.rejects(endJob({ ...f, confirm: async () => true }), /disk full/);
  assert(!f.events.includes('submit'));
  const g = fixture(); g.chain.submit = async () => { g.events.push('submit'); throw new Error('timeout'); };
  assert.equal((await endJob({ ...g, confirm: async () => true })).status, 'finalized');
  assert.equal(g.events.filter(e => e === 'sign').length, 1);
});
test('changed state or increased SOL cost stops before signing', async () => {
  const f = fixture(); f.chain.assertUnchanged = async () => { throw new Error('changed state'); };
  await assert.rejects(endJob({ ...f, confirm: async () => true }), /changed state/);
  assert(!f.events.includes('pin')); assert(!f.events.includes('sign'));
  const g = fixture(); g.chain.prepare = async () => ({ ...g.preview, sol: { totalDebitLamports: 6000n } });
  await assert.rejects(endJob({ ...g, confirm: async () => true }), /cost increased/);
  assert(!g.events.includes('sign'));
});
test('pending journal blocks another signature and recovery resends identical record only after yes', async () => {
  const f = fixture(); f.journals.list = async () => [{}];
  await assert.rejects(endJob({ ...f, confirm: async () => true }), /previous submission/);
  assert(!f.events.includes('sign'));
  const g = fixture(); const signed = { job: 'job', wire: 'same-bytes', signature: 'sig' }; let calls = 0;
  g.chain.reconcile = async () => ({ status: ++calls === 1 ? 'pending' : 'finalized' });
  g.chain.submit = async actual => assert.equal(actual, signed);
  const result = await checkAttempt({ ...g, entry: { signed }, confirmRebroadcast: async () => true });
  assert.equal(result.status, 'finalized'); assert(!g.events.includes('sign'));
});
