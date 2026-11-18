import { mkdir, open, readdir, rename, stat, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';

const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
const terminal = new Set(['finalized', 'failed', 'expired']);
const identifier = value => {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(value)) throw new Error('Invalid journal identifier.');
  return value;
};

export class JournalStore {
  constructor(directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'nosana-job-finish')) {
    this.directory = resolve(directory);
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error(`Recovery directory must be owned by you and private (mode 700): ${this.directory}`);
    }
  }
  async read(signature) {
    await this.init();
    const file = await open(join(this.directory, `${identifier(signature)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 1048576) throw new Error('Recovery journal has unsafe ownership, permissions, or size.');
      const value = JSON.parse(await file.readFile('utf8'));
      if (value.schemaVersion !== 1 || value.signed?.signature !== signature) throw new Error('Invalid recovery journal.');
      return value;
    } finally { await file.close(); }
  }
  async list({ pendingOnly = false, job } = {}) {
    await this.init();
    const result = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,100}\.json$/.test(name)) continue;
      const entry = await this.read(name.slice(0, -5));
      if ((!pendingOnly || !terminal.has(entry.status)) && (!job || entry.signed.job === job)) result.push(entry);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async writeAtomic(value, first = false) {
    await this.init();
    const signature = identifier(value.signed.signature);
    const target = join(this.directory, `${signature}.json`);
    if (first) {
      try { await stat(target); throw new Error('This transaction already has a recovery journal.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const temp = join(this.directory, `.${signature}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(json(value)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, target);
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return value;
  }
  async save(signed) {
    return this.writeAtomic({ schemaVersion: 1, createdAt: new Date().toISOString(), status: 'prepared', signed }, true);
  }
  async update(entry, result) {
    const current = await this.read(entry.signed.signature);
    if (json(current.signed) !== json(entry.signed)) throw new Error('Recovery transaction changed unexpectedly.');
    return this.writeAtomic({ ...current, status: result.status, lastCheckedAt: new Date().toISOString(), result });
  }
  async lock(job) {
    await this.init();
    const path = join(this.directory, `${identifier(job)}.lock`);
    const file = await open(path, constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
    const info = await file.stat();
    await file.close();
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Unsafe job lock permissions.');
    // Kernel lock releases automatically when stdin closes or the parent dies.
    // No stale PID-file deletion and no shell interpolation of paths.
    const child = spawn('flock', ['--nonblock', path, '/bin/sh', '-c', 'printf "locked\\n"; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('The Linux flock command is required for safe job locking.')));
      child.once('exit', () => reject(new Error('Another instance is handling this job. Close it before trying again.')));
      child.stdout.once('data', data => data.toString().startsWith('locked\n') ? resolve() : reject(new Error('Could not acquire job lock.')));
    });
    return async () => {
      child.stdin.end();
      await exited;
    };
  }
}
