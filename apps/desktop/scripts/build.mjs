// Bundles the app into dist/: the main process, the two preloads (sandboxed, so each has to be one
// file that requires nothing but electron), and the shell page with its fonts.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });

const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: 'linked', logLevel: 'warning' };

await Promise.all([
  build({ ...node, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(out, 'main.js'), external: ['electron', 'uiohook-napi'] }),
  build({ ...node, entryPoints: [join(root, 'src/preload/page.ts')], outfile: join(out, 'preload-page.js'), external: ['electron'] }),
  build({ ...node, entryPoints: [join(root, 'src/preload/shell.ts')], outfile: join(out, 'preload-shell.js'), external: ['electron'] }),
  build({
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', sourcemap: 'linked', logLevel: 'warning',
    entryPoints: [join(root, 'src/shell/shell.ts')], outfile: join(out, 'shell/shell.js'),
  }),
]);

mkdirSync(join(out, 'shell/fonts'), { recursive: true });
cpSync(join(root, 'src/shell/index.html'), join(out, 'shell/index.html'));
cpSync(join(root, 'src/shell/shell.css'), join(out, 'shell/shell.css'));
cpSync(join(root, 'build/icon.png'), join(out, 'icon.png'));
cpSync(join(root, 'src/shell/logo.png'), join(out, 'shell/logo.png'));
const fonts = [
  ['@fontsource/chakra-petch/files/chakra-petch-latin-400-normal.woff2', 'chakra-petch-400.woff2'],
  ['@fontsource/chakra-petch/files/chakra-petch-latin-500-normal.woff2', 'chakra-petch-500.woff2'],
  ['@fontsource/chakra-petch/files/chakra-petch-latin-600-normal.woff2', 'chakra-petch-600.woff2'],
  ['@fontsource/michroma/files/michroma-latin-400-normal.woff2', 'michroma-400.woff2'],
];
for (const [from, to] of fonts) cpSync(join(root, 'node_modules', from), join(out, 'shell/fonts', to));
