// Signs a release file for auto-update (src/main/updateSignature.ts): ECDSA P-256 over
// "purrlor-desktop-update\n<version>\n<sha256>\n", raw r||s, base64, written to <file>.sig.
// The private key (PEM) comes from DESKTOP_UPDATE_SIGNING_KEY, never from a file in the repo.
//
//   node scripts/sign-update.mjs <file> <version>
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [file, version] = process.argv.slice(2);
if (!file || !/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('usage: sign-update.mjs <file> <MAJOR.MINOR.PATCH>');
const pem = process.env.DESKTOP_UPDATE_SIGNING_KEY;
if (!pem) throw new Error("DESKTOP_UPDATE_SIGNING_KEY isn't set: installed apps would refuse this update");

const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
const message = Buffer.from(`purrlor-desktop-update\n${version}\n${hash}\n`, 'utf8');
const signature = sign('sha256', message, { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
writeFileSync(`${file}.sig`, signature.toString('base64'));
console.log(`signed ${file} (${version}, sha256 ${hash})`);
