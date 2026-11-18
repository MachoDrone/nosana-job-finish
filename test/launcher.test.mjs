import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const template = readFileSync(join(root, 'tools/launcher-template.sh'), 'utf8');
const originalX64 = '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9';
const originalArm = '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2';
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const executable = (path, contents) => { writeFileSync(path, contents); chmodSync(path, 0o755); };
const fakeNode = `#!/bin/bash
if [[ "$1" == -p ]]; then printf '%s\\n' "\${TEST_NODE_MAJOR:-24}"; exit 0; fi
if [[ "$1" == --version ]]; then printf 'v24.22.2\\n'; exit 0; fi
exec /bin/bash "$@"
`;
const downloader = `#!/bin/bash
output=''; url=''
while (( $# )); do
  case "$1" in
    --output) shift; output=$1 ;;
    --output-document=*) output=\${1#*=} ;;
    https://*) url=$1 ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$TEST_DOWNLOADS"
[[ "\${TEST_DOWNLOAD_FAIL:-0}" != 1 ]] || exit 22
if [[ "$url" == https://nodejs.org/* ]]; then
  cp -- "$TEST_NODE_ARCHIVE" "$output"
else
  cp -- "$TEST_TOOL_ARCHIVE" "$output"
fi
`;

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nosana-launcher-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const temporary = join(dir, 'temporary'); mkdirSync(temporary);
  for (const name of ['tar','gzip','sha256sum','mktemp','rm','cp','sleep','flock']) {
    const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
    assert.equal(found.status, 0, `fixture prerequisite ${name}`);
    symlinkSync(found.stdout.trim(), join(bin, name));
  }
  executable(join(bin, 'uname'), '#!/bin/bash\nif [[ "$1" == -s ]]; then printf "%s\\n" "${TEST_OS:-Linux}"; else printf "%s\\n" "${TEST_ARCH:-x86_64}"; fi\n');
  executable(join(bin, 'getconf'), '#!/bin/bash\n[[ "${TEST_MUSL:-0}" != 1 ]] || exit 1\nprintf "glibc 2.39\\n"\n');
  executable(join(bin, options.wget ? 'wget' : 'curl'), downloader);
  if (!options.noInstalledNode) executable(join(bin, 'node'), fakeNode);
  const content = join(dir, 'content'); mkdirSync(join(content, 'nosana-job-finish/src'), { recursive: true });
  writeFileSync(join(content, 'nosana-job-finish/src/cli.mjs'), options.cli ?? `#!/bin/bash
printf 'CLI'
printf '<%s>' "$@"
printf '\\n'
`);
  const toolArchive = join(dir, 'tool.tar.gz');
  assert.equal(spawnSync('/usr/bin/tar', ['-czf', toolArchive, '-C', content, 'nosana-job-finish']).status, 0);
  const arch = options.arm ? 'arm64' : 'x64';
  const runtimeRoot = join(dir, 'runtime');
  const runtimeName = `node-v24.22.2-linux-${arch}`;
  mkdirSync(join(runtimeRoot, runtimeName, 'bin'), { recursive: true });
  executable(join(runtimeRoot, runtimeName, 'bin/node'), fakeNode);
  const nodeArchive = join(dir, 'node.tar.gz');
  assert.equal(spawnSync('/usr/bin/tar', ['-czf', nodeArchive, '-C', runtimeRoot, runtimeName]).status, 0);
  const launcher = template.replaceAll('@TOOL_VERSION@', '0.1.0')
    .replaceAll('@TOOL_FILE@', 'nosana-job-finish-0.1.0.tar.gz')
    .replaceAll('@TOOL_SHA256@', digest(toolArchive))
    .replace(originalX64, digest(nodeArchive)).replace(originalArm, digest(nodeArchive));
  const launcherPath = join(dir, 'launcher.sh'); writeFileSync(launcherPath, launcher);
  const env = { ...process.env, PATH: bin, TMPDIR: temporary, NO_COLOR: '1',
    TEST_TOOL_ARCHIVE: toolArchive, TEST_NODE_ARCHIVE: nodeArchive,
    TEST_DOWNLOADS: join(dir, 'downloads.txt'), TEST_ARCH: options.arm ? 'aarch64' : 'x86_64',
    TEST_OS: 'Linux', TEST_MUSL: '0', TEST_NODE_MAJOR: '24', TEST_DOWNLOAD_FAIL: '0' };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  return { dir, bin, temporary, env, launcher, launcherPath, toolArchive, nodeArchive,
    run: (args = [], changes = {}, piped = false) => spawnSync('/bin/bash', piped ? ['-s', '--', ...args] : [launcherPath, ...args],
      { input: piped ? launcher : undefined, encoding: 'utf8', env: { ...env, ...changes }, timeout: 10_000 }) };
}

test('piped launcher forwards literal arguments, preserves exit status, and cleans temporary files', t => {
  const f = fixture(t);
  const result = f.run(['a path with spaces', '$(touch should-not-exist)', '--no-color'], {}, true);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /CLI<a path with spaces><\$\(touch should-not-exist\)><--no-color>/);
  assert(!result.stderr.includes('\u001b'));
  assert.deepEqual(readdirSync(f.temporary), []);
  assert(!readdirSync(f.dir).includes('should-not-exist'));
  assert.equal(readFileSync(f.env.TEST_DOWNLOADS, 'utf8').trim(), 'https://github.com/MachoDrone/nosana-job-finish/releases/download/v0.1.0/nosana-job-finish-0.1.0.tar.gz');
});

test('wget is supported when curl is absent and the CLI exit code survives', t => {
  const f = fixture(t, { wget: true, cli: '#!/bin/bash\nexit 17\n' });
  const result = f.run();
  assert.equal(result.status, 17, result.stderr);
  assert.deepEqual(readdirSync(f.temporary), []);
});

test('missing or old Node downloads a verified temporary x64 or ARM64 runtime', t => {
  for (const arm of [false, true]) {
    const f = fixture(t, { noInstalledNode: true, arm });
    const result = f.run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CLI<--help>/);
    assert(readFileSync(f.env.TEST_DOWNLOADS, 'utf8').includes(`node-v24.22.2-linux-${arm ? 'arm64' : 'x64'}.tar.gz`));
    assert.deepEqual(readdirSync(f.temporary), []);
  }
  const f = fixture(t);
  assert.equal(f.run([], { TEST_NODE_MAJOR: '20' }).status, 0);
  assert.match(readFileSync(f.env.TEST_DOWNLOADS, 'utf8'), /nodejs\.org/);
});

test('corrupt tool/runtime archives and failed downloads never run the CLI', t => {
  for (const kind of ['tool','node','download']) {
    const f = fixture(t, { noInstalledNode: kind === 'node' });
    if (kind === 'tool') writeFileSync(f.toolArchive, 'corrupted');
    if (kind === 'node') writeFileSync(f.nodeArchive, 'corrupted');
    const result = f.run([], kind === 'download' ? { TEST_DOWNLOAD_FAIL: '1' } : {});
    assert.notEqual(result.status, 0);
    assert(!result.stdout.includes('CLI'));
    assert.match(result.stderr, kind === 'download' ? /Could not download/ : /checksum did not match/);
    assert.deepEqual(readdirSync(f.temporary), []);
  }
});

test('unsupported platform and missing requirements fail clearly without downloads', t => {
  const f = fixture(t, { noInstalledNode: true });
  assert.match(f.run([], { TEST_OS: 'Darwin' }).stderr, /Linux only/);
  assert.match(f.run([], { TEST_ARCH: 'riscv64' }).stderr, /Unsupported Linux architecture/);
  assert.match(f.run([], { TEST_MUSL: '1' }).stderr, /glibc-based Linux/);
  rmSync(join(f.bin, 'flock'));
  assert.match(f.run().stderr, /flock.*required/);
  assert.deepEqual(readdirSync(f.temporary), []);
});

test('termination reaches the CLI, removes temporary files, and preserves outside journals', async t => {
  const f = fixture(t, { cli: `#!/bin/bash
trap 'exit 143' TERM
printf 'pending\\n' > "$TEST_JOURNAL"
printf 'READY\\n'
while true; do sleep 0.05; done
` });
  const journal = join(f.dir, 'journal.json');
  const child = spawn('/bin/bash', [f.launcherPath], { env: { ...f.env, TEST_JOURNAL: journal }, stdio: ['ignore','pipe','pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not start: ${stderr}`)), 5000);
    child.stdout.on('data', b => { stdout += b; if (stdout.includes('READY')) { clearTimeout(timer); resolveReady(); } });
    child.once('error', reject);
  });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  child.kill('SIGTERM');
  const outcome = await exited;
  assert.equal(outcome.code, 143, stderr);
  assert.deepEqual(readdirSync(f.temporary), []);
  assert.equal(readFileSync(journal, 'utf8'), 'pending\n');
});

test('piped Bash leaves the controlling terminal available for human answers', t => {
  const f = fixture(t, { cli: '#!/bin/bash\nprintf "QUESTION\\n"\nread -r answer </dev/tty\nprintf "ANSWER=%s\\n" "$answer"\n' });
  const python = `import os, pty, select, subprocess, sys, time
pid, master = pty.fork()
if pid == 0:
    script = open(sys.argv[1], 'rb').read()
    result = subprocess.run(['/bin/bash', '-s'], input=script)
    os._exit(result.returncode)
data = b''
answered = False
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try: block = os.read(master, 8192)
        except OSError: break
        if not block: break
        data += block
        if b'QUESTION' in data and not answered:
            os.write(master, b'yes\\n'); answered = True
    done, status = os.waitpid(pid, os.WNOHANG)
    if done: break
else:
    os.kill(pid, 9)
    raise SystemExit('PTY test timed out')
sys.stdout.buffer.write(data)
assert b'ANSWER=yes' in data, data
`;
  const result = spawnSync('/usr/bin/python3', ['-c', python, f.launcherPath], { encoding: 'utf8', env: f.env, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /ANSWER=yes/);
  assert.deepEqual(readdirSync(f.temporary), []);
});

test('release build is deterministic and excludes dev dependencies and unrelated private files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nosana-build-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tools')); mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules/production'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/dev-only'), { recursive: true });
  const pkg = { name: 'nosana-job-finish', version: '0.1.0', dependencies: { production: '1.0.0' }, devDependencies: { 'dev-only': '1.0.0' } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': pkg, 'node_modules/production': { version: '1.0.0' }, 'node_modules/dev-only': { version: '1.0.0', dev: true } } }));
  writeFileSync(join(dir, 'node_modules/production/package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(dir, 'node_modules/dev-only/package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(dir, 'node_modules/dev-only/private.txt'), 'development fixture');
  writeFileSync(join(dir, 'src/cli.mjs'), 'console.log("fixture");\n');
  writeFileSync(join(dir, 'README.md'), 'fixture\n'); writeFileSync(join(dir, 'LICENSE'), 'fixture\n');
  writeFileSync(join(dir, '.env'), 'NOT_FOR_RELEASE=1\n');
  writeFileSync(join(dir, 'nosana_key.json'), 'not a key; private-name fixture\n');
  writeFileSync(join(dir, 'tools/launcher-template.sh'), template);
  const build = () => spawnSync('/usr/bin/python3', [join(root, 'tools/build-release.py'), '--root', dir, '--write-launcher'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(build().status, 0);
  const archive = join(dir, 'dist/nosana-job-finish-0.1.0.tar.gz');
  const first = digest(archive);
  assert.equal(build().status, 0);
  assert.equal(digest(archive), first);
  const listing = spawnSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0);
  assert(listing.stdout.includes('node_modules/production/package.json'));
  assert(!listing.stdout.includes('dev-only'));
  assert(!listing.stdout.includes('.env'));
  assert(!listing.stdout.includes('nosana_key.json'));
  assert(readFileSync(join(dir, 'nosana-job-finish.sh'), 'utf8').includes(first));
});
