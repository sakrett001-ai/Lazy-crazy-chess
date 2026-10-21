import {test, expect, decodePoster, pixelStats, pixelDifference} from './support.mjs';

async function open(page) {
  await page.goto('/contacts.html');
  await page.waitForFunction(() => window.ready === true);
  await expect(page.locator('canvas')).toHaveCount(2);
}

test('Rendered contact detects the 40 mm negative case across event boundaries', async ({page}, info) => {
  await open(page);
  const times = [0, .699, .7, .8, 1, 1.2, 1.201, 2];
  const rows = await page.evaluate(times => times.map(time => {
    const entries = Object.entries(window.adapters).map(([key, adapter]) => {
      adapter.draw({time});
      return [key, adapter.measure({time}).checks];
    });
    return {time, results: Object.fromEntries(entries)};
  }), times);
  await info.attach('contacts.json', {body: JSON.stringify(rows, null, 2), contentType: 'application/json'});
  for (const row of rows) {
    expect(row.results.none).toHaveLength(1);
    expect(row.results.none[0].ok).toBe(true);
    expect(row.results.none[0].gapMetres).toBeLessThan(1e-6);
    const broken = row.time >= .7 && row.time <= 1.2;
    expect(row.results.gap[0].ok, `t=${row.time}`).toBe(!broken);
    expect(row.results.gap[0].gapMetres).toBeCloseTo(broken ? .04 : 0, 7);
  }
  await page.evaluate(() => Object.values(window.adapters).forEach(a => a.draw({time: .8})));
  const posters = await page.evaluate(() => Object.fromEntries(Object.entries(window.adapters).map(([name, a]) => [name, a.poster()])));
  for (const [name, poster] of Object.entries(posters)) {
    const bytes = decodePoster(poster), stats = pixelStats(bytes);
    await info.attach(`${name}-canvas.png`, {body: bytes, contentType: 'image/png'});
    expect(stats.colors, `${name}: canvas is blank`).toBeGreaterThan(8);
    expect(stats.differentFromCorner).toBeGreaterThan(100);
  }
  expect(pixelDifference(decodePoster(posters.none), decodePoster(posters.gap))).toBeGreaterThan(100);
  await info.attach('contact-comparison.png', {body: await page.screenshot(), contentType: 'image/png'});
});

test('Seeking changes the rendered pose and restores the same frame', async ({page}, info) => {
  await open(page);
  const images = await page.evaluate(() => [.8, 1.5, .8].map(time => {
    const a = window.adapters.none;
    a.draw({time});
    return a.poster();
  }));
  const [first, moved, restored] = images.map(decodePoster);
  expect(pixelStats(first).differentFromCorner).toBeGreaterThan(100);
  expect(pixelDifference(first, moved)).toBeGreaterThan(100);
  expect(pixelDifference(first, restored)).toBe(0);
  await info.attach('pose-a.png', {body: first, contentType: 'image/png'});
  await info.attach('pose-b.png', {body: moved, contentType: 'image/png'});
});
