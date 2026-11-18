#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { createChain, SIMULATION_RESULT_CID } from './chain.mjs';
import { createTerminal, showPreview, showOutcome, cleanText } from './ui.mjs';
import { loadHostKey, publicHost } from './keys.mjs';
import { JournalStore } from './journal.mjs';
import { createResultStore, validateCid } from './results.mjs';
import { endJob, checkAttempt } from './workflow.mjs';

const HELP = `Nosana Job Finish 0.1.1 — Linux

Preview ending a host's job without making changes, or end a selected job.
Payment may not always be guaranteed.

Run: node src/cli.mjs [--key-file PATH] [--rpc HTTPS_URL] [--no-color]
     node src/cli.mjs --help

The menu offers ~/.nosana/nosana_key.json, another local key-file path,
or a public host address for read-only use. All live actions require an
interactive y/N confirmation. There is no --yes or unattended send mode.

Examples: --key-file ~/keys/host-2.json
          --key-file '/home/alice/My keys/host.json'

Run as the key-file owner. No sudo, Docker, or local Nosana installation is
required. Linux x86-64/ARM64 (glibc) and util-linux flock are supported.
Recovery records: ~/.local/state/nosana-job-finish (or XDG_STATE_HOME)
No private keys are stored there. Signed pending transactions are retained.
`;

let ui;
try {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    'no-color': { type: 'boolean' }, 'key-file': { type: 'string' },
    rpc: { type: 'string', default: 'https://api.mainnet-beta.solana.com' },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(HELP); }
  else if (values.version) { console.log('0.1.1'); }
  else {
  if (process.platform !== 'linux') throw new Error('This release supports Linux only.');
  const url = new URL(values.rpc);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS Solana mainnet RPC URL without embedded username/password.');
  ui = createTerminal({ noColor: values['no-color'] });
  process.once('SIGINT', () => {
    ui.line('\nCancelled. Any already-sent transaction remains in the recovery menu.', 'warning');
    ui.close(); process.exit(130);
  });
  process.once('SIGTERM', () => { ui.close(); process.exit(143); });
  ui.line('Nosana Job Finish 0.1.1', 'title');
  ui.line('Payment may not always be guaranteed.', 'warning');
  const chain = createChain({ rpcUrl: values.rpc });
  const resultStore = createResultStore();
  const journals = new JournalStore();
  let identity = values['key-file'] ? await loadHostKey(values['key-file']) : undefined;
  let showIdentity = true;

  async function chooseIdentity() {
    while (true) {
      const selection = await ui.choose('Choose a host or check a previous submission', [
        ['1', `Use the usual key file: ${homedir()}/.nosana/nosana_key.json`],
        ['2', 'Choose another key file on this computer'],
        ['3', 'Use a public host address (preview only)'],
        ['4', 'Check a previous submission (no key needed)'], ['0', 'Exit'],
      ], '1');
      if (selection === '0') return null;
      try {
        if (selection === '4') { await recoveryMenu(); continue; }
        if (selection === '3') return { host: publicHost(await ui.ask('Public host address: ')) };
        if (selection === '2') {
          ui.line('Example: /home/alice/keys/host-2.json or ~/keys/host-2.json');
          return await loadHostKey(await ui.ask('Key-file path: '));
        }
        return await loadHostKey('~/.nosana/nosana_key.json');
      } catch (error) { ui.line(error.message, 'danger'); }
    }
  }

  async function selectJob(host) {
    ui.line('Checking unfinished jobs…', 'title');
    const runs = await chain.listRuns(host);
    if (runs.length === 1) { ui.line(`Job: ${runs[0].job}`); return runs[0].job; }
    if (!runs.length) ui.line('No unfinished job was found for this host.');
    const choices = runs.map((run, i) => [String(i + 1), `${run.job} — started ${new Date(Number(run.time) * 1000).toISOString()}`]);
    choices.push(['m', 'Enter a job address'], ['0', 'Back']);
    const selected = await ui.choose('Select a job', choices, '0');
    if (selected === '0') return null;
    return selected === 'm' ? publicHost(await ui.ask('Job address: ')) : runs[Number(selected) - 1].job;
  }

  async function recoveryMenu() {
    const entries = await journals.list();
    if (!entries.length) { ui.line('No previous submissions are saved on this computer.'); return; }
    const choices = entries.map((entry, i) => [String(i + 1), `${entry.signed.job} — ${entry.status} — ${entry.createdAt}`]);
    choices.push(['0', 'Back']);
    const choice = await ui.choose('Check a previous submission', choices, '0');
    if (choice === '0') return;
    const entry = entries[Number(choice) - 1];
    ui.line(`Host: ${entry.signed.host}`); ui.line(`Job:  ${entry.signed.job}`);
    const result = await checkAttempt({ chain, entry, journals, notify: message => ui.line(message, 'title'),
      confirmRebroadcast: async () => {
        ui.line('This transaction is still unresolved. Resending uses exactly the same saved transaction.', 'warning');
        return ui.confirm('Resend that same transaction?');
      },
    });
    showOutcome(ui, result);
  }

  while (true) {
    if (!identity) identity = await chooseIdentity();
    if (!identity) break;
    if (showIdentity) {
      ui.line(`\nHost: ${identity.host}`, 'title');
      if (identity.path) ui.line(`Key file: ${identity.path}`);
      if (identity.permissionWarning) ui.line('Other users on this computer may be able to read or change this private key file.', 'warning');
      showIdentity = false;
    }
    const choice = await ui.choose('What would you like to do?', [
      ['1', 'Preview ending a job (no changes)'], ['2', 'End a job'],
      ['3', 'Check a previous submission'],
      ['4', 'Choose another host'], ['0', 'Exit'],
    ], '1');
    if (choice === '0') break;
    if (choice === '4') { identity = undefined; showIdentity = true; continue; }
    try {
      if (choice === '3') { await recoveryMenu(); continue; }
      if (choice === '2' && !identity.signer) { ui.line('Choose a matching host key to end a job. A public address can only preview.', 'warning'); continue; }
      const job = await selectJob(identity.host);
      if (!job) continue;
      ui.line('Checking the job and simulating the end-job transaction without signing…', 'title');
      const preview = await chain.prepare({ host: identity.host, job, resultCid: SIMULATION_RESULT_CID });
      showPreview(ui, preview);
      if (choice !== '2') continue;
      let resultChoice = {};
      const resultMode = await ui.choose('Job result', [
        ['1', 'Use a short, honest interruption report (usual choice)'],
        ['2', 'Advanced: use an existing result CID'], ['0', 'Back'],
      ], '1');
      if (resultMode === '0') continue;
      if (resultMode === '2') {
        resultChoice.cid = validateCid((await ui.ask('Existing result CID (Qm…): ')).trim());
        await resultStore.verifyExisting(resultChoice.cid, job, identity.host);
        ui.line('Use an existing CID only if you know it belongs to this job.', 'warning');
      }
      const result = await endJob({ chain, preview, identity, resultChoice, resultStore, journals,
        notify: message => ui.line(message, 'title'),
        confirm: async () => {
          ui.line('\nEnd this job', 'danger');
          ui.line(`Job:  ${job}`); ui.line(`Host: ${identity.host}`);
          ui.line('Payment may not always be guaranteed.', 'warning');
          ui.line('This closes the run on-chain. A running host may take time to stop its workload.', 'warning');
          if (!resultChoice.cid) ui.line('A short public record will say termination was requested and original outputs are unavailable.');
          return ui.confirm('Do you want to end this job?');
        },
      });
      showOutcome(ui, result);
    } catch (error) {
      ui.line(error.message, 'danger');
      ui.line('If a submission was saved, use “Check a previous submission” to verify its outcome.');
    }
  }
  }
} catch (error) {
  if (ui) ui.line(error.message, 'danger');
  else console.error(cleanText(error.message));
  process.exitCode = 1;
} finally { ui?.close(); }
