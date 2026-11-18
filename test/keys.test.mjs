import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from '@solana/kit';
import { loadHostKey, expandPath, publicHost } from '../src/keys.mjs';

test('key menu paths expand ~ and quotes without shell evaluation', () => {
  assert.equal(expandPath('"~/My keys/host.json"', '/home/alice'), '/home/alice/My keys/host.json');
  assert.equal(expandPath('/tmp/$(touch stolen)'), '/tmp/$(touch stolen)');
  assert.throws(() => expandPath('~other/key.json'));
  assert.throws(() => publicHost('not a key'));
});
test('loads an isolated key, validates both halves, rejects malformed/large files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nosana-key-test-'));
  try {
    // Deterministic test-only seed; never a user key or a funded account.
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const key = [...seed, ...getAddressEncoder().encode(signer.address)];
    const path = join(dir, 'test key.json');
    await writeFile(path, JSON.stringify(key), { mode: 0o600 });
    const loaded = await loadHostKey(path);
    assert.equal(loaded.host, signer.address);
    assert.equal(loaded.permissionWarning, false);
    assert.equal(loaded.signer.address, signer.address);
    await symlink(path, join(dir, 'chosen-link'));
    assert.equal((await loadHostKey(join(dir, 'chosen-link'))).host, signer.address);
    key[63] ^= 1;
    await writeFile(path, JSON.stringify(key));
    await assert.rejects(loadHostKey(path), /do not match/);
    await writeFile(path, '[1, 2, 3]');
    await assert.rejects(loadHostKey(path), /64 byte/);
    await writeFile(path, 'x'.repeat(4097));
    await assert.rejects(loadHostKey(path), /small, regular/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
