import test from 'node:test';
import assert from 'node:assert/strict';
import {
  address, getAddressEncoder, getAddressDecoder, getProgramDerivedAddress,
  createKeyPairSignerFromPrivateKeyBytes, createTransactionMessage,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions, signTransactionMessageWithSigners,
  getSignatureFromTransaction, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder,
  getBase58Decoder,
} from '@solana/kit';
import { solBytesArrayToIpfsHash } from '@nosana/kit';
import {
  createChain, createBoundedTransport, decodeProgramAccount, decodeTokenAccount, estimatePayment,
  validateInstructions, parseFinalizedPayment, SIMULATION_RESULT_CID,
} from '../src/chain.mjs';

// Independent contract fixture: nosana-programs 79b6971 Finish/state.rs and
// published Jobs IDL. These literals intentionally do not import production
// discriminators, layouts, account-role arrays, or expected payment arithmetic.
const PROGRAM = 'nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM';
const MINT = 'nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const GENESIS = 'independent-isolated-chain-fixture';
const enc = getAddressEncoder();
const key = n => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const blockhash = key(30);
const cid = solBytesArrayToIpfsHash(Array(32).fill(7));
const packed = (owner, data) => ({ owner, executable: false, lamports: 2_000_000n, data: [data.toString('base64'), 'base64'] });

async function fixture({ price = 10n, timeout = 3600n, ataCreation = false } = {}) {
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(5));
  const host = signer.address, job = key(10), run = key(11), market = key(12), payer = key(13), project = key(14);
  const pda = async (seeds, programAddress) => (await getProgramDerivedAddress({ programAddress: address(programAddress), seeds: seeds.map(k => enc.encode(address(k))) }))[0];
  const vault = await pda([market, MINT], PROGRAM);
  const nodeAta = await pda([host, TOKEN, MINT], ATA);
  const payerAta = await pda([payer, TOKEN, MINT], ATA);
  const jobData = Buffer.alloc(233);
  jobData.set([91, 16, 162, 5, 45, 210, 125, 65]);
  jobData.set(new Uint8Array(32).fill(4), 8);
  for (const [offset, pubkey] of [[72, market], [104, SYSTEM], [136, payer], [176, project]]) jobData.set(enc.encode(address(pubkey)), offset);
  jobData.writeBigUInt64LE(price, 168); jobData[208] = 0; jobData.writeBigInt64LE(timeout, 225);
  const runData = Buffer.alloc(113);
  runData.set([194, 169, 110, 230, 235, 11, 225, 22]);
  for (const [offset, pubkey] of [[8, job], [40, host], [72, host]]) runData.set(enc.encode(address(pubkey)), offset);
  runData.writeBigInt64LE(1_800_000_000n, 105);
  const snapshot = { version: 1, genesisHash: GENESIS, host, job, run, jobsProgram: PROGRAM, nosMint: MINT,
    market, payer, runPayer: host, project, price: price.toString(), timeout: timeout.toString(),
    runStart: '1800000000', vault, nodeAta, payerAta,
    ataCreations: ataCreation ? [{ address: nodeAta, owner: host }] : [],
    rawJob: jobData.toString('base64'), rawRun: runData.toString('base64') };
  const finish = {
    programAddress: address(PROGRAM), data: new Uint8Array([67, 74, 170, 132, 125, 233, 182, 37, ...Array(32).fill(7)]),
    accounts: [job, run, market, vault, price > 0n ? payerAta : vault, nodeAta, host, payer, host, TOKEN]
      .map((k, i) => ({ address: address(k), role: [1, 1, 0, 1, 1, 1, 1, 1, 2, 0][i], ...(i === 8 ? { signer } : {}) })),
  };
  const createAta = { programAddress: address(ATA), data: new Uint8Array([1]),
    accounts: [host, nodeAta, host, MINT, SYSTEM, TOKEN].map((k, i) => ({ address: address(k), role: [3, 1, 0, 0, 0, 0][i], ...(i === 0 ? { signer } : {}) })) };
  const instructions = ataCreation ? [createAta, finish] : [finish];
  let message = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayerSigner(signer, message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 500n }, message);
  message = appendTransactionMessageInstructions(instructions, message);
  const tx = await signTransactionMessageWithSigners(message);
  const signed = { signature: getSignatureFromTransaction(tx), wire: getBase64EncodedWireTransaction(tx),
    blockhash, lastValidBlockHeight: '500', host, job, run, resultCid: cid, snapshot };
  return { signer, snapshot, finish, createAta, instructions, tx, signed, jobData, runData };
}

function chainWith(rpc) {
  return createChain({ network: 'localnet', rpcUrl: 'http://127.0.0.1:8899', programs: { jobsAddress: PROGRAM, nosTokenAddress: MINT }, expectedGenesisHash: GENESIS, rpc });
}

test('independent packed job/run retain u64 values beyond Number precision', async () => {
  const f = await fixture({ price: 9_007_199_254_740_993n, timeout: 1n });
  const job = decodeProgramAccount(packed(PROGRAM, f.jobData), 'job', PROGRAM);
  const run = decodeProgramAccount(packed(PROGRAM, f.runData), 'run', PROGRAM);
  assert.equal(job.price, 9_007_199_254_740_993n);
  assert.equal(job.timeout, 1n); assert.equal(run.time, 1_800_000_000n);
  assert.equal(run.node, f.snapshot.host);
  const corrupt = Buffer.from(f.jobData); corrupt[0] = 0;
  assert.throws(() => decodeProgramAccount(packed(PROGRAM, corrupt), 'job', PROGRAM), /discriminator/);
  assert.throws(() => decodeProgramAccount(packed(TOKEN, f.jobData), 'job', PROGRAM), /owner/);
});

test('payment uses integer chain seconds, funded cap, and overflow rejection', () => {
  assert.equal(estimatePayment(10n, 3600n, 100n, 700n).estimatedNosBaseUnits, 6000n);
  assert.equal(estimatePayment(10n, 3600n, 100n, 5000n).estimatedNosBaseUnits, 36000n);
  assert.equal(estimatePayment(0n, 3600n, 100n, 5000n).estimatedNosBaseUnits, 0n);
  assert.equal(estimatePayment(9_007_199_254_740_993n, 1n, 100n, 101n).estimatedNosBaseUnits, 9_007_199_254_740_993n);
  assert.throws(() => estimatePayment(2n ** 63n, 3n, 1n, 2n), /u64/);
  assert.throws(() => estimatePayment(10n, 20n, 10n, 9n));
  assert.throws(() => estimatePayment(10, 20n, 1n, 2n));
});

test('token amount decoding checks mint, authority, initialized state and exact layout', async () => {
  const f = await fixture();
  const token = Buffer.alloc(165); token.set(enc.encode(address(MINT))); token.set(enc.encode(f.signer.address), 32);
  token.writeBigUInt64LE(9_007_199_254_740_993n, 64); token[108] = 1;
  assert.equal(decodeTokenAccount(packed(TOKEN, token), MINT, f.signer.address), 9_007_199_254_740_993n);
  assert.throws(() => decodeTokenAccount(packed(TOKEN, token), MINT, f.snapshot.payer), /authority/);
  assert.throws(() => decodeTokenAccount(packed(TOKEN, token), key(22), f.signer.address), /mint/);
  token[108] = 2;
  assert.throws(() => decodeTokenAccount(packed(TOKEN, token), MINT, f.signer.address), /frozen/);
});

test('Finish and ATA fixtures enforce exact instruction identity, recipients and roles', async () => {
  const f = await fixture({ ataCreation: true });
  validateInstructions(f.instructions, f.snapshot, cid);
  for (const mutate of [
    ix => { ix[1].accounts[5].address = address(key(26)); },
    ix => { ix[1].accounts[8].role = 3; },
    ix => { ix[1].data[0] = 0; },
    ix => { ix[0].accounts[0].address = address(key(26)); },
    ix => { ix[0].accounts[2].address = address(key(26)); },
    ix => { ix[0].accounts[5].role = 1; },
    ix => { ix[0].data[0] = 0; },
  ]) {
    const ix = f.instructions.map(x => ({ ...x, data: Uint8Array.from(x.data), accounts: x.accounts.map(a => ({ ...a })) }));
    mutate(ix); assert.throws(() => validateInstructions(ix, f.snapshot, cid));
  }
  assert.throws(() => validateInstructions([...f.instructions, f.finish], f.snapshot, cid));
});

test('untrusted journal must match canonical signed wire and independently derived destinations', async () => {
  const f = await fixture(); const chain = chainWith({});
  await chain.validateSigned(f.signed);
  await assert.rejects(chain.validateSigned({ ...f.signed, signature: f.signed.signature.slice(1) }), /signature/);
  await assert.rejects(chain.validateSigned({ ...f.signed, host: f.snapshot.payer }));
  await assert.rejects(chain.validateSigned({ ...f.signed, resultCid: SIMULATION_RESULT_CID }), /marker/);
  await assert.rejects(chain.validateSigned({ ...f.signed, snapshot: { ...f.snapshot, nodeAta: f.snapshot.payerAta } }));
  await assert.rejects(chain.validateSigned({ ...f.signed, snapshot: { ...f.snapshot, price: '11' } }));
  const badWire = Buffer.from(f.signed.wire, 'base64'); badWire[5] ^= 1;
  await assert.rejects(chain.validateSigned({ ...f.signed, wire: badWire.toString('base64') }));
});

function finalizedFixture(f, { wrongMint = false, extraTransfer = false } = {}) {
  const compiled = getCompiledTransactionMessageDecoder().decode(f.tx.messageBytes);
  const index = k => compiled.staticAccounts.indexOf(k);
  const transfer = (destination, amount) => {
    const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(amount, 1);
    return { programIdIndex: index(TOKEN), accounts: [index(f.snapshot.vault), index(destination), index(f.snapshot.vault)], data: getBase58Decoder().decode(data) };
  };
  const instructions = [transfer(f.snapshot.nodeAta, 6000n), transfer(f.snapshot.payerAta, 30000n)];
  if (extraTransfer) instructions.push(transfer(f.snapshot.nodeAta, 1n));
  return { transaction: [f.signed.wire, 'base64'], meta: { err: null,
    innerInstructions: [{ index: compiled.instructions.length - 1, instructions }],
    postTokenBalances: [[f.snapshot.nodeAta, f.snapshot.host], [f.snapshot.payerAta, f.snapshot.payer], [f.snapshot.vault, f.snapshot.vault]]
      .map(([account, owner]) => ({ accountIndex: index(account), owner, mint: wrongMint ? key(25) : MINT, uiTokenAmount: { decimals: 6 } })),
  } };
}

test('settlement proof checks job-linked exact transfers and mint metadata, not balance samples', async () => {
  const f = await fixture();
  assert.deepEqual(parseFinalizedPayment(finalizedFixture(f), f.snapshot, 6000n), { nosBaseUnits: 6000n, refundBaseUnits: 30000n, decimals: 6 });
  assert.throws(() => parseFinalizedPayment(finalizedFixture(f), f.snapshot, 6001n), /settlement/);
  assert.throws(() => parseFinalizedPayment(finalizedFixture(f, { wrongMint: true }), f.snapshot, 6000n), /metadata/);
  assert.throws(() => parseFinalizedPayment(finalizedFixture(f, { extraTransfer: true }), f.snapshot, 6000n), /reimbursement and refund/);
  assert.deepEqual(parseFinalizedPayment(finalizedFixture(f), f.snapshot), { nosBaseUnits: 6000n, refundBaseUnits: 30000n, decimals: 6 });
});

test('a subsequently closed job does not erase finalized transaction payment proof', async () => {
  const f = await fixture();
  const transaction = finalizedFixture(f); transaction.slot = 88n; transaction.meta.fee = 5000n;
  const rpc = { getGenesisHash: () => ({ send: async () => GENESIS }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'finalized', err: null, slot: 88n }] }) }),
    getTransaction: () => ({ send: async () => transaction }),
    getMultipleAccounts: () => ({ send: async () => ({ context: { slot: 90n }, value: [null, null] }) }),
  };
  const result = await chainWith(rpc).reconcile(f.signed);
  assert.equal(result.status, 'finalized'); assert.equal(result.jobAccountPresent, false);
  assert.equal(result.payment.nosBaseUnits, 6000n); assert.equal(result.payment.refundBaseUnits, 30000n);
  assert.equal(result.runClosed, true);
});

test('RPC transport preserves u64 integers, rejects excessive responses and forbids redirects', async () => {
  let options;
  const payload = { jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [] };
  const transport = createBoundedTransport('https://rpc.invalid', { fetchFn: async (_url, init) => {
    options = init; return new Response('{"jsonrpc":"2.0","id":1,"result":9007199254740993}');
  } });
  assert.equal((await transport({ payload })).result, 9_007_199_254_740_993n);
  assert.equal(options.redirect, 'error'); assert(options.signal instanceof AbortSignal);
  const excessive = createBoundedTransport('https://rpc.invalid', { fetchFn: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(excessive({ payload }), /size limit/);
  await assert.rejects(transport({ payload: { ...payload, method: 'requestAirdrop' } }), /Unexpected RPC/);
});

test('RPC requests abort when their per-request deadline expires', async () => {
  const transport = createBoundedTransport('https://rpc.invalid', { timeoutMs: 5,
    fetchFn: async (_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('{}')), 1000);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    }),
  });
  await assert.rejects(transport({ payload: { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] } }), /timeout/i);
});

test('pending signatures never trigger a send; expiry also requires actual blockhash invalidity', async () => {
  const f = await fixture(); const calls = [];
  const answer = (name, value) => (...args) => ({ send: async () => { calls.push({ name, args }); return value; } });
  const rpc = {
    getGenesisHash: answer('genesis', GENESIS),
    getSignatureStatuses: answer('status', { value: [null] }),
    getBlockHeight: answer('height', 600n),
    isBlockhashValid: answer('valid', { value: true }),
  };
  const chain = chainWith(rpc);
  await assert.rejects(chain.reconcile(f.signed, { waitMs: NaN }), /wait duration/);
  assert.equal(calls.length, 0);
  assert.equal((await chain.reconcile(f.signed)).status, 'pending');
  rpc.isBlockhashValid = answer('valid', { value: false });
  assert.equal((await chain.reconcile({ signed: f.signed })).status, 'expired');
  assert(calls.every(c => ['genesis', 'status', 'height', 'valid'].includes(c.name)));
  assert(calls.filter(c => c.name === 'status').every(c => c.args[1].searchTransactionHistory === true));
});

test('finalized failure is preserved and does not become a fresh transaction attempt', async () => {
  const f = await fixture();
  const error = { InstructionError: [0, { Custom: 6001 }] };
  const rpc = { getGenesisHash: () => ({ send: async () => GENESIS }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'finalized', err: error, slot: 99n }] }) }) };
  assert.deepEqual(await chainWith(rpc).reconcile(f.signed), { status: 'failed', signature: f.signed.signature, error, slot: 99n });
});

test('production network cannot be redirected to another genesis or program configuration', () => {
  assert.throws(() => createChain({ rpcUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => createChain({ programs: { jobsAddress: PROGRAM, nosTokenAddress: MINT } }), /overrides/);
  assert.throws(() => createChain({ network: 'localnet', rpcUrl: 'http://example.com', programs: { jobsAddress: PROGRAM, nosTokenAddress: MINT }, expectedGenesisHash: GENESIS }), /loopback/);
});
