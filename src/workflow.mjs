import { interruptionReport } from './results.mjs';

export async function endJob({ chain, preview, identity, resultChoice, resultStore, journals, confirm, notify = () => {} }) {
  if (!identity.signer || identity.host !== preview.host) throw new Error('A matching host key is required to end this job.');
  const unlock = await journals.lock(preview.job);
  try {
    if ((await journals.list({ pendingOnly: true, job: preview.job })).length) throw new Error('A previous submission is unresolved. Choose “Check a previous submission” first.');
    if (!await confirm()) return { status: 'cancelled' };
    await chain.assertUnchanged(preview);
    let cid;
    if (resultChoice.cid) {
      await resultStore.verifyExisting(resultChoice.cid, preview.job, preview.host);
      cid = resultChoice.cid;
    } else {
      notify('Publishing and verifying the interruption record…');
      cid = await resultStore.publishVerified(interruptionReport({ job: preview.job, host: preview.host }));
    }
    await chain.assertUnchanged(preview);
    const fresh = await chain.prepare({ host: preview.host, job: preview.job, resultCid: cid });
    if (BigInt(fresh.sol.totalDebitLamports) > BigInt(preview.sol.totalDebitLamports)) {
      throw new Error(`The estimated SOL cost increased. No transaction was signed. Review a new preview. Result CID: ${cid}`);
    }
    await chain.assertUnchanged(preview);
    const signed = await chain.signPrepared(fresh, identity.signer);
    const journal = await journals.save(signed);
    notify(`Recovery record saved. Transaction: ${signed.signature}`);
    let submitError;
    try { await chain.submit(signed); }
    catch (error) { submitError = error.message; notify('Submission was not confirmed. Checking the recorded transaction…'); }
    const result = await chain.reconcile(journal, { waitMs: submitError ? 15000 : 90000 });
    if (submitError) result.submissionMessage = submitError;
    await journals.update(journal, result);
    return { ...result, signature: signed.signature, resultCid: cid };
  } finally { await unlock(); }
}

export async function checkAttempt({ chain, entry, journals, confirmRebroadcast = async () => false, notify = () => {} }) {
  const unlock = await journals.lock(entry.signed.job);
  try {
    let result = await chain.reconcile(entry, { waitMs: 0 });
    if (result.status === 'pending' && await confirmRebroadcast()) {
      notify('Resending the identical saved transaction…');
      try { await chain.submit(entry.signed); } catch { /* Outcome is reconciled below. */ }
      result = await chain.reconcile(entry, { waitMs: 90000 });
    }
    await journals.update(entry, result);
    return { ...result, signature: entry.signed.signature, resultCid: entry.signed.resultCid };
  } finally { await unlock(); }
}
