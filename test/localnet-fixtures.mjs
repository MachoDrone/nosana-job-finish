// Isolated fixtures: no user wallet, host, or live transaction is ever used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { LiteSVM, Clock, FailedTransactionMetadata } from 'litesvm';
import { VersionedTransaction } from '@solana/web3.js';
import {
  address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder,
  getAddressDecoder, getBase58Decoder, getBase58Encoder,
  getProgramDerivedAddress, getTransactionDecoder,
} from '@solana/kit';
import { getJobAccountEncoder, getJobAccountDecoder, getRunAccountEncoder,
  getMarketAccountEncoder } from '@nosana/jobs-program';

export const JOBS = address('nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM');
export const NOS = address('nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7');
export const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM = address('11111111111111111111111111111111');
export const ATA = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const GENESIS = 'localnet-nosana-finish-isolated-test';
export const PROGRAM_SHA256 = '5b6312cf46b7ecbca7a0014fb114a1a7e0fb11861eadf3280dc1a7aafd231400';
export const PROGRAM_DATA = '7MfLnSgjBq6wf6MMCn25qzPmfe5pAYnn5zicKSPLCf8v';
const enc = getAddressEncoder();
const b58 = getBase58Decoder();
const bytes58 = getBase58Encoder();
const decoder = getTransactionDecoder();
const digest = label => createHash('sha256').update(`nosana-job-finish-public-fixture:${label}`).digest();
const fixtureAddress = label => getAddressDecoder().decode(digest(label));
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? Number(v) : v);

export async function programBinary({ allowDownload = true } = {}) {
  const directory = resolve('.test-artifacts/localnet');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'nosana-jobs.so');
  let data;
  try { data = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || !allowDownload) throw error;
    const request = { jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [PROGRAM_DATA, { encoding: 'base64', commitment: 'finalized' }] };
    const response = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Read-only program download failed: HTTP ${response.status}`);
    const result = await response.json();
    assert(!result.error && result.result?.value, 'No finalized program account returned');
    const account = Buffer.from(result.result.value.data[0], 'base64');
    assert.equal(account.readUInt32LE(0), 3, 'Expected upgradeable ProgramData');
    data = account.subarray(45);
    assert.equal(createHash('sha256').update(data).digest('hex'), PROGRAM_SHA256,
      'Published program changed; review it before updating this pinned fixture');
    await writeFile(path, data, { mode: 0o600 });
    await writeFile(resolve(directory, 'program-provenance.json'), JSON.stringify({
      program: JOBS, programdata: PROGRAM_DATA, commitment: 'finalized',
      readSlot: result.result.context.slot, deploymentSlot: String(account.readBigUInt64LE(4)),
      binaryBytes: data.length, sha256: PROGRAM_SHA256,
    }, null, 2) + '\n');
  }
  assert.equal(createHash('sha256').update(data).digest('hex'), PROGRAM_SHA256);
  assert.equal(data.subarray(0, 4).toString('hex'), '7f454c46');
  return data;
}

function tokenData(mint, owner, amount) {
  const data = Buffer.alloc(165);
  data.set(enc.encode(mint), 0); data.set(enc.encode(owner), 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1; // Initialized
  return data;
}

export async function createFixture({ price = 10n, timeout = 3600n, elapsed = 600n,
  missingNodeAta = false, missingPayerAta = false, nodeLamports = 10_000_000_000n } = {}) {
  const svm = new LiteSVM();
  svm.addProgram(JOBS, await programBinary());
  const now = 1_800_000_000n;
  svm.setClock(new Clock(1000n, now - 1000n, 0n, 0n, now));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(digest('node-signing-seed'));
  const wrongSigner = await createKeyPairSignerFromPrivateKeyBytes(digest('wrong-signing-seed'));
  const host = signer.address;
  const payer = fixtureAddress('job-payer');
  const job = fixtureAddress('job');
  const run = fixtureAddress('run');
  const market = fixtureAddress('market');
  const [vault, bump] = await getProgramDerivedAddress({ programAddress: JOBS,
    seeds: [enc.encode(market), enc.encode(NOS)] });
  const getAta = async owner => (await getProgramDerivedAddress({ programAddress: ATA,
    seeds: [enc.encode(owner), enc.encode(TOKEN), enc.encode(NOS)] }))[0];
  const nodeAta = await getAta(host); const payerAta = await getAta(payer);
  const set = (accountAddress, owner, data, lamports) => {
    svm.setAccount({ address: accountAddress, executable: false,
      lamports: lamports ?? svm.minimumBalanceForRentExemption(BigInt(data.length)),
      programAddress: owner, data: new Uint8Array(data), space: BigInt(data.length) });
  };
  set(host, SYSTEM, Buffer.alloc(0), nodeLamports);
  set(payer, SYSTEM, Buffer.alloc(0), 10_000_000n);
  set(wrongSigner.address, SYSTEM, Buffer.alloc(0), 10_000_000n);
  const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
  mint.writeBigUInt64LE(1_000_000_000n, 36); set(NOS, TOKEN, mint);
  set(vault, TOKEN, tokenData(NOS, vault, price * timeout));
  if (!missingNodeAta) set(nodeAta, TOKEN, tokenData(NOS, host, 1000n));
  if (!missingPayerAta) set(payerAta, TOKEN, tokenData(NOS, payer, 2000n));
  const jobData = { ipfsJob: new Uint8Array(32).fill(7), ipfsResult: new Uint8Array(32),
    market, node: SYSTEM, payer, price, project: payer, state: 0,
    timeEnd: 0n, timeStart: 0n, timeout };
  set(job, JOBS, getJobAccountEncoder().encode(jobData));
  set(run, JOBS, getRunAccountEncoder().encode({ job, node: host, payer: host, state: 0, time: now - elapsed }));
  set(market, JOBS, getMarketAccountEncoder().encode({ authority: payer,
    jobExpiration: 0n, jobPrice: price, jobTimeout: timeout, jobType: 0,
    vault, vaultBump: bump, nodeAccessKey: SYSTEM, nodeXnosMinimum: 0n,
    queueType: 0, queue: [] }));
  return { svm, host, signer, wrongSigner, payer, job, run, market, vault, nodeAta, payerAta,
    now, price, timeout, elapsed, nodeInitial: missingNodeAta ? 0n : 1000n,
    payerInitial: missingPayerAta ? 0n : 2000n, set,
    tokenAmount(at) { const a = svm.getAccount(at); return a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : 0n; },
    changeJob(patch) { Object.assign(jobData, patch); set(job, JOBS, getJobAccountEncoder().encode(jobData)); },
    readJob() { const a = svm.getAccount(job); return getJobAccountDecoder().decode(a.data); },
  };
}

function rpcAccount(account) {
  if (!account || !account.exists) return null;
  return { data: [Buffer.from(account.data).toString('base64'), 'base64'],
    executable: account.executable, lamports: Number(account.lamports),
    owner: account.programAddress, rentEpoch: 0, space: account.data.length };
}
function errorValue(failure) {
  if (!(failure instanceof FailedTransactionMetadata)) return null;
  const err = failure.err();
  if (typeof err === 'number') return `LiteSVMError${err}`;
  if (typeof err.index === 'number') {
    const inner = err.err();
    return { InstructionError: [err.index, typeof inner?.code === 'number' ? { Custom: inner.code } : String(inner)] };
  }
  return String(err);
}
function innerInstructions(meta) {
  return meta.innerInstructions().map((items, index) => ({ index, instructions: items.map(item => {
    const ix = item.instruction();
    return { programIdIndex: ix.programIdIndex(), accounts: [...ix.accounts()],
      data: b58.decode(ix.data()), stackHeight: item.stackHeight() };
  }) })).filter(group => group.instructions.length);
}
function tokenBalances(keys, accounts) {
  return accounts.flatMap((account, accountIndex) => {
    if (!account?.exists || account.programAddress !== TOKEN || account.data.length !== 165) return [];
    const data = Buffer.from(account.data); const amount = data.readBigUInt64LE(64);
    return [{ accountIndex, mint: getAddressDecoder().decode(data.subarray(0, 32)),
      owner: getAddressDecoder().decode(data.subarray(32, 64)), programId: TOKEN,
      uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: Number(amount) / 1e6,
        uiAmountString: (Number(amount) / 1e6).toString() } }];
  });
}

// This bridge transports real LiteSVM execution/results over JSON-RPC. It does
// not invent program outcomes, transfers, balances, or signature verification.
export async function serveFixture(fixture) {
  const { svm } = fixture; let height = 1000; let hideStatuses = false; let beforeCommit;
  const history = new Map(); const calls = [];
  const context = value => ({ context: { apiVersion: 'local-litesvm-1.6.2', slot: Number(svm.getClock().slot) }, value });
  const accountAt = a => svm.getAccount(address(a));
  function metaFor(result, wire, before, after) {
    const nativeMeta = result instanceof FailedTransactionMetadata ? result.meta() : result;
    const message = VersionedTransaction.deserialize(Buffer.from(wire, 'base64')).message;
    const keys = message.staticAccountKeys.map(k => k.toBase58());
    return { err: errorValue(result), fee: 5000 * message.header.numRequiredSignatures,
      preBalances: before.map(a => a.exists ? Number(a.lamports) : 0),
      postBalances: after.map(a => a.exists ? Number(a.lamports) : 0),
      innerInstructions: innerInstructions(nativeMeta), logMessages: nativeMeta.logs(),
      preTokenBalances: tokenBalances(keys, before), postTokenBalances: tokenBalances(keys, after),
      loadedAddresses: { readonly: [], writable: [] }, rewards: [],
      computeUnitsConsumed: Number(nativeMeta.computeUnitsConsumed()) };
  }
  async function handle(method, params) {
    calls.push(method);
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getVersion') return { 'solana-core': 'litesvm-1.6.2', 'feature-set': 0 };
    if (method === 'getSlot') return Number(svm.getClock().slot);
    if (method === 'getBlockHeight') return height;
    if (method === 'isBlockhashValid') return context(params[0] === svm.latestBlockhash());
    if (method === 'getLatestBlockhash') return context({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: height + 150 });
    if (method === 'getMinimumBalanceForRentExemption') return Number(svm.minimumBalanceForRentExemption(BigInt(params[0])));
    if (method === 'getBalance') return context(Number(svm.getBalance(address(params[0])) ?? 0n));
    if (method === 'getFeeForMessage') {
      const message = Buffer.from(params[0], 'base64');
      return context(5000 * message[message[0] & 128 ? 1 : 0]);
    }
    if (method === 'getAccountInfo') return context(rpcAccount(accountAt(params[0])));
    if (method === 'getMultipleAccounts') return context(params[0].map(a => rpcAccount(accountAt(a))));
    if (method === 'getProgramAccounts') {
      const config = params[1] ?? {};
      const value = svm.getProgramAccounts(address(params[0])).filter(a => (config.filters ?? []).every(filter => {
        if ('dataSize' in filter) return a.data.length === filter.dataSize;
        const expected = filter.memcmp.encoding === 'base64' ? Buffer.from(filter.memcmp.bytes, 'base64') : bytes58.encode(filter.memcmp.bytes);
        return Buffer.from(a.data).subarray(Number(filter.memcmp.offset), Number(filter.memcmp.offset) + expected.length).equals(Buffer.from(expected));
      })).map(a => ({ pubkey: a.address, account: rpcAccount({ ...a, exists: true }) }));
      return config.withContext ? context(value) : value;
    }
    if (method === 'simulateTransaction') {
      const transaction = decoder.decode(Buffer.from(params[0], 'base64'));
      const config = params[1] ?? {};
      svm.withSigverify(config.sigVerify === true);
      let result;
      try { result = svm.simulateTransaction(transaction); } finally { svm.withSigverify(true); }
      const meta = result instanceof FailedTransactionMetadata ? result.meta() : result.meta();
      const post = result instanceof FailedTransactionMetadata ? new Map() : new Map(result.postAccounts().map(a => [a.address, { ...a, exists: true }]));
      return context({ err: errorValue(result), logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()),
        returnData: null, innerInstructions: innerInstructions(meta),
        accounts: config.accounts?.addresses?.map(a => rpcAccount(post.get(a) ?? accountAt(a))) ?? null });
    }
    if (method === 'sendTransaction') {
      const wire = params[0]; const raw = Buffer.from(wire, 'base64');
      const transaction = decoder.decode(raw);
      const decoded = VersionedTransaction.deserialize(raw);
      const signature = b58.decode(decoded.signatures[0]);
      if (history.has(signature)) return signature;
      if (!params[1]?.skipPreflight) {
        const simulation = svm.simulateTransaction(transaction);
        if (simulation instanceof FailedTransactionMetadata) {
          const error = new Error('Transaction simulation failed');
          error.rpc = { code: -32002, message: error.message, data: { err: errorValue(simulation), logs: simulation.meta().logs() } };
          throw error;
        }
      }
      const keys = decoded.message.staticAccountKeys.map(k => k.toBase58());
      if (beforeCommit) { const race = beforeCommit; beforeCommit = undefined; race(); }
      const before = keys.map(accountAt);
      const result = svm.sendTransaction(transaction);
      const after = keys.map(accountAt);
      const meta = metaFor(result, wire, before, after);
      history.set(signature, { slot: Number(svm.getClock().slot), blockTime: Number(svm.getClock().unixTimestamp),
        version: 0, transaction: [wire, 'base64'], meta });
      return signature;
    }
    if (method === 'getSignatureStatuses') return context(params[0].map(signature => {
      if (hideStatuses || !history.has(signature)) return null;
      const tx = history.get(signature);
      return { slot: tx.slot, confirmations: null, err: tx.meta.err,
        confirmationStatus: 'finalized', status: tx.meta.err ? { Err: tx.meta.err } : { Ok: null } };
    }));
    if (method === 'getTransaction') return hideStatuses ? null : history.get(params[0]) ?? null;
    throw new Error(`Unsupported local VM RPC method: ${method}`);
  }
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
      const result = await handle(body.method, body.params ?? []);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(json({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(json({ jsonrpc: '2.0', id: body?.id ?? null,
        error: error.rpc ?? { code: -32603, message: error.message } }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolveListen(); });
  });
  return { rpcUrl: `http://127.0.0.1:${server.address().port}`, calls, history,
    hideStatus(value = true) { hideStatuses = value; },
    beforeNextCommit(action) { beforeCommit = action; },
    expire() { height += 151; svm.expireBlockhash(); },
    async close() { await new Promise(resolveClose => server.close(resolveClose)); },
  };
}
