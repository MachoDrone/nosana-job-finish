#!/usr/bin/env python3
"""Exercise the actual CLI/readline without a real wallet or RPC.

The child's HOME is disposable and its CLI RPC points to an unused loopback port.
Only initial menus are visited. One public synthetic key checks warning text.
Confirmation uses the exported terminal UI directly.
Any spawn, timeout, signal, or assertion failure fails the check; nothing is skipped.
"""
import argparse
import errno
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import tempfile
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
SGR = re.compile(rb"\x1b\[[0-9;]*m")


class Terminal:
    def __init__(self, node, home, arguments=None, source=None, extra_env=None, pipe_input=None):
        self.output = b""
        self.cursor = 0
        self.status = None
        pipe = os.pipe() if pipe_input is not None else None
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.chdir(ROOT)
                environment = {
                    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                    "HOME": str(home), "XDG_STATE_HOME": str(home / "state"),
                    "TERM": "xterm-256color", "LANG": "C.UTF-8",
                    **(extra_env or {}),
                }
                if pipe:
                    os.close(pipe[1])
                    os.dup2(pipe[0], 0)
                    os.close(pipe[0])
                args = [node, "--input-type=module", "-e", source] if source else [
                    node, "src/cli.mjs", "--rpc", "https://127.0.0.1:9", *(arguments or [])]
                os.execve(node, args, environment)
            except BaseException as error:
                os.write(2, f"PTY child exec failed: {error}\n".encode())
                os._exit(127)
        self.pid, self.master = pid, master
        if pipe:
            os.close(pipe[0])
            os.write(pipe[1], pipe_input)
            os.close(pipe[1])

    def read(self, delay=0.05):
        if select.select([self.master], [], [], delay)[0]:
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            self.output += chunk
        if self.status is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.status = os.waitstatus_to_exitcode(status)

    def until(self, expected, timeout=5):
        expected = expected.encode()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = self.output.find(expected, self.cursor)
            if found >= 0:
                self.cursor = found + len(expected)
                return
            self.read()
            if self.status is not None:
                break
        raise AssertionError(f"Expected terminal text {expected!r}; status={self.status}; output={self.output!r}")

    def send(self, data):
        os.write(self.master, data.encode() if isinstance(data, str) else data)

    def finish(self, expected=0, timeout=5):
        deadline = time.monotonic() + timeout
        while self.status is None and time.monotonic() < deadline:
            self.read()
        self.read(0)
        assert self.status == expected, f"Exit {self.status}, expected {expected}; output={self.output!r}"
        return self.output

    def close(self):
        if self.status is None:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
        os.close(self.master)


def exercise(node):
    results = []
    with tempfile.TemporaryDirectory(prefix="nosana-finish-ui-") as directory:
        home = Path(directory)

        def scenario(name, action, **options):
            started = time.monotonic()
            session = None
            result = {"name": name, "passed": False}
            try:
                session = Terminal(node, home, **options)
                action(session)
                result["passed"] = True
            except BaseException as error:
                result["error"] = str(error)
            finally:
                if session:
                    result["exitCode"] = session.status
                    result["output"] = session.output.decode(errors="replace").replace(str(home), "<temporary-home>")
                    session.close()
                result["durationMs"] = round((time.monotonic() - started) * 1000, 2)
                results.append(result)

        def normal(session):
            session.until("Choose [1]: ")
            assert b"Payment may not always be guaranteed." in session.output
            assert b"Use a public host address (preview only)" in session.output
            assert b"Check a previous submission (no key needed)" in session.output
            assert str(home / ".nosana/nosana_key.json").encode() in session.output
            assert b"\x1b[36m" in session.output, "Meaningful title color absent on color terminal"
            session.send("0\n")
            session.finish()

        scenario("real CLI starts and exits from host menu", normal)

        def invalid(session):
            session.until("Choose [1]: ")
            session.send("9\n")
            session.until("Please enter one of the menu numbers.")
            session.until("Choose [1]: ")
            session.send("3\n")
            session.until("Public host address: ")
            session.send("invalid\n")
            session.until("Enter a valid Solana host address.")
            session.until("Choose [1]: ")
            session.send("2\n")
            session.until("Example: /home/alice/keys/host-2.json or ~/keys/host-2.json")
            session.until("Key-file path: ")
            session.send(str(home / "missing.json") + "\n")
            session.until("Key file not found:")
            session.until("Choose [1]: ")
            session.send("0\n")
            session.finish()

        scenario("invalid menus, public address and missing custom key recover", invalid)

        def public_host(session):
            host = "11111111111111111111111111111111"
            session.until("Choose [1]: ")
            session.send("3\n")
            session.until("Public host address: ")
            session.send(host + "\n")
            session.until("What would you like to do?")
            session.until("Choose [1]: ")
            assert b"1) Preview ending a job (no changes)" in session.output
            assert b"2) End a job" in session.output
            assert b"3) Check a previous submission" in session.output
            assert b"4) Choose another host" in session.output
            session.send("2\n")
            session.until("Choose a matching host key to end a job. A public address can only preview.")
            session.until("What would you like to do?")
            session.until("Choose [1]: ")
            session.send("4\n")
            session.until("Choose a host")
            session.until("Choose [1]: ")
            session.send("0\n")
            output = session.finish()
            assert output.count(f"Host: {host}".encode()) == 1, "Unchanged host identity repeated between actions"
            assert b"Checking unfinished jobs" not in output, "Public-address End action reached the RPC flow"

        scenario("public host cannot end a job and identity stays concise across menus", public_host)

        def key_permissions(session):
            warning = "Other users on this computer may be able to read or change this private key file."
            session.until(warning)
            session.until("Choose [1]: ")
            session.send("0\n")
            output = session.finish()
            assert output.count(warning.encode()) == 1
            assert (home / "public-fixture-key.json").stat().st_mode & 0o777 == 0o644, "Warning changed key permissions"

        key_source = """
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from '@solana/kit';
import { writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Public deterministic test fixture; never a real wallet and never signs a transaction.
const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
const path = join(homedir(), 'public-fixture-key.json');
writeFileSync(path, JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]));
chmodSync(path, 0o644);
// Node --eval has no script-name argv entry; parseArgs starts at argv[1].
process.argv = [process.execPath, '--rpc', 'https://127.0.0.1:9', '--key-file', path];
await import('./src/cli.mjs');
"""
        scenario("synthetic key permission warning is clear and leaves mode unchanged", key_permissions, source=key_source)

        def confirm(session):
            session.until("Do you want to end this job? [y/N] ")
            session.send("\n")
            session.until("First answer: false")
            session.until("Do you want to end this job? [y/N] ")
            session.send("YES\n")
            session.until("Second answer: true")
            session.finish()

        source = """
import { createTerminal } from './src/ui.mjs';
const ui = createTerminal();
try {
  ui.line('Job: synthetic-job'); ui.line('Host: synthetic-host');
  ui.line('Payment may not always be guaranteed.', 'warning');
  ui.line(`First answer: ${await ui.confirm('Do you want to end this job?')}`);
  ui.line(`Second answer: ${await ui.confirm('Do you want to end this job?')}`);
} finally { ui.close(); }
"""
        scenario("real readline confirmation defaults no and accepts natural yes", confirm, source=source)

        def interrupt(session):
            session.until("Choose [1]: ")
            session.send(b"\x03")
            session.until("Cancelled. Any already-sent transaction remains in the recovery menu.")
            session.finish(130)

        scenario("Ctrl-C exits clearly without a key or transaction", interrupt)

        def eof(session):
            session.until("Choose [1]: ")
            session.send(b"\x04")
            session.until("Input closed. No new transaction will be submitted.")
            session.finish(1)

        scenario("terminal EOF exits clearly without hanging", eof)

        def no_color(session):
            session.until("Choose [1]: ")
            session.send("0\n")
            output = session.finish()
            assert not SGR.search(output), "Color escapes appeared with color disabled"

        scenario("--no-color suppresses color formatting", no_color, arguments=["--no-color"])
        scenario("NO_COLOR suppresses color formatting", no_color, extra_env={"NO_COLOR": "1"})

        def piped(session):
            session.until("Choose [1]: ")
            # Stdin already contains affirmative/menu text; prompts must use /dev/tty.
            assert b"What would you like to do?" not in session.output
            session.send("0\n")
            session.finish()

        scenario("piped stdin cannot answer terminal menus", piped, pipe_input=b"3\nyes\nyes\n")
        assert not (home / "state").exists(), "Menu-only scenarios created a recovery store unexpectedly"
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"))
    args = parser.parse_args()
    if not args.node:
        parser.error("Node is not on PATH; pass --node /absolute/path/to/node")
    node = str(Path(args.node).resolve(strict=True))
    results = exercise(node)
    report = {"passed": all(item["passed"] for item in results), "liveSigningOrNetwork": False,
              "method": "actual CLI/exported UI processes attached to independent Linux PTYs",
              "createdAt": datetime.now(timezone.utc).isoformat(), "scenarios": results}
    artifacts = ROOT / ".test-artifacts/interactive"
    artifacts.mkdir(parents=True, exist_ok=True)
    output = artifacts / ("report-" + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ") + ".json")
    output.write_text(json.dumps(report, indent=2) + "\n")
    report["artifact"] = str(output.relative_to(ROOT))
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
