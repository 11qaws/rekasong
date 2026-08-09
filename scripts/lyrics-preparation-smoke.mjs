import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const executablePath = [
  process.env.REKASONG_CHROMIUM_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find(existsSync);
assert.ok(executablePath, 'Chrome or Edge is required for the lyrics preparation smoke test.');

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
      if ((await fetch(url)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Dashboard did not become reachable. ${logs.join('').slice(-2_000)}`);
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

const wavFixture = () => {
  const sampleRate = 48_000;
  const sampleCount = sampleRate;
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
};

const port = await reservePort();
const appUrl = `http://127.0.0.1:${port}/`;
const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const logs = [];
const preview = spawn(process.execPath, [
  vitePath,
  'preview',
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
preview.stdout.on('data', (chunk) => logs.push(String(chunk)));
preview.stderr.on('data', (chunk) => logs.push(String(chunk)));

let browser;
try {
  await waitForServer(appUrl, preview, logs);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('rekasong.locale', 'ko');
    localStorage.removeItem('rekasong-on-air-session-v1');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/v1/prepare/activity', (route) => route.fulfill({ status: 204 }));
  await page.route('**/v1/sessions/*/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'active' }),
  }));
  await page.route('**/v1/sessions/*/lyrics-assets', async (route) => {
    const body = await route.request().postDataJSON();
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.timingMode, 'tempo_map');
    assert.equal(body.cues.length, 3);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ assetId: 'lyrics-smoke-asset' }),
    });
  });
  await page.route('**/v1/sessions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      room: 'lyrics-smoke-room',
      controlToken: 'lyrics-smoke-control',
      playerToken: 'lyrics-smoke-player',
      workerOrigin: 'https://rekasong-session.11qaws.workers.dev',
    }),
  }));

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.song-composer input[type="file"][accept]').setInputFiles({
    name: 'Synthetic lyrics fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await page.locator('.staging-panel').waitFor({ state: 'visible' });
  await page.locator('.lyrics-staging-action').click();
  const workspace = page.locator('.lyrics-workspace');
  await workspace.waitFor({ state: 'visible' });
  assert.equal(await workspace.locator('header span').textContent(), '1 / 5 단계');
  assert.equal(await workspace.locator('.lyrics-step input').first().inputValue(), 'Synthetic');

  const next = workspace.locator('footer button.primary');
  await next.click();
  await workspace.locator('.lyrics-step textarea').fill('[00:05.00]Alpha line\n[00:10.00]Beta line');
  assert.match(await workspace.locator('.lyrics-step output').textContent(), /2행 · 시간 cue 2개 · 경고 0개/);
  await next.click();
  await workspace.locator('.lyrics-step textarea').fill('가 번역\n나 번역');
  await next.click();

  const timingFields = workspace.locator('.lyrics-timing-fields');
  const bpm = timingFields.locator('input[type="number"]').first();
  assert.equal(await bpm.inputValue(), '', 'BPM must not be guessed.');
  assert.match(await timingFields.locator('output').textContent(), /고정 ms 대체 모드/);
  assert.equal(await workspace.locator('.lyrics-cue-row').count(), 2);
  await workspace.getByRole('button', { name: 'blank cue 추가' }).click();
  assert.equal(await workspace.locator('.lyrics-cue-row').count(), 3);
  await workspace.getByRole('button', { name: '실행 취소' }).click();
  assert.equal(await workspace.locator('.lyrics-cue-row').count(), 2);
  await workspace.getByRole('button', { name: '다시 실행' }).click();
  assert.equal(await workspace.locator('.lyrics-cue-row').count(), 3);
  await bpm.fill('130');
  assert.match(await timingFields.locator('output').textContent(), /박자 맵/);
  await next.click();

  await workspace.locator('input[type="range"]').fill('5504');
  assert.match(await workspace.locator('.lyrics-overlay-preview').textContent(), /Alpha line/);
  assert.match(await workspace.locator('.lyrics-overlay-preview').textContent(), /가 번역/);
  await page.setViewportSize({ width: 320, height: 900 });
  const layout = await workspace.evaluate((element) => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
  }));
  assert.ok(layout.documentWidth <= layout.viewportWidth + 1);
  assert.ok(layout.left >= -1 && layout.right <= layout.viewportWidth + 1);

  await workspace.locator('footer button.primary').click();
  await workspace.waitFor({ state: 'detached' });
  await page.getByText('가사 준비 완료', { exact: true }).waitFor({ state: 'visible' });
  const packageCount = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('rekasong-lyrics', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const count = database.transaction('playbackPackages').objectStore('playbackPackages').count();
      count.onerror = () => reject(count.error);
      count.onsuccess = () => resolve(count.result);
    };
  }));
  assert.equal(packageCount, 1);
  assert.deepEqual(errors, []);

  console.log(JSON.stringify({
    appUrl,
    steps: 5,
    timing: 'blank fallback -> explicit 130 BPM tempo map',
    cueEditing: 'blank, undo, redo',
    preview: 'bilingual synthetic cue',
    responsiveWidth: 320,
    indexedDbPlaybackPackages: packageCount,
    publishedAsset: 'lyrics-smoke-asset',
    browserErrors: errors,
  }, null, 2));
  await context.close();
} finally {
  await browser?.close();
  await stopChild(preview);
}
