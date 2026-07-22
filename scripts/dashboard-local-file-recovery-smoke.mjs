import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome or Edge is required for the local-file recovery smoke test.');

const fixtureState = {
  queue: [{
    entryId: 'expired-queue-entry',
    song: {
      type: 'local',
      src: '',
      title: 'Queue file needs selection',
      artist: '',
      tags: [],
      source: 'local',
      mediaType: 'audio',
      localBlobBytes: 1024,
      localSourceExpired: true,
    },
    phase: 'queued',
    completionReason: null,
    createdAt: 1_700_000_000_001,
  }],
  history: [{
    entryId: 'expired-history-entry',
    song: {
      type: 'local',
      src: '',
      title: 'History file needs selection',
      artist: '',
      tags: [],
      source: 'local',
      mediaType: 'audio',
      localBlobBytes: 2048,
      localSourceExpired: true,
    },
    phase: 'completed',
    completionReason: null,
    createdAt: 1_700_000_000_002,
  }],
  currentEntry: null,
  active: null,
  volume: 100,
  isMuted: false,
  activeIntegrationTab: 'youtube',
  autoPlayNext: false,
};

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
};

const waitForServer = async (url, child, logs) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The isolated Vite server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Dashboard did not become reachable at ${url}. ${logs.join('').slice(-2_000)}`);
};

const stopChild = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

const port = await reservePort();
const appUrl = `http://127.0.0.1:${port}/`;
const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const viteLogs = [];
// Development mode intentionally does not load .env.production. This proves
// the page-owned Speaker Blob path without creating Worker sessions or uploads.
const vite = spawn(process.execPath, [
  vitePath,
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
  '--mode', 'development',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    BROWSER: 'none',
    VITE_ON_AIR_BASE_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
vite.stdout.on('data', (chunk) => viteLogs.push(String(chunk)));
vite.stderr.on('data', (chunk) => viteLogs.push(String(chunk)));

let browser;
try {
  await waitForServer(appUrl, vite, viteLogs);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addInitScript((serializedState) => {
    window.__rekasongBlobLifecycle = { created: [], revoked: [] };
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (...args) => {
      const src = createObjectURL(...args);
      window.__rekasongBlobLifecycle.created.push(src);
      return src;
    };
    URL.revokeObjectURL = (src) => {
      window.__rekasongBlobLifecycle.revoked.push(src);
      return revokeObjectURL(src);
    };
    try {
      localStorage.setItem('karaoke_app_state', serializedState);
    } catch {
      // about:blank has no storage origin; this runs again for the app document.
    }
  }, JSON.stringify(fixtureState));
  const page = await context.newPage();
  const pageErrors = [];
  const workerRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (/workers\.dev|\/v1\/sessions(?:\/|\?|$)/i.test(url)) workerRequests.push(url);
  });

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.queue-panel').waitFor({ state: 'visible', timeout: 20_000 });

  const queueRestore = page.locator('[data-local-file-restore="queue"][data-entry-id="expired-queue-entry"]');
  await queueRestore.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.queue-row.is-source-expired').count(), 1);

  const [invalidChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    queueRestore.click(),
  ]);
  await invalidChooser.setFiles({
    name: 'not-media.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not media'),
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-entry-id="expired-queue-entry"]')?.disabled === false
  ));
  assert.equal(await queueRestore.isVisible(), true, 'An invalid file must leave the recovery action open.');
  assert.equal(await page.locator('.queue-row.is-source-expired').count(), 1);

  const [queueChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    queueRestore.click(),
  ]);
  await queueChooser.setFiles({
    name: 'queue-restored.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFF0000WAVEfmt data'),
  });
  await queueRestore.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.queue-row.is-source-expired').count(), 0);
  assert.equal(await page.locator('.queue-row').count(), 1);
  assert.equal(await page.locator('.queue-row .queue-play-action').isEnabled(), true);

  await page.locator('.history-accordion summary').click();
  const historyRestore = page.locator('[data-local-file-restore="history"][data-entry-id="expired-history-entry"]');
  await historyRestore.waitFor({ state: 'visible' });
  const [historyChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    historyRestore.click(),
  ]);
  await historyChooser.setFiles({
    name: 'history-restored.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFF0000WAVEfmt data'),
  });
  await page.waitForFunction(() => document.querySelectorAll('.queue-row').length === 2);
  assert.equal(await historyRestore.isVisible(), true, 'History remains a record after adding a restored copy.');

  const persisted = await page.evaluate(() => localStorage.getItem('karaoke_app_state'));
  assert.ok(persisted, 'The recovered queue must still persist metadata.');
  assert.equal(persisted.includes('blob:'), false, 'Page-owned Blob URLs must never enter localStorage.');
  assert.equal(JSON.parse(persisted).queue.every((entry) => entry.song.localSourceExpired === true), true);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.waitForTimeout(100);
  const mobile = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[data-local-file-restore]')];
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttons: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    };
  });
  assert.ok(mobile.documentWidth <= mobile.viewportWidth + 1,
    `Local-file recovery overflows at 320px (${mobile.documentWidth}px).`);
  assert.equal(mobile.buttons.every(({ left, right }) => left >= -1 && right <= mobile.viewportWidth + 1), true);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(workerRequests, [], 'Local Speaker recovery must generate zero Worker traffic.');

  await page.evaluate(() => { window.location.hash = '#/widget'; });
  await page.locator('.dashboard-container').waitFor({ state: 'detached' });
  const blobLifecycle = await page.evaluate(() => window.__rekasongBlobLifecycle);
  assert.equal(blobLifecycle.created.length, 2, 'The two successful restores must own exactly two Blob URLs.');
  assert.equal(
    blobLifecycle.created.every((src) => blobLifecycle.revoked.includes(src)),
    true,
    'Dashboard unmount must revoke every page-owned Blob URL.',
  );

  process.stdout.write(`${JSON.stringify({
    appUrl,
    checks: {
      invalidFile: 'rejected without losing the placeholder',
      queueRestore: 'expired metadata -> playable local Blob',
      historyRestore: 'expired record -> new playable queued copy',
      persistedBlobUrls: 0,
      unmountRevokedBlobUrls: blobLifecycle.revoked.length,
      workerRequests: workerRequests.length,
      mobileWidth: mobile.viewportWidth,
      mobileDocumentWidth: mobile.documentWidth,
    },
  }, null, 2)}\n`);
  await context.close();
} finally {
  await browser?.close();
  await stopChild(vite);
}
