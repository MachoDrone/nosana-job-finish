import test from 'node:test';
import assert from 'node:assert/strict';
import { yes, amount, showOutcome, cleanText } from '../src/ui.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
function run(command, args, options = {}) {
  const child = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 15000, ...options });
  assert.ifError(child.error); // Some restricted runners report status 0 alongside a spawn EPERM.
  assert.equal(child.signal, null, child.stderr);
  return child;
}
test('natural confirmation accepts y/yes only and defaults to no', () => {
  for (const input of ['y','Y','yes',' YES ']) assert.equal(yes(input), true);
  for (const input of ['', 'n','no','sure','true','1']) assert.equal(yes(input), false);
});
test('amounts use integer precision and outcomes avoid promised payment', () => {
  assert.equal(amount(881600n, 6), '0.881600');
  assert.equal(amount(900719925474099300n, 9), '900719925.474099300');
  const lines=[]; const ui={line:(text)=>lines.push(text)};
  showOutcome(ui,{status:'finalized',receivedNosBaseUnits:'0'});
  assert(lines.includes('No payment was observed in this transaction.'));
  assert(!lines.some(line=>line.includes('You will receive')));
  assert(!cleanText('Bearer private-token https://rpc.invalid/?api-key=private').includes('private'));
});
test('help needs no terminal or key; no terminal refuses menu', () => {
  const help = run(process.execPath, ['src/cli.mjs','--help']);
  assert.equal(help.status,0,help.stderr); assert.match(help.stdout,/Payment may not always be guaranteed/);
  const noTty=run(process.execPath,['src/cli.mjs'],{detached:true});
  assert.equal(noTty.status,1); assert.match(noTty.stderr,/interactive Linux terminal/);
});
test('actual terminal menus, confirmation, cancellation and piped entry', () => {
  const check = run('python3', ['tools/interactive-check.py', '--node', process.execPath], { timeout: 45000 });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  const report = JSON.parse(check.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.scenarios.length, 8);
  assert(report.scenarios.every(scenario => scenario.passed === true));
  assert.equal(report.liveSigningOrNetwork, false);
});
