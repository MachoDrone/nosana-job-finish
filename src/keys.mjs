import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createKeyPairSignerFromBytes, address } from '@solana/kit';

export function expandPath(input, home = homedir()) {
  let path = String(input).trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Enter a valid key-file path.');
  if (path === '~') path = home;
  else if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`;
  else if (path.startsWith('~')) throw new Error('Use ~/ or a full path, such as /home/alice/keys/host.json.');
  return resolve(path);
}

export function publicHost(input) {
  try { return address(String(input).trim()); }
  catch { throw new Error('Enter a valid Solana host address.'); }
}

export async function loadHostKey(input) {
  const requestedPath = expandPath(input);
  let file, bytes, parsed;
  try {
    const path = await realpath(requestedPath);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('The key must be a small, regular JSON file.');
    bytes = await file.readFile();
    if (bytes.length > 4096) throw new Error('Key file is too large.');
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('The selected file is not valid JSON.'); }
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('Expected a Solana key file containing an array of 64 byte values.');
    }
    const secret = Uint8Array.from(parsed);
    let signer;
    try { signer = await createKeyPairSignerFromBytes(secret, false); }
    catch { throw new Error('The key file is invalid: its private and public parts do not match.'); }
    finally { secret.fill(0); }
    return { host: signer.address, signer, path, permissionWarning: Boolean(stat.mode & 0o077) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Key file not found: ${requestedPath}`);
    if (error.code === 'EACCES') throw new Error('This user cannot read the selected key file. Run as its owner or choose a readable key; permissions were not changed.');
    throw error;
  } finally {
    bytes?.fill(0);
    if (Array.isArray(parsed)) parsed.fill(0);
    await file?.close();
  }
}
