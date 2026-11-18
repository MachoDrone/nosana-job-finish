# Launcher and release validation

The Linux launcher downloads an immutable tool archive from the versioned GitHub
release and checks its embedded SHA-256 before extraction. It uses installed
Node.js 24+ when available; otherwise it downloads a pinned official runtime into
a private temporary directory. No system installation is performed.

Required Linux tools: Bash, tar, gzip, mktemp, flock (util-linux), curl or wget,
and sha256sum or shasum. The temporary-runtime fallback supports glibc Linux on
x86-64 and ARM64. Unsupported platforms fail with an explanation.

The archive includes the CLI, explicit package/document files, and locked
production dependencies. Development-only package roots are excluded using the
lockfile, and every installed production package version is compared with that
lock. No repository-root keys, journals, `.env`, tests or temporary artifacts are
included. Source-directory credential-like filenames are rejected. Package
symlinks must resolve inside the project.

## Runtime provenance

Read from the official Node.js release manifest on 2026-11-18:
[Node.js 24.22.2 SHASUMS256.txt](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt).

| Official archive | SHA-256 |
| --- | --- |
| `node-v24.22.2-linux-x64.tar.gz` | `361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9` |
| `node-v24.22.2-linux-arm64.tar.gz` | `95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2` |

The launcher embeds these digests; it does not trust a freshly downloaded checksum
manifest during execution. The mutable `main` launcher remains the trust entry
point. Users can substitute a reviewed commit SHA in its raw GitHub URL.

## Build and release sequence

1. Install locked dependencies with lifecycle scripts disabled; run the required
   application tests and freeze the candidate.
2. Run `python3 tools/build-release.py --write-launcher`. It writes the immutable
   archive, generated launcher, checksum list and build manifest to `dist/`, and
   updates the tracked launcher with the exact archive hash.
3. Review and commit the prepared launcher with the candidate. Upload the archive,
   launcher, `SHA256SUMS` and `BUILD-MANIFEST.json` to its matching versioned release.
   Do not replace files under an already published release; use a new version.
4. Verify anonymous downloads and both advertised curl/wget commands against the
   published bytes. The launcher at `main` must not point at absent release assets.

Archive ordering, timestamps, owners and gzip headers are normalized, so the
same inputs produce the same bytes. Changing source, README, package files or a
packaged dependency requires rebuilding and reviewing the resulting launcher.

## Focused tests

`node --test --test-isolation=none test/launcher.test.mjs` exercises:

- Piped Bash, quoted/literal arguments, CLI exit codes, and no-color output.
- curl and wget download paths.
- Installed, missing and old Node, and x86-64/ARM64 runtime selection.
- Tool/runtime checksum failures and failed downloads before CLI execution.
- Unsupported OS/architecture/libc and missing flock.
- Forwarded termination, temporary cleanup, and retained external journals.
- A real pseudo-terminal: piped Bash source and `/dev/tty` human input stay separate.
- Deterministic builds, pinned production packages, dev-package exclusion, and
  exclusion of unrelated repository-root private-file fixtures.

All eight focused tests passed in 1.203 seconds during implementation; Bash syntax
and Python compilation passed. The first pipeline fixture exposed waiting for
stdin after CLI completion; an explicit launcher exit fixed it. The failed run
was retained in the development conversation and was not treated as a pass.
Architecture download selection is fixture-tested; it is not a claim that an
ARM64 binary was executed on the x86-64 development host.

For `curl | bash` and `wget | bash`, use `set -o pipefail` to retain downloader
failure status. Process substitution can give Bash an empty stream if the initial
download fails: require the tool's visible header/result, not only exit code zero.
After the launcher itself starts, its own downloads always fail closed.
