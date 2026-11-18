import { openSync, closeSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import { createInterface } from 'node:readline/promises';

export function cleanText(value) {
  return String(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 2000);
}

export function yes(value) { return /^(y|yes)$/i.test(String(value).trim()); }
export function amount(value, decimals) {
  const n = BigInt(value); const negative = n < 0n; const abs = negative ? -n : n;
  const divisor = 10n ** BigInt(decimals);
  return `${negative ? '-' : ''}${abs / divisor}.${String(abs % divisor).padStart(decimals, '0')}`;
}

export function createTerminal({ noColor = false } = {}) {
  let fd;
  try { fd = openSync('/dev/tty', 'r+'); }
  catch { throw new Error('Open an interactive Linux terminal to use the menu. No transaction was sent. Use --help for instructions.'); }
  const input = new ReadStream(fd, { autoClose: false });
  const output = new WriteStream(fd);
  const color = !noColor && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' && process.stdout.isTTY;
  const codes = { title: 36, warning: 33, danger: 31, success: 32, muted: 90 };
  const rl = createInterface({ input, output, terminal: true });
  let closed = false;
  const ui = {
    line(message = '', kind) {
      const text = cleanText(message);
      output.write(`${color && codes[kind] ? `\x1b[${codes[kind]}m` : ''}${text}${color && codes[kind] ? '\x1b[0m' : ''}\n`);
    },
    async ask(prompt) {
      try { return await rl.question(cleanText(prompt)); }
      catch { throw new Error('Input closed. No new transaction will be submitted.'); }
    },
    async choose(title, choices, defaultValue) {
      while (true) {
        ui.line(`\n${title}`, 'title');
        for (const [key, label] of choices) ui.line(`  ${key}) ${label}`);
        const answer = (await ui.ask(defaultValue ? `Choose [${defaultValue}]: ` : 'Choose: ')).trim() || defaultValue;
        if (choices.some(([key]) => key === answer)) return answer;
        ui.line('Please enter one of the menu numbers.', 'warning');
      }
    },
    async confirm(message) { return yes(await ui.ask(`${message} [y/N] `)); },
    close() {
      if (closed) return;
      closed = true;
      rl.close(); input.destroy(); output.destroy();
      try { closeSync(fd); } catch {}
    },
  };
  rl.on('SIGINT', () => process.emit('SIGINT'));
  return ui;
}

export function showPreview(ui, preview) {
  ui.line('\nSelected job', 'title');
  ui.line(`Host: ${preview.host}`);
  ui.line(`Job:  ${preview.job}`);
  const p = preview.payment;
  ui.line(`Recorded elapsed time: ${p.elapsedSeconds} seconds (may include downtime)`);
  ui.line(`Potential payment — estimate only: ${amount(p.estimatedNosBaseUnits, 6)} NOS`, 'warning');
  ui.line(`Estimated SOL cost: ${amount(preview.sol.totalDebitLamports, 9)} SOL`);
  if (BigInt(preview.sol.rentLamports)) ui.line(`Includes token-account creation: ${amount(preview.sol.rentLamports, 9)} SOL`, 'warning');
  ui.line(`Any unused funds go to the job payer: ${preview.snapshot.payer}`);
}

export function showOutcome(ui, result) {
  if (result.status === 'cancelled') { ui.line('Cancelled. Nothing was submitted.'); return; }
  if (result.status === 'finalized') {
    ui.line('Job ended on-chain.', 'success');
    const paid = result.payment?.nosBaseUnits ?? result.payment?.receivedNosBaseUnits ?? result.receivedNosBaseUnits;
    if (paid !== undefined && paid !== null && BigInt(paid) > 0n) ui.line(`Payment verified in this transaction: ${amount(paid, 6)} NOS`, 'success');
    else if (paid !== undefined && paid !== null) ui.line('No payment was observed in this transaction.');
    else ui.line('Payment could not be verified.', 'warning');
    ui.line('Actual workload shutdown has not been independently verified.', 'warning');
  } else if (result.status === 'failed') {
    ui.line('The transaction failed. This attempt did not end the job.', 'danger');
    if (result.error) ui.line(`Chain error: ${JSON.stringify(result.error)}`);
  } else if (result.status === 'expired') {
    ui.line('The recorded transaction expired without verified success. Inspect the job again before a new attempt.', 'warning');
  } else {
    ui.line('Transaction pending or unresolved. Outcome not yet confirmed.', 'warning');
    ui.line('Use “Check an earlier attempt” before trying to end this job again.');
  }
  if (result.signature) ui.line(`Transaction: https://explorer.solana.com/tx/${result.signature}`);
  if (result.message) ui.line(result.message, 'warning');
  else if (result.note) ui.line(result.note, 'warning');
}
