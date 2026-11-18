import { defaultIPFSConfig } from '@nosana/ipfs';
import { ipfsHashToSolBytesArray } from '@nosana/kit';
import { isDeepStrictEqual } from 'node:util';

export function validateCid(cid) {
  if (typeof cid !== 'string' || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) throw new Error('Use a CIDv0 result address beginning Qm (not a URL).');
  const bytes = ipfsHashToSolBytesArray(cid);
  if (bytes.length !== 32 || bytes.every(n => n === 0)) throw new Error('Invalid result CID.');
  return cid;
}

export function interruptionReport({ job, host, recordedAt = new Date().toISOString(), testFixture = false }) {
  return {
    status: 'stopped', startTime: 0, endTime: null, opStates: [],
    errors: [{ event: 'manual-termination-request',
      message: testFixture
        ? 'Public integration-test fixture. No real host workload is represented or stopped.'
        : 'The host operator requested manual termination. Original workload outputs and execution timestamps were not recovered. Actual workload shutdown is not independently verified.',
      job, node: host, recordedAt,
      ...(testFixture ? { testFixture: true } : {}),
    }],
  };
}

async function boundedJson(response, limit = 262144) {
  if (!response.ok) throw new Error(`Result service returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Result content exceeds the size limit.');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Result content exceeds the size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Result service did not return valid JSON.'); }
}

export function createResultStore({ fetchImpl = globalThis.fetch, jwt = defaultIPFSConfig.jwt } = {}) {
  async function retrieve(cid) {
    validateCid(cid);
    const response = await fetchImpl(`https://nosana.mypinata.cloud/ipfs/${cid}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    return boundedJson(response);
  }
  return {
    retrieve,
    async verifyExisting(cid, job, host) {
      const result = await retrieve(cid);
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.status !== 'string' || !Array.isArray(result.opStates)) {
        throw new Error('The CID does not contain a readable Nosana job result.');
      }
      if ((result.job && result.job !== job) || (result.id && result.id !== job)) throw new Error('The supplied result identifies a different job.');
      for (const record of Array.isArray(result.errors) ? result.errors : []) {
        if (record?.event !== 'manual-termination-request') continue;
        if (record.job !== undefined && record.job !== job) throw new Error('The supplied interruption record identifies a different job.');
        if (host !== undefined && record.node !== undefined && record.node !== host) throw new Error('The supplied interruption record identifies a different host.');
      }
      return { cid, status: result.status };
    },
    async publishVerified(report) {
      const response = await fetchImpl('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ pinataContent: report, pinataOptions: { cidVersion: 0 } }),
      });
      const body = await boundedJson(response, 16384);
      const cid = validateCid(body.IpfsHash);
      try {
        const retrieved = await retrieve(cid);
        if (!isDeepStrictEqual(retrieved, report)) throw new Error('Published result does not match the approved interruption report.');
      } catch (error) {
        throw new Error(`A result was published at ${cid}, but retrieval verification failed. Nothing was signed or submitted. ${error.message}`);
      }
      return cid;
    },
  };
}
