import test from 'node:test';
import assert from 'node:assert/strict';
import { createResultStore, interruptionReport, validateCid } from '../src/results.mjs';
const cid = 'QmYwAPJzv5CZsnAzt8auVZRnGiRA1RcUjh6yHGKJfs9q2w';
test('result record truthfully marks unknown work and excludes invented duration', () => {
  const report = interruptionReport({ job: 'job', host: 'host', recordedAt: '2026-01-01T00:00:00Z' });
  assert.equal(report.status, 'stopped'); assert.equal(report.startTime, 0); assert.equal(report.endTime, null);
  assert.deepEqual(report.opStates, []);
  assert.match(report.errors[0].message, /not independently verified/);
  assert.equal(report.errors[0].node, 'host');
  assert.throws(() => validateCid('https://evil.invalid/Qm...'));
});
test('pin uses required envelope, CIDv0, exact endpoints and verified readback', async () => {
  const calls = []; const report = interruptionReport({ job: 'job', host: 'host' });
  const store = createResultStore({ jwt: 'test-only', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method === 'POST' ? { IpfsHash: cid } : report);
  }});
  assert.equal(await store.publishVerified(report), cid);
  assert.deepEqual(calls.map(c => c.url), ['https://api.pinata.cloud/pinning/pinJSONToIPFS', `https://nosana.mypinata.cloud/ipfs/${cid}`]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { pinataContent: report, pinataOptions: { cidVersion: 0 } });
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].options.headers, undefined);
});
test('pin failure, changed readback and a different-job result fail closed', async () => {
  const failed = createResultStore({ fetchImpl: async () => new Response('denied', { status: 403 }) });
  await assert.rejects(failed.publishVerified({}), /HTTP 403/);
  const changed = createResultStore({ fetchImpl: async (_, options) => Response.json(options.method === 'POST' ? { IpfsHash: cid } : {}) });
  await assert.rejects(changed.publishVerified({ status: 'stopped' }), /Nothing was signed/);
  const different = createResultStore({ fetchImpl: async () => Response.json({ status: 'stopped', opStates: [], job: 'other' }) });
  await assert.rejects(different.verifyExisting(cid, 'job'), /different job/);
});
test('existing interruption results must identify the selected job and, when supplied, host', async () => {
  const storeFor = errors => createResultStore({ fetchImpl: async () => Response.json({ status: 'stopped', opStates: [], errors }) });
  const matching = storeFor([{ event: 'manual-termination-request', job: 'selected-job', node: 'selected-host' }]);
  assert.deepEqual(await matching.verifyExisting(cid, 'selected-job', 'selected-host'), { cid, status: 'stopped' });
  const wrongJob = storeFor([{ event: 'manual-termination-request', job: 'other-job', node: 'selected-host' }]);
  await assert.rejects(wrongJob.verifyExisting(cid, 'selected-job', 'selected-host'), /different job/);
  const wrongHost = storeFor([{ event: 'manual-termination-request', job: 'selected-job', node: 'other-host' }]);
  await assert.rejects(wrongHost.verifyExisting(cid, 'selected-job', 'selected-host'), /different host/);
  assert.deepEqual(await wrongHost.verifyExisting(cid, 'selected-job'), { cid, status: 'stopped' });
  const laterMismatch = storeFor([
    { event: 'manual-termination-request', job: 'selected-job', node: 'selected-host' },
    { event: 'manual-termination-request', job: 'other-job', node: 'selected-host' },
  ]);
  await assert.rejects(laterMismatch.verifyExisting(cid, 'selected-job', 'selected-host'), /different job/);
});
test('existing result checks preserve legacy results and ignore unrelated error metadata', async () => {
  const storeFor = result => createResultStore({ fetchImpl: async () => Response.json(result) });
  const legacy = storeFor({ status: 'success', opStates: [] });
  assert.deepEqual(await legacy.verifyExisting(cid, 'selected-job', 'selected-host'), { cid, status: 'success' });
  const unrelated = storeFor({ status: 'stopped', opStates: [], errors: [null, { event: 'other-event', job: 'operation-id', node: 'operation-name' }] });
  assert.deepEqual(await unrelated.verifyExisting(cid, 'selected-job', 'selected-host'), { cid, status: 'stopped' });
  const topLevelId = storeFor({ status: 'stopped', opStates: [], id: 'other-job' });
  await assert.rejects(topLevelId.verifyExisting(cid, 'selected-job', 'selected-host'), /different job/);
});
