# Release verification

## Version 0.1.1

Verified on 2026-11-18 with Node.js 24.22.2: **39 tests passed**, zero
failed/skipped, in **4.701 seconds**, including **10 actual terminal scenarios**.
The changed checks cover readable elapsed time, precise SOL formatting, explicit
payment uncertainty, the preview's no-submission conclusion, the renamed menus,
and showing the selected identity once when returning to the action menu.
A synthetic key with mode 0644 checks the clearer warning without changing its
permissions. No real wallet was read and no live transaction was submitted.

The initial synthetic-key test probe supplied an extra argv entry under Node's
`--eval`, causing argument parsing to fail before CLI startup. The fixture was
corrected; the original failed report was retained locally.

The transaction adapter, protocol fixtures, dependencies and launcher template
are unchanged. The ten isolated-program scenarios, unsigned mainnet simulation,
and temporary-runtime validation below are reused for those unchanged inputs.
Version 0.1.1 changes presentation and a recovery-menu error label; the new
release has its own archive checksum and preserves the version 0.1.0 assets.

## Version 0.1.0

Candidate checks were performed on 2026-11-18 on Linux x86-64 with Node.js
24.22.2. No real host key was loaded, no mainnet transaction was signed or
submitted, and no live job was stopped during development.

| Check | Observed result |
| --- | --- |
| Full application suite | 38 tests passed, zero failed/skipped; 3.879 seconds |
| Actual terminal interaction | Eight PTY scenarios passed inside the application suite: menus, bad input, Enter/no and YES confirmation, Ctrl-C, EOF, color controls and piped stdin |
| Actual Nosana program in isolation | Ten LiteSVM scenarios passed in 907.583 ms; real Ed25519 signatures, synthetic accounts/funds |
| Unsigned mainnet simulation | Passed at slot 470907659 in 5.369 seconds; 15,989 compute units; no signing or sending |
| Real result publication/readback | Explicit public test fixture pinned as CIDv0 and retrieved byte-for-JSON-equivalent; 1.928 seconds; no real job/host represented |
| Launcher/build fixtures | Eight tests included in the application suite, covering checksums, temporary runtime selection, curl/wget, cleanup, PTY piping and reproducibility |

The mainnet check used a user-authorized public host/job pair, a simulation-only
result marker, and state revalidation. Its sampled potential payment was
1.866440 NOS at 290 base units/second for 6,436 seconds. This is **not a payment
receipt or a statement of completed work**. The simulated network fee was
5,000 lamports, with no token-account rent required in that sampled state.

The result-service test used a record explicitly labeled as a test fixture:
[public fixture](https://nosana.mypinata.cloud/ipfs/QmWTVd8WQ3d3FTAwTnZf5pumeNn19E8wfUeh7PA5RGz5gz).
It exercised the SDK's published service configuration, required Pinata envelope,
CIDv0 selection, bounded download, and exact readback comparison. It does not
promise future availability or bypass service rate limits.

The final tested chain adapter SHA-256 was
`7943c8e4b702b6759249ba49ed5b9c6d64f741bb2093ac5d89de443c032c68c3`.
Later review changes concerned menus and existing-result identity validation;
the full suite includes those fixes. The final build manifest records the
packaged source and lockfile hashes. See [isolated-program evidence](localnet-validation.md)
and [launcher validation](launcher-validation.md) for scenario details and
runtime provenance.

### Failures retained during development

- An early piped launcher waited for more stdin after the child exited. The
  launcher now explicitly exits with the child's status; its pipeline test passes.
- An early CLI edit had a syntax error; help and terminal tests caught it and
  pass after correction.
- The execution sandbox denied subprocess/loopback access with `EPERM`.
  One subprocess API returned status zero alongside a launch error. Tests now
  explicitly reject launch errors and signals; final tests ran with authorized
  subprocess/PTY access, without skipping those checks.
- An initial changed-job integration fixture increased the timeout without
  increasing escrow. The earlier escrow rejection was correct. The corrected
  fixture funds the extension and verifies the intended changed-state rejection.
- Review found that an existing interruption record could name another job
  inside its error metadata. Job and host checks now cover that known schema,
  including multiple records; regression tests pass.

### Limits

Payment may not always be guaranteed. Zero-price jobs and failed transactions
are explicitly tested; a failed on-chain transaction can still cost a fee.
Simulation cannot guarantee later success. A finalized transaction receipt,
payment verification, and a host's actual workload shutdown are separate facts.

LiteSVM tests program execution and signatures, not Solana consensus or real
network delivery. The independent mainnet check is unsigned. ARM64 runtime
selection is tested with fixtures; an ARM64 binary was not executed on the
x86-64 development machine. The tool's recovery journal and lock coordinate one
computer; they cannot coordinate separate computers using the same host key.

After publication, the release is additionally checked through anonymous GitHub
downloads, the advertised curl/wget launchers, and its GitHub Actions workflow.
Public assets and checksum files are attached to the versioned release; assets
must not be replaced after publication.
