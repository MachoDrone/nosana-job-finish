#!/usr/bin/env node
// Execute the real pinned Nosana SBF program in an isolated LiteSVM bank.
// All keypairs/accounts below are public synthetic fixtures. No live signing.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { solBytesArrayToIpfsHash } from '@nosana/kit';
import { getTransactionDecoder } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import { createChain, SIMULATION_RESULT_CID } from '../src/chain.mjs';
import { createFixture, serveFixture, JOBS, NOS, GENESIS, PROGRAM_SHA256 } from '../test/localnet-fixtures.mjs';

const directory = resolve('.test-artifacts/localnet');
await mkdir(directory, { recursive: true, mode: 0o700 });
const cid = solBytesArrayToIpfsHash(Array(32).fill(9));
const startedAt = new Date().toISOString();
const checks = [];
const makeChain = bridge => createChain({ network: 'localnet', rpcUrl: bridge.rpcUrl,
  programs: { jobsAddress: JOBS, nosTokenAddress: NOS }, expectedGenesisHash: GENESIS, pollMs: 5 });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

async function check(name, options, action) {
  const start = performance.now(); let bridge;
  try {
    const fixture = await createFixture(options); bridge = await serveFixture(fixture);
    const chain = makeChain(bridge);
    const value = await action(fixture, bridge, chain);
    const result = { name, passed: true, elapsedMs: Math.round((performance.now() - start) * 1000) / 1000,
      rpcMethods: [...new Set(bridge.calls)], ...value };
    checks.push(result); console.log(`PASS ${name} (${result.elapsedMs} ms)`);
  } catch (error) {
    checks.push({ name, passed: false, elapsedMs: performance.now() - start,
      error: error.stack ?? String(error), rpcMethods: bridge?.calls });
    console.error(`FAIL ${name}: ${error.stack ?? error}`);
    throw error;
  } finally { if (bridge) await bridge.close(); }
}

async function settle(f, bridge, chain, expectedPayment, expectedRefund) {
  const beforeHostSol = f.svm.getBalance(f.host);
  const preview = await chain.prepare({ host: f.host, job: f.job, resultCid: cid });
  assert.equal(preview.payment.estimatedNosBaseUnits, expectedPayment);
  assert.equal(f.tokenAmount(f.nodeAta), f.nodeInitial, 'Preview changed VM balance');
  assert.equal(f.readJob().state, 0, 'Preview changed job state');
  await chain.assertUnchanged(preview);
  const signed = await chain.signPrepared(preview, f.signer);
  const journal = resolve(directory, `synthetic-journal-${checks.length}.json`);
  await writeFile(journal, json({ signed }) + '\n', { mode: 0o600 });
  await chain.simulateSigned(signed);
  assert.equal(f.readJob().state, 0, 'Signed simulation changed job state');
  await chain.submit(signed);
  const final = await chain.reconcile(JSON.parse(await readFile(journal, 'utf8')));
  assert.equal(final.status, 'finalized');
  assert.equal(final.payment.nosBaseUnits, expectedPayment);
  assert.equal(final.payment.refundBaseUnits, expectedRefund);
  assert.equal(f.tokenAmount(f.nodeAta), f.nodeInitial + expectedPayment);
  assert.equal(f.tokenAmount(f.payerAta), f.payerInitial + expectedRefund);
  assert.equal(f.tokenAmount(f.vault), 0n);
  assert.equal(f.readJob().state, 2);
  assert.equal(f.readJob().node, f.host);
  const closed = f.svm.getAccount(f.run);
  assert(!closed.exists || closed.lamports === 0n, 'Run did not close');
  assert.notEqual(f.svm.getBalance(f.host), beforeHostSol, 'Local settlement did not charge fee/refund run rent');
  return { signed, final, preview };
}

try {
  await check('paid finish and refund; persisted journal reconciliation', {}, async (f, bridge, chain) => {
    // Independent contract fixture: rate10 *600s =6000, funded10 *3600=36000.
    const { signed, final } = await settle(f, bridge, chain, 6000n, 30000n);
    const restarted = makeChain(bridge);
    const recovered = await restarted.reconcile({ signed });
    assert.equal(recovered.status, 'finalized'); assert.equal(recovered.payment.nosBaseUnits, 6000n);
    const before = f.svm.getBalance(f.host);
    await chain.submit(signed); // identical byte rebroadcast, same signature
    assert.equal(bridge.history.size, 1); assert.equal(f.svm.getBalance(f.host), before);
    await assert.rejects(chain.prepare({ host: f.host, job: f.job, resultCid: cid }));
    return { signature: final.signature, nodePaymentBaseUnits: '6000', refundBaseUnits: '30000', committedTransactions: bridge.history.size };
  });
  await check('zero-price job closes without NOS payment', { price: 0n }, async (f, bridge, chain) => {
    const { final } = await settle(f, bridge, chain, 0n, 0n);
    return { signature: final.signature, nodePaymentBaseUnits: '0', refundBaseUnits: '0' };
  });
  await check('elapsed time is capped at funded timeout', { elapsed: 7200n }, async (f, bridge, chain) => {
    await settle(f, bridge, chain, 36000n, 0n);
    return { nodePaymentBaseUnits: '36000', refundBaseUnits: '0' };
  });
  await check('missing node and payer token accounts are created correctly', { missingNodeAta: true, missingPayerAta: true }, async (f, bridge, chain) => {
    const { preview } = await settle(f, bridge, chain, 6000n, 30000n);
    assert.equal(preview.instructions.length, 3);
    assert.equal(preview.sol.rentLamports, f.svm.minimumBalanceForRentExemption(165n) * 2n);
    return { tokenAccountsCreated: 2, rentLamports: preview.sol.rentLamports };
  });
  await check('wrong key and changed job refuse signing', {}, async (f, bridge, chain) => {
    const preview = await chain.prepare({ host: f.host, job: f.job, resultCid: cid });
    await assert.rejects(chain.signPrepared(preview, f.wrongSigner), /key|host|sign/i);
    f.changeJob({ timeout: 3601n });
    // Model a funded one-second extension, not an underfunded corrupt job.
    const vault = f.svm.getAccount(f.vault); const funded = Buffer.from(vault.data);
    funded.writeBigUInt64LE(36010n, 64); f.set(f.vault, vault.programAddress, funded, vault.lamports);
    await assert.rejects(chain.signPrepared(preview, f.signer), /changed|snapshot|reimbursement/i);
    assert.equal(bridge.history.size, 0); return { committedTransactions: 0 };
  });
  await check('simulation marker cannot be signed; tampered signed wire rejected', {}, async (f, bridge, chain) => {
    const simulationOnly = await chain.prepare({ host: f.host, job: f.job, resultCid: SIMULATION_RESULT_CID });
    await assert.rejects(chain.signPrepared(simulationOnly, f.signer), /simulation|publish|result/i);
    const preview = await chain.prepare({ host: f.host, job: f.job, resultCid: cid });
    const signed = await chain.signPrepared(preview, f.signer);
    const bytes = Buffer.from(signed.wire, 'base64'); bytes[2] ^= 1;
    await assert.rejects(chain.submit({ ...signed, wire: bytes.toString('base64') }), /signature|journal|sign/i);
    assert(f.svm.sendTransaction(getTransactionDecoder().decode(bytes)) instanceof FailedTransactionMetadata,
      'The isolated VM itself accepted an invalid signature');
    assert.equal(bridge.history.size, 0); return { committedTransactions: 0 };
  });
  await check('failed execution preserves pending job and pays no NOS', {}, async (f, bridge, chain) => {
    const preview = await chain.prepare({ host: f.host, job: f.job, resultCid: cid });
    const signed = await chain.signPrepared(preview, f.signer);
    const vault = f.svm.getAccount(f.vault); const data = Buffer.from(vault.data); data.writeBigUInt64LE(0n, 64);
    f.set(f.vault, vault.programAddress, data, vault.lamports);
    await assert.rejects(chain.simulateSigned(signed), /simulation|failed/i);
    assert.equal(f.readJob().state, 0); assert.equal(f.tokenAmount(f.nodeAta), 1000n);
    assert.equal(bridge.history.size, 0); return { committedTransactions: 0, nodePaymentBaseUnits: '0' };
  });
  await check('ambiguous committed submission stays pending then reconciles same signature', {}, async (f, bridge, chain) => {
    const preview = await chain.prepare({ host: f.host, job: f.job, resultCid: cid });
    const signed = await chain.signPrepared(preview, f.signer);
    await chain.submit(signed); bridge.hideStatus(true);
    const pending = await makeChain(bridge).reconcile({ signed });
    assert.equal(pending.status, 'pending'); assert.equal(bridge.history.size, 1);
    bridge.hideStatus(false); const final = await makeChain(bridge).reconcile({ signed });
    assert.equal(final.status, 'finalized'); assert.equal(final.payment.nosBaseUnits, 6000n);
    assert.equal(bridge.history.size, 1); return { recoveredSignature: signed.signature, committedTransactions: 1 };
  });
  await check('state race after preflight yields failed committed transaction with no NOS payment', {}, async (f, bridge, chain) => {
    const preview = await chain.prepare({ host: f.host, job: f.job, resultCid: cid });
    const signed = await chain.signPrepared(preview, f.signer); await chain.simulateSigned(signed);
    bridge.beforeNextCommit(() => {
      const vault = f.svm.getAccount(f.vault); const data = Buffer.from(vault.data); data.writeBigUInt64LE(0n, 64);
      f.set(f.vault, vault.programAddress, data, vault.lamports);
    });
    const beforeSol = f.svm.getBalance(f.host);
    await chain.submit(signed);
    const failure = await chain.reconcile({ signed });
    assert.equal(failure.status, 'failed'); assert(failure.error);
    assert.equal(f.tokenAmount(f.nodeAta), 1000n); assert.equal(f.readJob().state, 0);
    assert.equal(f.svm.getBalance(f.host), beforeSol - 5000n);
    return { committedTransactions: 1, failed: true, nodePaymentBaseUnits: '0', feeLamports: '5000', error: failure.error };
  });
  await check('unsubmitted expired signature is reconciled without a new transaction', {}, async (f, bridge, chain) => {
    const preview = await chain.prepare({ host: f.host, job: f.job, resultCid: cid });
    const signed = await chain.signPrepared(preview, f.signer); bridge.expire();
    const expired = await makeChain(bridge).reconcile({ signed });
    assert.equal(expired.status, 'expired'); assert.equal(bridge.history.size, 0);
    assert.equal(f.readJob().state, 0); return { committedTransactions: 0 };
  });
} catch { process.exitCode = 1; }
finally {
  const report = { startedAt, finishedAt: new Date().toISOString(), framework: 'LiteSVM1.6.2',
    programSha256: PROGRAM_SHA256, network: 'loopback-only synthetic bank',
    realProgramExecution: true, realSignatureVerification: true,
    consensusFinality: 'Not exercised; the loopback bridge labels successfully committed isolated VM transactions finalized.',
    liveSigningOrBroadcast: false, passed: checks.every(check => check.passed) && checks.length === 10, checks };
  const file = resolve(directory, `report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, json(report) + '\n', { mode: 0o600 });
  console.log(`Evidence: ${file}`);
  if (!report.passed) process.exitCode = 1;
}
