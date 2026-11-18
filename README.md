# Nosana Job Finish

A menu-driven Linux tool to view a host's unfinished jobs, **test without making
changes**, or **end a selected job** using its host key.

**Payment may not always be guaranteed.** The tool reports payment only when it
can verify a transfer in the finalized transaction. A zero-payment job can still
end successfully.

Run it on the host itself or another Linux PC that has the host's key file.
Nosana, Docker and SSH access to the host are not required.

## Run directly from GitHub

With curl:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MachoDrone/nosana-job-finish/main/nosana-job-finish.sh)
```

Or wget:

```bash
bash <(wget -qO- https://raw.githubusercontent.com/MachoDrone/nosana-job-finish/main/nosana-job-finish.sh)
```

Piping also works; `pipefail` preserves download errors:

```bash
set -o pipefail
curl -fsSL https://raw.githubusercontent.com/MachoDrone/nosana-job-finish/main/nosana-job-finish.sh | bash
```

```bash
set -o pipefail
wget -qO- https://raw.githubusercontent.com/MachoDrone/nosana-job-finish/main/nosana-job-finish.sh | bash
```

No manual download, clone, chmod or npm installation is needed. The launcher
downloads a checksum-verified tool into a private temporary directory. If needed,
it also downloads a verified temporary Node.js runtime. It removes these files
when it exits and does not install system packages or change an installed Node.

Use a normal interactive terminal as the key-file owner. Linux x86-64 and ARM64
on glibc-based distributions are supported (including Ubuntu 22.04/24.04).
Bash, curl or wget, tar/gzip, sha256sum, getconf and util-linux `flock` are required.
The launcher names missing prerequisites; it does not run sudo or apt.

`main` provides the current launcher. For a fixed version, replace `main` with
`v0.1.0` or a reviewed commit SHA. Always expect the tool header and menu: a failed
process-substitution download can otherwise leave Bash an empty script.

## Using the menu

Choose the host identity:

1. **Use the usual key file:** `~/.nosana/nosana_key.json`, with the full path shown.
2. **Choose another key file on this computer:** for example
   `/home/alice/keys/host-2.json` or `~/keys/host-2.json`. Paths containing spaces work.
3. **Use a public host address:** view and test only; no private key is needed.
4. **Check an earlier attempt:** recover a saved transaction without loading a key.

The tool derives the host's public address from the selected key and finds its
unfinished runs. A single job is selected for preview; multiple jobs get a
numbered selection. An entered job address must belong to that host.

The action menu offers:

| Action | What happens |
| --- | --- |
| View and test a job (no changes) | Preview and simulate Finish without signing, publishing results or sending a transaction; the host still needs enough SOL for the simulated fee |
| End a job | Preview, confirm, then sign locally and submit Finish |
| Check an earlier attempt | Reconcile a saved transaction; optionally resend its identical signed bytes |
| Choose another host | Return to key/public-address selection |

Before ending a job, the preview shows the full job and host addresses, recorded
elapsed time, **potential payment — estimate only**, expected SOL fee and any
token-account creation cost. Elapsed on-chain time can include downtime; the
result report does not set the amount. The funded timeout caps the accounting.

The final confirmation is deliberately simple:

```text
Job:  <full job address>
Host: <full host address>

Payment may not always be guaranteed.
Do you want to end this job? [y/N]
```

`y` or `yes` continues, ignoring letter case. Enter, `n`, other answers, EOF, or
Ctrl-C cancel. There is no `--yes` or unattended-send option. The tool displays
the consequences and result-publication choice before this confirmation.

Colors reinforce text: cyan headings, yellow cautions/pending outcomes, red end
actions/errors and green verified success. `NO_COLOR=1`, `--no-color`, and
redirected output disable colors; meaning never depends on color alone.

## What ending a job means

This is a **manual on-chain Finish tool**, useful for an interrupted/stuck run or
an operator's deliberate early termination. It is not a workload-resume tool.

Finish closes the selected run on-chain. A running Nosana node should react to
the account change, but the tool does not directly stop its containers, shut
down the computer, or stop it taking future jobs. Workload shutdown is reported
as unverified. Node 1.1.91 can report an “already completed” error while reacting
to manual Finish, then clean up/restart its normal job loop. Other versions may
behave differently. Preserve any client outputs you need before ending a job.

Default result handling publishes a small, honest interruption record: manual
termination was requested, original results/timestamps were not recovered, and
workload shutdown was not independently verified. It contains the public job and
host addresses and the record time, with no workload logs or private keys.
It does not pretend the client's work succeeded. Publication happens only after
confirmation. The tool retrieves and checks the exact record before signing.

Advanced users can supply a retrievable existing **CIDv0** result (beginning
`Qm`) belonging to the selected job. The simulation marker is never submitted
as a real result. Publication or retrieval failure stops the live flow before
signing; a successfully published CID may remain public even if later steps fail.

The program determines whether payment occurs. Results distinguish:

- Job ended on-chain; a payment amount was verified in that transaction.
- Job ended on-chain; no payment was observed in that transaction.
- Transaction failed, expired, pending, or could not yet be reconciled.

“No payment observed” does not rule out other or later payments. Simulation is
an estimate against sampled chain state, not proof of completed work or a payment
receipt. A failed transaction can still incur a Solana network fee.

## Interrupted connections and earlier attempts

Before signed bytes leave the computer, the tool saves a private recovery record
under `~/.local/state/nosana-job-finish` (or `$XDG_STATE_HOME/nosana-job-finish`).
It contains the signed transaction, signature, result CID and public account
details. **It contains no private key.** Directory/file permissions are 700/600.

Do not delete an unresolved record or start a new attempt on another PC after a
timeout. Choose **Check an earlier attempt** on the original PC. The tool checks
the saved signature and can resend only the same bytes. It will not manufacture
a new signature because a connection dropped. If expiry is proven, inspect the
job again and review a new attempt. If another actor already settled the job,
the tool refuses a new Finish rather than treating a missing run as payment proof.

Recovery records remain after temporary downloads are cleaned up. Linux kernel
locks prevent two instances on the same PC from signing for the same job at once;
they release if the process exits. Avoid parallel attempts from different PCs.

## Options and troubleshooting

Append options after the process-substitution command, or use `bash -s -- OPTIONS`
when piping:

| Option | Effect |
| --- | --- |
| `--help` | Show help without loading a key or opening a menu |
| `--version` | Show the tool version |
| `--key-file '/path with spaces/host.json'` | Start with that local host key |
| `--rpc https://…` | Use another Solana mainnet RPC provider |
| `--no-color` | Disable colored output |

- **Key missing/unreadable:** choose the correct path on this computer or run as
  its owner. The tool does not change permissions or upload the key.
- **No unfinished job:** the host may be idle or the run already settled. Inspect
  its Explorer history; this does not prove payment was received.
- **Insufficient SOL:** the host key pays network fees and any required NOS token
  account rent. The tool never funds the wallet automatically.
- **RPC timeout/rate limit:** use a suitable mainnet RPC. An earlier submission
  must be reconciled before a new signing attempt.
- **Result service unavailable:** the live flow stops before signing. Nosana's
  published IPFS service is rate-limited; no private pinning credentials are
  requested or printed.
- **No terminal:** use an interactive terminal. Menus read `/dev/tty`, so normal
  piping of the launcher works without consuming its script as answers.

## Verification and development

Pinned dependencies: Nosana Kit 2.24.5, Jobs Program client 2.24.3 and Solana Kit
8.3.0. No package lifecycle scripts are needed.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:localnet
python3 tools/build-release.py --write-launcher
```

The isolated-chain harness executes the real pinned Nosana program in LiteSVM
using synthetic accounts/funds and real Ed25519 signatures. It is not a live
mainnet payment test and does not test Solana consensus or network delivery.
See [local-chain validation](docs/localnet-validation.md),
[launcher validation](docs/launcher-validation.md), and
[release verification](docs/VERIFICATION.md) for results and limits.

References: [Finish contract](https://github.com/nosana-ci/nosana-programs/blob/79b69715642e650538995ac78d5920885f1929fe/programs/nosana-jobs/src/instructions/finish.rs),
[node 1.1.91 job handling](https://github.com/nosana-ci/nosana-node/blob/997ce206d769230443ba53da52fd539b224880be/src/NodeManager/node/job/jobHandler.ts),
[Solana simulation](https://solana.com/docs/rpc/http/simulatetransaction),
[transaction submission](https://solana.com/docs/rpc/http/sendtransaction).
