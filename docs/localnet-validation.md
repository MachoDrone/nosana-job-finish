# Isolated signing and settlement validation

The integration harness executes the **actual Nosana Jobs SBF binary** inside
LiteSVM 1.6.2. It uses synthetic accounts, deterministic public fixture keys and
synthetic funds. No user wallet, real host, mainnet signature or live transaction
is used.

Run from the repository root with Node 24:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run test:localnet
```

The first run downloads one public program-data account with a read-only,
finalized `getAccountInfo` request. It verifies the pinned SHA-256 before loading
the binary and caches it under ignored `.test-artifacts/localnet`. Subsequent
runs reuse those verified bytes. A changed program causes an explicit failure;
there is no automatic acceptance of a new binary. A local loopback TCP listener
is required for the RPC transport adapter.

## Program provenance

| Item | Value |
| --- | --- |
| Program | `nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM` |
| Program-data account | `7MfLnSgjBq6wf6MMCn25qzPmfe5pAYnn5zicKSPLCf8v` |
| Observed deployment slot | `462434394` |
| Finalized download context slot | `470904735` |
| ELF bytes, excluding 45-byte loader metadata | `914080` |
| SHA-256 | `5b6312cf46b7ecbca7a0014fb114a1a7e0fb11861eadf3280dc1a7aafd231400` |

The NOS mint uses the production address and six decimals. The fixture creates
the vault PDA from the market and mint, with that PDA as token authority. It
uses the published generated account layouts, while economic expectations are
specified independently: rate **10 base units/second**, funded timeout **3,600
seconds**, elapsed time **600 seconds**, initial host tokens **1,000**, initial
payer tokens **2,000**. Therefore a successful ordinary run must transfer
**6,000** to the host, refund **30,000**, leave the vault empty, update the job,
and close its run account. Simulation must leave the bank unchanged.

## Recorded gate

On 2026-11-18 at 05:52 EST, the final adapter candidate passed all **10 scenarios**,
with total scenario time **907.583 ms** (not including process startup or initial
program download):

1. Paid Finish, exact refund and recovery from a persisted synthetic journal.
2. Zero-price Finish closes the run without a NOS payment.
3. Elapsed time beyond the funded timeout pays only the capped amount.
4. Missing host and payer token accounts are created with the expected rent.
5. A wrong signing key and a funded job extension after review refuse signing.
6. The simulation marker cannot be signed; altered signed bytes are rejected
   both by the tool and by LiteSVM's native signature verification.
7. Failed signed simulation leaves the job pending and pays no NOS.
8. A committed transaction with temporarily unavailable status remains pending,
   then reconciles the same signature without another payment.
9. A state change after successful preflight makes actual VM execution fail:
   the job remains pending, no NOS is paid, and the 5,000-lamport fee is charged.
10. An unsubmitted transaction whose blockhash expires is reconciled without
    creating or submitting a replacement transaction.

The successful full report is retained locally as
`.test-artifacts/localnet/report-2026-11-18T10-52-38-598Z.json`, SHA-256
`1d3c8cd1fd04410893c121b660c2153c413f97f4f1b3452a57cae02a6a7cdc49`.
The tested chain adapter SHA-256 was
`7943c8e4b702b6759249ba49ed5b9c6d64f741bb2093ac5d89de443c032c68c3`.
The report records every scenario, duration and RPC method used. Synthetic
journals and fixture binaries are ignored by Git and excluded from the release.
The preceding successful 05:46 EST report remains preserved locally; this final
gate reran after bounded RPC transport and finalized-proof changes.

## Preserved failures and limits

- The execution sandbox initially denied loopback listening (`EPERM`). The
  harness was then run with permission to bind localhost; this was an
  environment restriction, not a program failure.
- The initial changed-job fixture increased timeout without funding the
  corresponding escrow. The tool correctly rejected it at the earlier escrow
  check. The fixture was corrected to model a funded extension; the original
  failing report remains at
  `.test-artifacts/localnet/report-2026-11-18T10-45-47-169Z.json`.
- LiteSVM executes and verifies the real transaction, program, signatures and
  token changes. The loopback adapter serializes those results as JSON-RPC; it
  marks committed VM transactions finalized immediately. This **does not test
  consensus finality, real RPC availability, or network transaction delivery**.
- State setup deliberately bypasses account-creation transactions. Assertions
  cover the specified reachable settlement layouts, not every possible market
  or historical host version. The independent mainnet simulation gate covers
  a real public job without signing or submitting it.
- Ending a job, discovering a payment and verifying workload shutdown are
  separate outcomes. These tests do not guarantee payment for every job or
  establish that a remote host's containers have stopped.

References: [LiteSVM](https://solana.com/docs/tools/litesvm),
[Nosana Finish source](https://github.com/nosana-ci/nosana-programs/blob/79b69715642e650538995ac78d5920885f1929fe/programs/nosana-jobs/src/instructions/finish.rs),
[Solana simulation](https://solana.com/docs/rpc/http/simulatetransaction).
