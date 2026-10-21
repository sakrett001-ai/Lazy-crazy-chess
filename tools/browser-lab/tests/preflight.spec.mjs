import {test, expect} from './support.mjs';

test('WebGL2 renders a real triangle and exposes its renderer', async ({page, browser}, info) => {
  await page.goto('/preflight.html');
  const result = await page.evaluate(() => window.preflight);
  await info.attach('webgl.json', {body: JSON.stringify({browser: browser.version(), mode: process.env.QA_RENDERER || 'software', ...result}, null, 2), contentType: 'application/json'});
  await info.attach('webgl.png', {body: await page.screenshot(), contentType: 'image/png'});
  expect(result?.ok, result?.error || 'No actual WebGL render').toBe(true);
  expect(result.pixel[0]).toBeGreaterThan(230);
  expect(result.pixel[1]).toBeGreaterThan(45);
  expect(result.pixel[1]).toBeLessThan(85);
  expect(result.pixel[2]).toBeGreaterThan(110);
  if ((process.env.QA_RENDERER || 'software') === 'software') expect(result.renderer).toMatch(/SwiftShader/i);
});
