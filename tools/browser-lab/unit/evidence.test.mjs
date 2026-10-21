import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {resolveAsset} from '../scripts/serve.mjs';
import {pixelStats, pixelDifference, decodePoster} from '../tests/support.mjs';

test('Static server limits reads to non-hidden fixture files, including symlinks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'browser-lab-'));
  try {
    const root = join(temp, 'site'); await mkdir(root);
    await writeFile(join(root, 'scene.html'), 'scene');
    await writeFile(join(temp, 'outside'), 'outside');
    await writeFile(join(root, '.secret'), 'secret');
    await symlink(join(temp, 'outside'), join(root, 'linked.html'));
    assert.equal(await resolveAsset(root, '/scene.html?view=front'), join(root, 'scene.html'));
    for (const path of ['/../outside', '/%2e%2e/outside', '/linked.html', '/.secret', '/%', '/']) {
      await assert.rejects(resolveAsset(root, path), undefined, path);
    }
  } finally {await rm(temp, {recursive: true, force: true});}
});

test('Pixel checks distinguish blank, changed and restored frames', () => {
  const image = new PNG({width: 20, height: 20}); image.data.fill(255);
  const blank = PNG.sync.write(image);
  assert.equal(pixelStats(blank).differentFromCorner, 0);
  image.data[40] = 0;
  const changed = PNG.sync.write(image);
  assert.equal(pixelDifference(blank, changed), 1);
  assert.equal(pixelDifference(changed, changed), 0);
  assert.equal(pixelStats(changed).differentFromCorner, 1);
  assert.throws(() => decodePoster('not a PNG'));
});
