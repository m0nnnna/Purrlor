import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * These files are the token server's, copied (each service is built on its own, so there's no
 * shared package to import from). They have to stay the same: a fix made in one belongs in both.
 * The errors and metrics tests themselves live with the token server's copies.
 */
const COPIES = ['openid.ts', 'errorLog.ts', 'metrics.ts', 'ops.ts'];

const here = dirname(fileURLToPath(import.meta.url));
const tokenServer = join(here, '..', '..', 'token-server', 'src');

describe('files shared with the token server', () => {
  for (const file of COPIES) {
    it(`${file} is the same as the token server's`, { skip: !existsSync(tokenServer) && 'no token server checkout next to this one' }, () => {
      // Line endings aside: a Windows checkout may have either.
      const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      assert.equal(read(join(here, file)), read(join(tokenServer, file)),`services/push-gateway/src/${file} differs from services/token-server/src/${file}`);
    });
  }
});
