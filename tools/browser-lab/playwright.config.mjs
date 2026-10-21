import {defineConfig} from '@playwright/test';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const mode = process.env.QA_RENDERER || 'software';
if (!['software', 'native'].includes(mode)) throw new Error('QA_RENDERER must be software or native');

export default defineConfig({
  testDir: join(root, 'tests'),
  outputDir: join(root, 'evidence/results'),
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  globalTimeout: 180_000,
  expect: {timeout: 10_000},
  reporter: [
    ['list'],
    ['json', {outputFile: join(root, 'evidence/results.json')}],
    ['html', {outputFolder: join(root, 'evidence/html'), open: 'never'}],
  ],
  use: {
    browserName: 'chromium',
    channel: 'chromium',
    headless: true,
    viewport: {width: 1200, height: 600},
    deviceScaleFactor: 1,
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      timeout: 30_000,
      args: mode === 'software' ? ['--use-gl=angle', '--use-angle=swiftshader'] : [],
    },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    cwd: root,
    url: 'http://127.0.0.1:4173/__health',
    timeout: 15_000,
    reuseExistingServer: false,
  },
  projects: [
    {name: 'webgl', testMatch: 'preflight.spec.mjs'},
    {name: 'contacts', testMatch: 'contacts.spec.mjs', dependencies: ['webgl']},
  ],
});
