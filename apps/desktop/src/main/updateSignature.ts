import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Update signatures, the same scheme since desktop 1.2.0: the release workflow signs
 * `purrlor-desktop-update\n<version>\n<sha256 of the file, lowercase hex>\n` with ECDSA P-256 and
 * SHA-256, the signature as raw r||s (IEEE P1363, what .NET's ECDsa.SignData makes), base64. The
 * version is inside, so an old download can't be passed off as a new one.
 */
export function signedMessage(version: string, sha256Hex: string): Buffer {
  return Buffer.from(`purrlor-desktop-update\n${version}\n${sha256Hex.toLowerCase()}\n`, 'utf8');
}

export function loadPublicKey(spkiBase64: string | undefined | null): KeyObject | null {
  if (!spkiBase64) return null;
  try {
    return createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function verifySignature(key: KeyObject, version: string, sha256Hex: string, signature: Buffer): boolean {
  try {
    return verify('sha256', signedMessage(version, sha256Hex), { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

export async function verifyFile(key: KeyObject, path: string, version: string, signature: Buffer): Promise<boolean> {
  return verifySignature(key, version, await sha256File(path), signature);
}

/** "1.2.3" or "v1.2.3" to [1, 2, 3]; anything else is null. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
