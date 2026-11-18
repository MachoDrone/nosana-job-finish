import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
  address, createSolanaRpcFromTransport, createNoopSigner, createTransactionMessage,
  appendTransactionMessageInstructions, setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction, getBase64EncodedWireTransaction, getTransactionDecoder,
  getCompiledTransactionMessageDecoder, getAddressEncoder, getAddressDecoder,
  getBase58Encoder, getBase58Decoder, getProgramDerivedAddress,
  getSignatureFromTransaction, signTransactionMessageWithSigners,
} from '@solana/kit';
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from '@solana/rpc-spec-types';
import { ipfsHashToSolBytesArray, solBytesArrayToIpfsHash } from '@nosana/kit';
import {
  getFinishInstruction, getJobAccountDecoder, getRunAccountDecoder, getMarketAccountDecoder,
} from '@nosana/jobs-program';

export const JOBS_PROGRAM = 'nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM';
export const NOS_MINT = 'nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const FINISH = [67, 74, 170, 132, 125, 233, 182, 37];
const DISCRIMINATORS = {
  job: [91, 16, 162, 5, 45, 210, 125, 65],
  run: [194, 169, 110, 230, 235, 11, 225, 22],
  market: [201, 78, 187, 225, 240, 198, 201, 251],
};
const DECODERS = { job: getJobAccountDecoder(), run: getRunAccountDecoder(), market: getMarketAccountDecoder() };
const U64_MAX = (1n << 64n) - 1n;
export const SIMULATION_RESULT_CID = solBytesArrayToIpfsHash([
  ...createHash('sha256').update('nosana-job-finish: simulation only; no published result').digest(),
]);
const bytes = value => Buffer.from(value);
const sameBytes = (a, b) => bytes(a).equals(bytes(b));
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const asBigInt = value => {
  assert(typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value)), 'Expected an exact nonnegative integer');
  const result = BigInt(value); assert(result >= 0n); return result;
};

// Use the maintained RPC integer parser: JSON.parse would round u64 values.
// A receipt for this tool's bounded Finish transaction is comfortably below 2MiB.
export function createBoundedTransport(url, { timeoutMs = 20_000, fetchFn = globalThis.fetch } = {}) {
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20_000);
  const allowed = new Set(['getGenesisHash', 'getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts',
    'getLatestBlockhash', 'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'simulateTransaction',
    'sendTransaction', 'getSignatureStatuses', 'getBlockHeight', 'isBlockhashValid', 'getTransaction']);
  return async ({ payload, signal }) => {
    assert(payload && !Array.isArray(payload) && allowed.has(payload.method), 'Unexpected RPC request');
    const timeout = AbortSignal.timeout(timeoutMs);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: stringifyJsonWithBigInts(payload), signal: abortSignal, redirect: 'error' });
    assert(response.ok, `RPC ${payload.method} failed with HTTP ${response.status}`);
    const maximum = 2 * 1024 * 1024;
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) assert(Number(contentLength) <= maximum, 'RPC response exceeds size limit');
    assert(response.body, 'RPC response body missing');
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; assert(size <= maximum, 'RPC response exceeds size limit'); chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return parseJsonWithBigInts(Buffer.concat(chunks, size).toString('utf8'));
  };
}

export function decodeProgramAccount(account, kind, program) {
  assert(account && !account.executable && account.owner === program, `Invalid ${kind} account owner or missing account`);
  assert.equal(account.data?.[1], 'base64');
  const data = Buffer.from(account.data[0], 'base64');
  assert.deepEqual([...data.subarray(0, 8)], DISCRIMINATORS[kind], `Invalid ${kind} discriminator`);
  return DECODERS[kind].decode(data);
}

export function decodeTokenAccount(account, mint, owner) {
  assert(account && account.owner === TOKEN_PROGRAM && !account.executable, 'Invalid token account owner');
  assert.equal(account.data?.[1], 'base64');
  const data = Buffer.from(account.data[0], 'base64');
  assert.equal(data.length, 165, 'Only ordinary SPL Token accounts are supported');
  assert.equal(getAddressDecoder().decode(data.subarray(0, 32)), mint, 'Wrong token mint');
  assert.equal(getAddressDecoder().decode(data.subarray(32, 64)), owner, 'Wrong token authority');
  assert.equal(data[108], 1, 'Token account is not initialized or is frozen');
  return data.readBigUInt64LE(64);
}

export function estimatePayment(price, timeout, start, end) {
  for (const value of [price, timeout, start, end]) assert(typeof value === 'bigint' && value >= 0n, 'Negative or inexact accounting value');
  assert(end >= start, 'Chain end precedes run start');
  const maximumNosBaseUnits = price * timeout;
  assert(maximumNosBaseUnits <= U64_MAX, 'Escrow arithmetic exceeds u64');
  const elapsedSeconds = end - start;
  const billedSeconds = elapsedSeconds < timeout ? elapsedSeconds : timeout;
  return { priceBaseUnitsPerSecond: price, timeoutSeconds: timeout, elapsedSeconds, billedSeconds,
    estimatedNosBaseUnits: price * billedSeconds, maximumNosBaseUnits };
}

async function deriveAccounts(host, jobData, programs) {
  const encode = getAddressEncoder().encode;
  const pda = async (seeds, programAddress) => (await getProgramDerivedAddress({ programAddress: address(programAddress), seeds: seeds.map(v => encode(address(v))) }))[0];
  const [vault, nodeAta, payerAta] = await Promise.all([
    pda([jobData.market, programs.nosTokenAddress], programs.jobsAddress),
    pda([host, TOKEN_PROGRAM, programs.nosTokenAddress], ATA_PROGRAM),
    pda([jobData.payer, TOKEN_PROGRAM, programs.nosTokenAddress], ATA_PROGRAM),
  ]);
  return { vault, nodeAta, payerAta };
}

function resultBytes(cid) {
  const result = new Uint8Array(ipfsHashToSolBytesArray(cid));
  assert(result.some(v => v !== 0), 'Result digest cannot be null');
  return result;
}

function expectedFinishAccounts(snapshot) {
  return [snapshot.job, snapshot.run, snapshot.market, snapshot.vault,
    BigInt(snapshot.price) > 0n ? snapshot.payerAta : snapshot.vault,
    snapshot.nodeAta, snapshot.runPayer, snapshot.payer, snapshot.host, TOKEN_PROGRAM];
}

export function validateInstructions(instructions, snapshot, cid) {
  assert(instructions.length >= 1 && instructions.length <= 3, 'Expected Finish and at most two ATA creations');
  const finish = instructions.at(-1);
  assert.equal(finish.programAddress, snapshot.jobsProgram);
  assert.deepEqual([...finish.data], [...FINISH, ...resultBytes(cid)], 'Unexpected Finish payload');
  assert.deepEqual(finish.accounts.map(a => a.address), expectedFinishAccounts(snapshot), 'Finish destination/account mismatch');
  assert.deepEqual(finish.accounts.map(a => a.role), [1, 1, 0, 1, 1, 1, 1, 1, 2, 0], 'Finish permission mismatch');
  assert.equal(instructions.length - 1, snapshot.ataCreations.length, 'Unexpected ATA creation count');
  const seen = new Set();
  for (const [i, ix] of instructions.slice(0, -1).entries()) {
    const expected = snapshot.ataCreations[i];
    assert(!seen.has(expected.address), 'Duplicate ATA instruction'); seen.add(expected.address);
    assert.equal(ix.programAddress, ATA_PROGRAM);
    assert.deepEqual([...ix.data], [1], 'Only idempotent ATA creation is allowed');
    assert.deepEqual(ix.accounts.map(a => a.address), [snapshot.host, expected.address, expected.owner,
      snapshot.nosMint, SYSTEM_PROGRAM, TOKEN_PROGRAM]);
    assert.deepEqual(ix.accounts.map(a => a.role), [3, 1, 0, 0, 0, 0], 'ATA permissions mismatch');
  }
}

function buildInstructions(snapshot, cid, signer = createNoopSigner(address(snapshot.host))) {
  const instructions = snapshot.ataCreations.map(ata => ({
    programAddress: address(ATA_PROGRAM), data: new Uint8Array([1]),
    accounts: [
      { address: address(snapshot.host), role: 3, signer }, { address: address(ata.address), role: 1 },
      { address: address(ata.owner), role: 0 }, { address: address(snapshot.nosMint), role: 0 },
      { address: address(SYSTEM_PROGRAM), role: 0 }, { address: address(TOKEN_PROGRAM), role: 0 },
    ],
  }));
  instructions.push(getFinishInstruction({
    job: address(snapshot.job), run: address(snapshot.run), market: address(snapshot.market),
    vault: address(snapshot.vault), deposit: address(BigInt(snapshot.price) > 0n ? snapshot.payerAta : snapshot.vault),
    user: address(snapshot.nodeAta), payerRun: address(snapshot.runPayer), payerJob: address(snapshot.payer),
    authority: signer, tokenProgram: address(TOKEN_PROGRAM), ipfsResult: resultBytes(cid),
  }, { programAddress: address(snapshot.jobsProgram) }));
  validateInstructions(instructions, snapshot, cid);
  return instructions;
}

function buildMessage(snapshot, instructions, lifetime, signer) {
  let message = createTransactionMessage({ version: 0 });
  message = signer ? setTransactionMessageFeePayerSigner(signer, message)
    : setTransactionMessageFeePayer(address(snapshot.host), message);
  message = setTransactionMessageLifetimeUsingBlockhash(lifetime, message);
  return appendTransactionMessageInstructions(instructions, message);
}

export function summarizePreview(preview) {
  return JSON.parse(json({ host: preview.host, job: preview.job, run: preview.run, resultCid: preview.resultCid,
    snapshot: preview.snapshot, payment: preview.payment, sol: preview.sol, simulation: preview.simulation,
    instructionCount: preview.instructions.length,
    accounting: 'Chain elapsed time capped by funded timeout; it can include downtime. Simulation is not payment receipt.' }));
}

// Reads only the SPL transfers executed by this exact Finish instruction. Account
// metadata is required so a same-looking transfer of another mint cannot pass.
export function parseFinalizedPayment(transaction, snapshot, expectedPayment) {
  assert(transaction?.meta && transaction.meta.err === null, 'Finalized transaction failed or metadata missing');
  const encoded = transaction.transaction;
  assert(Array.isArray(encoded) && encoded[1] === 'base64', 'Expected base64 finalized transaction');
  const tx = getTransactionDecoder().decode(Buffer.from(encoded[0], 'base64'));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert(!compiled.addressTableLookups?.length, 'Lookup tables are not supported');
  const keys = compiled.staticAccounts;
  const finishIndex = compiled.instructions.length - 1;
  const groups = (transaction.meta.innerInstructions ?? []).filter(g => Number(g.index) === finishIndex);
  assert(groups.length <= 1, 'Ambiguous Finish inner instructions');
  const transfers = [];
  for (const ix of groups[0]?.instructions ?? []) {
    assert.equal(keys[Number(ix.programIdIndex)], TOKEN_PROGRAM, 'Unexpected program inside Finish');
    const data = getBase58Encoder().encode(ix.data);
    assert.equal(data.length, 9); assert.equal(data[0], 3, 'Expected ordinary SPL transfer');
    assert.equal(ix.accounts.length, 3);
    transfers.push({ source: keys[Number(ix.accounts[0])], destination: keys[Number(ix.accounts[1])],
      authority: keys[Number(ix.accounts[2])], amount: Buffer.from(data).readBigUInt64LE(1) });
  }
  if (BigInt(snapshot.price) === 0n) {
    assert.equal(transfers.length, 0, 'Zero-price Finish unexpectedly transferred tokens');
    return { nosBaseUnits: 0n, refundBaseUnits: 0n, decimals: 6 };
  }
  const total = BigInt(snapshot.price) * BigInt(snapshot.timeout);
  assert.equal(transfers.length, 2, 'Expected reimbursement and refund transfers');
  const actualPayment = transfers[0].amount;
  assert(actualPayment <= total && transfers[1].amount === total - actualPayment, 'Finalized payment exceeds or does not sum to the funded deposit');
  if (expectedPayment !== undefined) assert.equal(actualPayment, expectedPayment, 'Finalized amount differs from job settlement time');
  assert.deepEqual(transfers, [
    { source: snapshot.vault, destination: snapshot.nodeAta, authority: snapshot.vault, amount: actualPayment },
    { source: snapshot.vault, destination: snapshot.payerAta, authority: snapshot.vault, amount: total - actualPayment },
  ], 'Finalized transfers do not match this job settlement');
  for (const [account, owner] of [[snapshot.nodeAta, snapshot.host], [snapshot.payerAta, snapshot.payer], [snapshot.vault, snapshot.vault]]) {
    const index = keys.indexOf(account);
    const token = transaction.meta.postTokenBalances?.find(t => Number(t.accountIndex) === index);
    assert(token && token.mint === snapshot.nosMint && token.owner === owner, 'Missing or incorrect finalized token metadata');
    assert.equal(Number(token.uiTokenAmount.decimals), 6);
  }
  return { nosBaseUnits: transfers[0].amount, refundBaseUnits: transfers[1].amount, decimals: 6 };
}

export function createChain({ rpcUrl = 'https://api.mainnet-beta.solana.com', network = 'mainnet',
  programs, expectedGenesisHash, rpc: injectedRpc, pollMs = 1000, requestTimeoutMs = 20_000 } = {}) {
  assert(Number.isInteger(pollMs) && pollMs > 0 && pollMs <= 20_000, 'Invalid reconciliation polling interval');
  const url = new URL(rpcUrl);
  if (network === 'mainnet') {
    assert.equal(url.protocol, 'https:', 'Mainnet RPC must use HTTPS');
    assert(!programs, 'Mainnet program overrides are prohibited');
    assert(!expectedGenesisHash || expectedGenesisHash === MAINNET_GENESIS);
    programs = { jobsAddress: JOBS_PROGRAM, nosTokenAddress: NOS_MINT };
    expectedGenesisHash = MAINNET_GENESIS;
  } else {
    assert.equal(network, 'localnet', 'Unsupported network');
    assert(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'Localnet requires loopback RPC');
    assert(['http:', 'https:'].includes(url.protocol));
    assert(programs?.jobsAddress && programs?.nosTokenAddress && expectedGenesisHash, 'Localnet fixture configuration required');
  }
  programs = { jobsAddress: address(programs.jobsAddress), nosTokenAddress: address(programs.nosTokenAddress) };
  const rpc = injectedRpc ?? createSolanaRpcFromTransport(createBoundedTransport(rpcUrl, { timeoutMs: requestTimeoutMs }));
  const confirmed = { commitment: 'confirmed' };
  const finalized = { commitment: 'finalized' };
  const signedSimulations = new Set();
  const checkNetwork = async () => assert.equal(await rpc.getGenesisHash().send(), expectedGenesisHash, 'RPC genesis does not match the selected network');
  const rpcAccount = async (key, config = confirmed) => (await rpc.getAccountInfo(address(key), { encoding: 'base64', ...config }).send()).value;

  async function findRuns(key, offset) {
    await checkNetwork();
    const response = await rpc.getProgramAccounts(programs.jobsAddress, { encoding: 'base64', ...confirmed,
      withContext: true, filters: [
        { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(new Uint8Array(DISCRIMINATORS.run)), encoding: 'base58' } },
        { memcmp: { offset: BigInt(offset), bytes: address(key), encoding: 'base58' } },
      ] }).send();
    return response.value.map(row => ({ address: row.pubkey, ...decodeProgramAccount(row.account, 'run', programs.jobsAddress) }));
  }

  async function readSnapshot(host, jobAddress) {
    await checkNetwork();
    host = address(host); jobAddress = address(jobAddress);
    const [firstAccount, runs] = await Promise.all([rpcAccount(jobAddress), findRuns(jobAddress, 8)]);
    const first = decodeProgramAccount(firstAccount, 'job', programs.jobsAddress);
    assert.equal(runs.length, 1, 'Exactly one open run is required; this job may already be settled');
    const runAddress = runs[0].address;
    const derived = await deriveAccounts(host, first, programs);
    const keys = [jobAddress, runAddress, first.market, derived.vault, derived.nodeAta, derived.payerAta, host, programs.nosTokenAddress];
    const response = await rpc.getMultipleAccounts(keys, { encoding: 'base64', ...confirmed }).send();
    const [jobAccount, runAccount, marketAccount, vaultAccount, nodeAccount, payerAccount, hostAccount, mintAccount] = response.value;
    const job = decodeProgramAccount(jobAccount, 'job', programs.jobsAddress);
    const run = decodeProgramAccount(runAccount, 'run', programs.jobsAddress);
    const market = decodeProgramAccount(marketAccount, 'market', programs.jobsAddress);
    assert.equal(job.market, first.market); assert.equal(job.payer, first.payer, 'Job changed during inspection');
    assert.equal(job.state, 0, 'Job is not in the raw state required by Finish');
    assert(job.ipfsResult.every(v => v === 0), 'Job already has results');
    assert.equal(run.job, jobAddress); assert.equal(run.node, host, 'Run belongs to a different host');
    assert(run.time >= 0n && job.timeout > 0n && job.price >= 0n);
    assert(job.price * job.timeout <= U64_MAX, 'Escrow arithmetic exceeds u64');
    assert.equal(market.vault, derived.vault, 'Market vault mismatch');
    assert(mintAccount && mintAccount.owner === TOKEN_PROGRAM && !mintAccount.executable, 'NOS mint account is invalid');
    const mintBytes = Buffer.from(mintAccount.data[0], 'base64');
    assert.equal(mintAccount.data[1], 'base64'); assert.equal(mintBytes.length, 82); assert.equal(mintBytes[44], 6); assert.equal(mintBytes[45], 1);
    const vaultBalance = decodeTokenAccount(vaultAccount, programs.nosTokenAddress, derived.vault);
    assert(vaultBalance >= job.price * job.timeout, 'Market vault lacks the funded escrow');
    const ataCreations = [];
    if (nodeAccount) decodeTokenAccount(nodeAccount, programs.nosTokenAddress, host);
    else ataCreations.push({ address: derived.nodeAta, owner: host });
    if (job.price > 0n && derived.payerAta !== derived.nodeAta) {
      if (payerAccount) decodeTokenAccount(payerAccount, programs.nosTokenAddress, job.payer);
      else ataCreations.push({ address: derived.payerAta, owner: job.payer });
    }
    assert(hostAccount && hostAccount.owner === SYSTEM_PROGRAM && !hostAccount.executable, 'Fee payer must be an existing System account');
    const snapshot = { version: 1, genesisHash: expectedGenesisHash, host, job: jobAddress, run: runAddress,
      jobsProgram: programs.jobsAddress, nosMint: programs.nosTokenAddress, market: job.market,
      payer: job.payer, runPayer: run.payer, project: job.project, price: job.price.toString(),
      timeout: job.timeout.toString(), runStart: run.time.toString(), ...derived, ataCreations,
      rawJob: jobAccount.data[0], rawRun: runAccount.data[0] };
    return { snapshot, slot: response.context.slot, hostBalance: BigInt(hostAccount.lamports) };
  }

  async function validateSnapshot(snapshot) {
    assert.equal(snapshot.version, 1); assert.equal(snapshot.genesisHash, expectedGenesisHash);
    assert.equal(snapshot.jobsProgram, programs.jobsAddress); assert.equal(snapshot.nosMint, programs.nosTokenAddress);
    for (const key of ['host', 'job', 'run', 'market', 'payer', 'runPayer', 'project', 'vault', 'nodeAta', 'payerAta']) address(snapshot[key]);
    const job = decodeProgramAccount({ owner: programs.jobsAddress, executable: false, data: [snapshot.rawJob, 'base64'] }, 'job', programs.jobsAddress);
    const run = decodeProgramAccount({ owner: programs.jobsAddress, executable: false, data: [snapshot.rawRun, 'base64'] }, 'run', programs.jobsAddress);
    assert.equal(job.state, 0); assert(job.ipfsResult.every(v => v === 0));
    assert.equal(run.job, snapshot.job); assert.equal(run.node, snapshot.host);
    for (const [actual, saved] of [[job.market, snapshot.market], [job.payer, snapshot.payer], [run.payer, snapshot.runPayer],
      [job.project, snapshot.project], [job.price.toString(), snapshot.price], [job.timeout.toString(), snapshot.timeout], [run.time.toString(), snapshot.runStart]]) assert.equal(actual, saved);
    assert.deepEqual(await deriveAccounts(snapshot.host, job, programs), { vault: snapshot.vault, nodeAta: snapshot.nodeAta, payerAta: snapshot.payerAta });
    assert(Array.isArray(snapshot.ataCreations) && snapshot.ataCreations.length <= 2);
    const allowed = [{ address: snapshot.nodeAta, owner: snapshot.host },
      ...(job.price > 0n && snapshot.nodeAta !== snapshot.payerAta ? [{ address: snapshot.payerAta, owner: snapshot.payer }] : [])];
    let last = -1;
    for (const ata of snapshot.ataCreations) { const index = allowed.findIndex(a => a.address === ata.address && a.owner === ata.owner); assert(index > last, 'Invalid ATA destination/order'); last = index; }
  }

  async function simulate(message, snapshot, cid, signedTransaction) {
    const transaction = signedTransaction ?? compileTransaction(message);
    if (!signedTransaction) assert(Object.values(transaction.signatures).every(v => v === null));
    const result = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: 'base64', sigVerify: !!signedTransaction, replaceRecentBlockhash: !signedTransaction,
      ...confirmed, innerInstructions: true,
      accounts: { addresses: [snapshot.job, snapshot.run, snapshot.nodeAta, snapshot.payerAta, snapshot.vault], encoding: 'base64' },
    }).send();
    const simulation = { slot: result.context.slot, error: result.value.err, unitsConsumed: result.value.unitsConsumed, logs: result.value.logs };
    if (result.value.err !== null) { const error = new Error(`Finish simulation failed: ${json(result.value.err)}`); error.simulation = simulation; throw error; }
    assert(result.value.accounts?.length === 5, 'Simulation did not return settlement accounts');
    const done = decodeProgramAccount(result.value.accounts[0], 'job', programs.jobsAddress);
    assert.equal(done.state, 2); assert.equal(done.node, snapshot.host); assert(sameBytes(done.ipfsResult, resultBytes(cid)));
    assert.equal(done.timeStart, BigInt(snapshot.runStart));
    assert.equal(done.price, BigInt(snapshot.price)); assert.equal(done.timeout, BigInt(snapshot.timeout));
    assert(result.value.accounts[1] === null || BigInt(result.value.accounts[1].lamports) === 0n, 'Simulation did not close the run');
    decodeTokenAccount(result.value.accounts[2], snapshot.nosMint, snapshot.host);
    if (done.price > 0n) decodeTokenAccount(result.value.accounts[3], snapshot.nosMint, snapshot.payer);
    decodeTokenAccount(result.value.accounts[4], snapshot.nosMint, snapshot.vault);
    return { simulation, payment: estimatePayment(done.price, done.timeout, done.timeStart, done.timeEnd) };
  }

  async function prepare({ host, job, resultCid = SIMULATION_RESULT_CID }) {
    resultBytes(resultCid);
    const { snapshot, hostBalance } = await readSnapshot(host, job);
    const instructions = buildInstructions(snapshot, resultCid);
    const { value: lifetime } = await rpc.getLatestBlockhash(confirmed).send();
    const message = buildMessage(snapshot, instructions, lifetime);
    const transaction = compileTransaction(message);
    const [feeResult, rent, simulationResult] = await Promise.all([
      rpc.getFeeForMessage(Buffer.from(transaction.messageBytes).toString('base64'), confirmed).send(),
      snapshot.ataCreations.length ? rpc.getMinimumBalanceForRentExemption(165n, confirmed).send() : 0n,
      simulate(message, snapshot, resultCid),
    ]);
    assert(feeResult.value !== null, 'Fee unavailable; prepare again');
    const feeLamports = BigInt(feeResult.value), rentLamports = BigInt(rent) * BigInt(snapshot.ataCreations.length);
    assert(hostBalance >= feeLamports + rentLamports, 'Host has insufficient SOL for transaction fee and ATA rent');
    return { host: snapshot.host, job: snapshot.job, run: snapshot.run, resultCid, snapshot, instructions, message,
      ...simulationResult, sol: { feeLamports, rentLamports, totalDebitLamports: feeLamports + rentLamports, balanceLamports: hostBalance } };
  }

  async function assertUnchanged(preview) {
    await validateSnapshot(preview.snapshot);
    const current = await readSnapshot(preview.snapshot.host, preview.snapshot.job);
    assert.equal(json(current.snapshot), json(preview.snapshot), 'Job, run, destinations, or ATA requirements changed; review again');
    return current;
  }

  async function validateSigned(signed) {
    assert(signed && typeof signed.wire === 'string' && signed.wire.length < 5000, 'Invalid signed envelope');
    assert.notEqual(signed.resultCid, SIMULATION_RESULT_CID, 'Simulation marker cannot be signed or submitted');
    await validateSnapshot(signed.snapshot);
    for (const field of ['job', 'host', 'run']) assert.equal(signed[field], signed.snapshot[field]);
    const tx = getTransactionDecoder().decode(Buffer.from(signed.wire, 'base64'));
    assert.equal(getBase64EncodedWireTransaction(tx), signed.wire, 'Noncanonical transaction wire');
    assert.deepEqual(Object.keys(tx.signatures), [signed.host], 'Unexpected transaction signer');
    assert.equal(tx.signatures[signed.host]?.length, 64, 'Transaction is not signed');
    assert.equal(getSignatureFromTransaction(tx), signed.signature, 'Journal signature mismatch');
    const lifetime = { blockhash: signed.blockhash, lastValidBlockHeight: asBigInt(signed.lastValidBlockHeight) };
    const instructions = buildInstructions(signed.snapshot, signed.resultCid);
    const message = buildMessage(signed.snapshot, instructions, lifetime);
    assert(sameBytes(compileTransaction(message).messageBytes, tx.messageBytes), 'Signed bytes differ from reviewed Finish');
    const publicKey = await webcrypto.subtle.importKey('raw', getAddressEncoder().encode(address(signed.host)), { name: 'Ed25519' }, false, ['verify']);
    assert(await webcrypto.subtle.verify('Ed25519', publicKey, tx.signatures[signed.host], tx.messageBytes), 'Invalid host signature');
    return { tx, message };
  }

  async function signPrepared(preview, signer) {
    assert.equal(signer.address, preview.host, 'Signing key does not match selected host');
    assert.notEqual(preview.resultCid, SIMULATION_RESULT_CID, 'Publish and verify the real result before signing');
    await assertUnchanged(preview);
    const fresh = await prepare({ host: preview.host, job: preview.job, resultCid: preview.resultCid });
    assert.equal(json(fresh.snapshot), json(preview.snapshot), 'Job changed before signing');
    assert(fresh.sol.totalDebitLamports <= preview.sol.totalDebitLamports, 'SOL budget increased; review again');
    const instructions = buildInstructions(fresh.snapshot, fresh.resultCid, signer);
    const message = buildMessage(fresh.snapshot, instructions, fresh.message.lifetimeConstraint, signer);
    const tx = await signTransactionMessageWithSigners(message);
    const signed = { signature: getSignatureFromTransaction(tx), wire: getBase64EncodedWireTransaction(tx),
      blockhash: message.lifetimeConstraint.blockhash, lastValidBlockHeight: message.lifetimeConstraint.lastValidBlockHeight.toString(),
      job: fresh.job, host: fresh.host, run: fresh.run, resultCid: fresh.resultCid, snapshot: fresh.snapshot };
    await validateSigned(signed); // Local verification only: caller journals before any signed RPC call.
    return signed;
  }

  async function simulateSigned(signed) {
    await checkNetwork();
    const { tx, message } = await validateSigned(signed);
    const result = await simulate(message, signed.snapshot, signed.resultCid, tx);
    signedSimulations.add(signed.wire);
    return result;
  }

  async function submit(signed) {
    await checkNetwork(); await validateSigned(signed);
    if (!signedSimulations.has(signed.wire)) await simulateSigned(signed);
    const signature = await rpc.sendTransaction(signed.wire, {
      encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n,
    }).send();
    assert.equal(signature, signed.signature, 'RPC returned a different signature');
    return { signature };
  }

  async function reconcile(journal, { waitMs = 0 } = {}) {
    assert(Number.isFinite(waitMs) && waitMs >= 0, 'Invalid reconciliation wait duration');
    const signed = journal.signed ?? journal;
    await checkNetwork(); const { tx: expectedTx } = await validateSigned(signed);
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 120_000));
    do {
      const statusResponse = await rpc.getSignatureStatuses([signed.signature], { searchTransactionHistory: true }).send();
      const status = statusResponse.value[0];
      if (status?.confirmationStatus === 'finalized') {
        if (status.err !== null) return { status: 'failed', signature: signed.signature, error: status.err, slot: status.slot };
        const transaction = await rpc.getTransaction(signed.signature, { encoding: 'base64', ...finalized, maxSupportedTransactionVersion: 0 }).send();
        if (transaction) {
          const actualTx = getTransactionDecoder().decode(Buffer.from(transaction.transaction[0], 'base64'));
          assert(sameBytes(actualTx.messageBytes, expectedTx.messageBytes), 'Finalized transaction differs from journal');
          assert.equal(getSignatureFromTransaction(actualTx), signed.signature);
          const accounts = await rpc.getMultipleAccounts([signed.job, signed.run], { encoding: 'base64', ...finalized, minContextSlot: transaction.slot }).send();
          // A client may close the job after settlement. The finalized matching
          // Finish and its transfers still prove this transaction's payment.
          const jobAccountPresent = accounts.value[0] !== null && BigInt(accounts.value[0].lamports) !== 0n;
          let expected;
          if (jobAccountPresent) {
            const done = decodeProgramAccount(accounts.value[0], 'job', programs.jobsAddress);
            assert.equal(done.state, 2); assert.equal(done.node, signed.host);
            assert(sameBytes(done.ipfsResult, resultBytes(signed.resultCid)), 'Finalized result CID mismatch');
            assert.equal(done.timeStart, BigInt(signed.snapshot.runStart));
            assert.equal(done.price, BigInt(signed.snapshot.price)); assert.equal(done.timeout, BigInt(signed.snapshot.timeout));
            expected = estimatePayment(done.price, done.timeout, done.timeStart, done.timeEnd).estimatedNosBaseUnits;
          }
          assert(accounts.value[1] === null || BigInt(accounts.value[1].lamports) === 0n, 'Run remains open after finalized Finish');
          const payment = parseFinalizedPayment(transaction, signed.snapshot, expected);
          return { status: 'finalized', signature: signed.signature, slot: transaction.slot, job: signed.job,
            host: signed.host, run: signed.run, runClosed: true, jobAccountPresent, resultCid: signed.resultCid, payment, feeLamports: transaction.meta.fee };
        }
      } else if (!status) {
        const height = await rpc.getBlockHeight(finalized).send();
        if (BigInt(height) > asBigInt(signed.lastValidBlockHeight)) {
          const valid = await rpc.isBlockhashValid(signed.blockhash, finalized).send();
          if (!valid.value) {
            // Recheck history after expiry: a null status alone never proves failure.
            const again = await rpc.getSignatureStatuses([signed.signature], { searchTransactionHistory: true }).send();
            if (!again.value[0]) return { status: 'expired', signature: signed.signature, blockHeight: height,
              note: 'This signature was not found and its blockhash is no longer valid. Reinspect the job before any new signing.' };
          }
        }
      }
      if (Date.now() >= deadline) return { status: 'pending', signature: signed.signature,
        confirmationStatus: status?.confirmationStatus ?? null, note: 'Outcome is not finalized; retain and reconcile this same signature.' };
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    } while (true);
  }

  return { listRuns: host => findRuns(address(host), 40), prepare, assertUnchanged, signPrepared,
    validateSigned, simulateSigned, submit, reconcile };
}
