import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { pseudoLocalizeText } from './pseudo-locale-fixture.mjs';

const RESPONSIVE_WIDTHS = Object.freeze([320, 375, 768, 1100]);
const APP_LOCALE_STORAGE_KEY = 'rekasong.locale';
const TRANSLATABLE_ATTRIBUTES = Object.freeze([
  'aria-label',
  'aria-description',
  'title',
  'placeholder',
  'alt',
]);

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome, Edge, or Chromium is required for the pseudo-locale smoke test.');

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise, reject) => server.close((error) => (
    error ? reject(error) : resolvePromise()
  )));
  return port;
};

const waitForServer = async (url, child, logs) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) break;
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The isolated Vite preview is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Dashboard did not become reachable at ${url}. ${logs.join('').slice(-2_000)}`);
};

const stopChild = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

const collectLocalizableStrings = (page) => page.evaluate((attributes) => {
  const values = new Set();
  const skippedParents = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim() || skippedParents.has(node.parentElement?.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) values.add(walker.currentNode.nodeValue);

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value?.trim()) values.add(value);
    }
  }
  return [...values];
}, TRANSLATABLE_ATTRIBUTES);

const applyPseudoLocale = async (page) => {
  const sourceStrings = await collectLocalizableStrings(page);
  const replacementEntries = sourceStrings
    .map((source) => [source, pseudoLocalizeText(source)])
    .filter(([source, translated]) => source !== translated);

  const result = await page.evaluate(({ attributes, entries }) => {
    const replacements = new Map(entries);
    const skippedParents = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    let textNodes = 0;
    let attributeValues = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim() || skippedParents.has(node.parentElement?.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      const translated = replacements.get(walker.currentNode.nodeValue);
      if (!translated) continue;
      walker.currentNode.nodeValue = translated;
      textNodes += 1;
    }

    for (const element of document.querySelectorAll('*')) {
      for (const attribute of attributes) {
        const source = element.getAttribute(attribute);
        const translated = replacements.get(source);
        if (!translated) continue;
        element.setAttribute(attribute, translated);
        attributeValues += 1;
      }
    }
    document.documentElement.dataset.pseudoLocale = 'qps-ploc';
    return { textNodes, attributeValues };
  }, { attributes: TRANSLATABLE_ATTRIBUTES, entries: replacementEntries });

  assert.ok(result.textNodes > 0, 'Pseudo-locale did not transform any visible text.');
  assert.ok(result.attributeValues > 0, 'Pseudo-locale did not transform any accessible labels.');
  return { ...result, uniqueStrings: replacementEntries.length };
};

const auditLayout = (page, rootSelector) => page.evaluate((selector) => {
  const root = document.querySelector(selector);
  if (!root) throw new Error(`Missing layout root: ${selector}`);
  const viewportWidth = window.innerWidth;
  const rootRect = root.getBoundingClientRect();
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  };
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    className: typeof element.className === 'string' ? element.className : null,
    text: element.textContent?.trim().slice(0, 80) || null,
  });

  const controls = document.querySelectorAll(
    'button, input, select, textarea, a[href], summary, [role="button"], [role="radio"], [tabindex="0"]',
  );
  const controlsOutsideViewport = [];
  const clippedControls = [];
  for (const control of controls) {
    if (!isVisible(control)) continue;
    const rect = control.getBoundingClientRect();
    if (rect.left < -1 || rect.right > viewportWidth + 1) {
      controlsOutsideViewport.push(describe(control));
    }
    const style = getComputedStyle(control);
    if (['hidden', 'clip'].includes(style.overflowX)
      && control.scrollWidth > control.clientWidth + 1) {
      clippedControls.push(describe(control));
    }
  }

  const clippedTextElements = [];
  const textOutsideViewport = [];
  for (const element of document.body.querySelectorAll('*')) {
    if (!isVisible(element) || !element.textContent?.trim()) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const hasDirectText = [...element.childNodes].some((node) => (
      node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim()
    ));
    if (hasDirectText && (rect.left < -1 || rect.right > viewportWidth + 1)) {
      textOutsideViewport.push(describe(element));
    }
    if (['hidden', 'clip'].includes(style.overflowX)
      && element.scrollWidth > element.clientWidth + 1) {
      clippedTextElements.push(describe(element));
    }
  }

  return {
    viewportWidth,
    documentWidth: document.documentElement.scrollWidth,
    root: {
      left: rootRect.left,
      right: rootRect.right,
      width: rootRect.width,
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    },
    controlsOutsideViewport,
    clippedControls,
    clippedTextElements,
    textOutsideViewport,
  };
}, rootSelector);

const assertLayout = (scenarioName, layout, rootOverflowAllowancePx = 1) => {
  const prefix = `${scenarioName} at ${layout.viewportWidth}px`;
  assert.ok(
    layout.documentWidth <= layout.viewportWidth + 1,
    `${prefix} overflows the document horizontally (${layout.documentWidth}px).`,
  );
  assert.ok(
    layout.root.left >= -1 && layout.root.right <= layout.viewportWidth + 1,
    `${prefix} moves its primary surface outside the viewport.`,
  );
  assert.ok(
    layout.root.scrollWidth <= layout.root.clientWidth + rootOverflowAllowancePx,
    `${prefix} hides horizontal content inside its primary surface: ${JSON.stringify(layout)}.`,
  );
  assert.deepEqual(
    layout.controlsOutsideViewport,
    [],
    `${prefix} leaves interactive controls outside the viewport.`,
  );
  assert.deepEqual(layout.clippedControls, [], `${prefix} clips interactive control text.`);
  assert.deepEqual(layout.clippedTextElements, [], `${prefix} clips translated text.`);
  assert.deepEqual(layout.textOutsideViewport, [], `${prefix} moves translated text outside the viewport.`);
};

const requestedUrl = process.argv[2] ? new URL(process.argv[2]).href : null;
const port = requestedUrl ? null : await reservePort();
const appUrl = requestedUrl || `http://127.0.0.1:${port}/`;
const viteLogs = [];
let vite;

if (!requestedUrl) {
  assert.ok(existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url))),
    'Build the app before running the pseudo-locale smoke test.');
  const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  vite = spawn(process.execPath, [
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
  vite.stdout.on('data', (chunk) => viteLogs.push(String(chunk)));
  vite.stderr.on('data', (chunk) => viteLogs.push(String(chunk)));
}

const screenshotDirectory = process.env.REKASONG_PSEUDO_SCREENSHOT_DIR
  ? resolve(process.env.REKASONG_PSEUDO_SCREENSHOT_DIR)
  : null;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

let browser;
try {
  await waitForServer(appUrl, vite, viteLogs);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });

  const runScenario = async ({
    name,
    rootSelector,
    rootOverflowAllowancePx = 1,
    allowBlockedSessionRequest = false,
    setup,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const blockedSessionRequests = [];
    const blockedWebSockets = [];
    await context.addInitScript((storageKey) => {
      try {
        localStorage.setItem(storageKey, 'en');
      } catch {
        // The app still defaults safely if storage is unavailable.
      }
    }, APP_LOCALE_STORAGE_KEY);
    await context.route('**/v1/sessions**', async (route) => {
      const requestUrl = new URL(route.request().url());
      blockedSessionRequests.push({
        method: route.request().method(),
        path: requestUrl.pathname.replace(/(\/v1\/sessions\/)[^/]+/u, '$1:session'),
      });
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'content-type': 'application/json',
      };
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers, body: '' });
        return;
      }
      await route.fulfill({
        status: 503,
        headers,
        body: JSON.stringify({ error: 'pseudo_locale_smoke_session_blocked' }),
      });
    });
    await context.routeWebSocket(/.*/, async (socketRoute) => {
      blockedWebSockets.push(socketRoute.url());
      await socketRoute.close({ code: 1000, reason: 'pseudo locale smoke blocks sockets' });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      const response = await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      assert.ok(response?.ok(), `${name} returned HTTP ${response?.status() ?? 'no response'}.`);
      await page.locator('h1.logo').waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('.dashboard-output-route-bar-inner').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');

      await setup?.(page, blockedSessionRequests);
      await page.waitForTimeout(300);
      const untranslatedKeys = (await collectLocalizableStrings(page)).filter((value) => (
        /^(?:[a-z][a-z0-9]*\.){2,}[a-z0-9]/i.test(value.trim())
      ));
      assert.deepEqual(untranslatedKeys, [], `${name} exposes semantic message keys.`);
      const transformed = await applyPseudoLocale(page);

      const layouts = [];
      for (const width of RESPONSIVE_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(100);
        const layout = await auditLayout(page, rootSelector);
        assertLayout(name, layout, rootOverflowAllowancePx);
        layouts.push(layout);
      }

      const mediaSafety = await page.evaluate(() => {
        const media = [...document.querySelectorAll('audio, video')];
        return {
          count: media.length,
          playing: media.filter((element) => !element.paused && !element.ended).length,
          withSource: media.filter((element) => Boolean(element.currentSrc || element.getAttribute('src'))).length,
        };
      });
      assert.equal(mediaSafety.playing, 0, `${name} unexpectedly started media playback.`);
      assert.equal(mediaSafety.withSource, 0, `${name} unexpectedly attached a media source.`);
      assert.deepEqual(pageErrors, [], `${name} raised page errors.`);
      assert.deepEqual(blockedWebSockets, [], `${name} attempted to open a WebSocket.`);
      if (!allowBlockedSessionRequest) {
        assert.deepEqual(blockedSessionRequests, [], `${name} attempted to create a remote session.`);
      }

      if (screenshotDirectory) {
        await page.setViewportSize({ width: 320, height: 900 });
        await page.screenshot({
          path: resolve(screenshotDirectory, `${name}-320-top.png`),
          fullPage: true,
        });
        const dialog = page.locator('#obs-setup-dialog');
        if (await dialog.count()) {
          await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
          await page.screenshot({
            path: resolve(screenshotDirectory, `${name}-320-bottom.png`),
            fullPage: true,
          });
        }
      }

      return {
        name,
        transformed,
        widths: layouts.map(({ viewportWidth }) => viewportWidth),
        maximumDocumentOverflowPx: Math.max(
          ...layouts.map(({ documentWidth, viewportWidth }) => Math.max(0, documentWidth - viewportWidth)),
        ),
        blockedSessionRequestCount: blockedSessionRequests.length,
        blockedWebSocketCount: blockedWebSockets.length,
        mediaSafety,
      };
    } finally {
      await context.close();
    }
  };

  const results = [];
  results.push(await runScenario({
    name: 'main-dashboard',
    rootSelector: '.dashboard-output-route-bar-inner',
    // The white hairpin prong is an intentional 13px ::after extension.
    rootOverflowAllowancePx: 16,
    setup: async (page) => {
      await page.locator('.source-tabs').waitFor({ state: 'visible' });
    },
  }));
  results.push(await runScenario({
    name: 'speaker-settings',
    rootSelector: '#obs-setup-dialog',
    setup: async (page) => {
      await page.locator('.output-settings-button').click();
      await page.locator('#obs-setup-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.output-route-button').nth(0).getAttribute('aria-checked'), 'true');
    },
  }));
  results.push(await runScenario({
    name: 'obs-settings',
    rootSelector: '#obs-setup-dialog',
    allowBlockedSessionRequest: true,
    setup: async (page, blockedSessionRequests) => {
      await page.locator('.output-settings-button').click();
      await page.locator('#obs-setup-dialog').waitFor({ state: 'visible' });
      await page.locator('.output-route-button').nth(1).click();
      await page.locator('.obs-performer-monitor').waitFor({ state: 'visible' });
      await page.locator('.obs-performer-monitor summary').click();
      await page.locator('.obs-performer-monitor-body').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('.obs-source-settings').length === 1);
      await page.waitForTimeout(300);
      assert.ok(blockedSessionRequests.length > 0,
        'OBS settings did not exercise the isolated session-request block.');
    },
  }));

  process.stdout.write(`${JSON.stringify({
    appUrl,
    executablePath,
    locale: 'qps-ploc derived from reviewed English copy',
    runtimeBundleImpact: 'none; scripts and tests only',
    safety: 'session HTTP and all WebSockets blocked; no media source or playback',
    results,
  }, null, 2)}\n`);
} finally {
  await browser?.close();
  await stopChild(vite);
}
