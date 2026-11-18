import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JournalStore } from '../src/journal.mjs';
const job = '11111111111111111111111111111111';
const signature = '2'.repeat(88);
test('private durable journal retains exact signed bytes and immutable signature', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nosana-journal-'));
  const store = new JournalStore(join(root, 'state'));
  try {
    const entry = await store.save({ signature, job, host: job, wire: 'fixture-wire', lastValidBlockHeight: 123n });
    assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(store.directory, `${signature}.json`))).mode & 0o777, 0o600);
    assert.equal((await store.read(signature)).signed.wire, 'fixture-wire');
    assert.equal((await store.list({ pendingOnly: true })).length, 1);
    await store.update(entry, { status: 'finalized', receivedNosBaseUnits: '0' });
    assert.equal((await store.list({ pendingOnly: true })).length, 0);
    await assert.rejects(store.save(entry.signed), /already has/);
    await assert.rejects(store.update({ ...entry, signed: { ...entry.signed, wire: 'changed' } }, { status: 'pending' }), /changed unexpectedly/);
    await assert.rejects(store.read('../escape'), /Invalid journal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('kernel lock blocks concurrent signers and releases on normal completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nosana-lock-'));
  try {
    const store = new JournalStore(root);
    const unlock = await store.lock(job);
    await assert.rejects(store.lock(job), /Another instance/);
    await unlock();
    const unlockAgain = await store.lock(job); await unlockAgain();
  } finally { await rm(root, { recursive: true, force: true }); }
});
