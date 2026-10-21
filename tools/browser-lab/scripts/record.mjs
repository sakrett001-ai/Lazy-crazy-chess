import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hashes = {};
async function visit(path) {
  for (const entry of await readdir(path, {withFileTypes: true})) {
    if (['node_modules', 'evidence', 'test-results', '.git'].includes(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile()) hashes[relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
}
await visit(root);
await mkdir(join(root, 'evidence'), {recursive: true});
await writeFile(join(root, 'evidence/input.json'), JSON.stringify({
  schema: 'browser-lab-input/1',
  recordedAt: new Date().toISOString(),
  browserStatus: 'not-yet-run',
  node: process.version,
  platform: process.platform,
  rendererMode: process.env.QA_RENDERER || 'software',
  commit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  hashes,
}, null, 2));
console.log('Recorded input hashes; this is not a browser test result.');
