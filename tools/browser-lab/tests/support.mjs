import {test as base, expect} from '@playwright/test';
import {PNG} from 'pngjs';

export {expect};
export const test = base.extend({
  page: async ({page}, use, testInfo) => {
    const errors = [], blocked = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.context().route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1:4173') return route.continue();
      blocked.push(url.origin + url.pathname);
      return route.abort('blockedbyclient');
    });
    try {await use(page);}
    finally {
      await testInfo.attach('browser-errors.json', {body: JSON.stringify({errors, blocked}, null, 2), contentType: 'application/json'});
      expect(errors, 'Uncaught JavaScript or browser console error').toEqual([]);
      expect(blocked, 'Fixtures must not require external network requests').toEqual([]);
    }
  },
});

export function decodePoster(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) throw new Error('Expected PNG canvas poster');
  return Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
}

export function pixelStats(buffer) {
  const png = PNG.sync.read(buffer), colors = new Set();
  let differentFromCorner = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const pixel = png.data.readUInt32BE(i);
    colors.add(pixel);
    if (pixel !== png.data.readUInt32BE(0)) differentFromCorner++;
  }
  return {width: png.width, height: png.height, colors: colors.size, differentFromCorner};
}

export function pixelDifference(a, b) {
  const left = PNG.sync.read(a), right = PNG.sync.read(b);
  if (left.width !== right.width || left.height !== right.height) throw new Error('Image dimensions differ');
  let changedPixels = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    if (left.data.readUInt32BE(i) !== right.data.readUInt32BE(i)) changedPixels++;
  }
  return changedPixels;
}
