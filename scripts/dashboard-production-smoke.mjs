import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const targetUrl = process.argv[2] || 'https://11qaws.github.io/rekasong/';
const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));

assert.ok(executablePath, 'Chrome or Edge is required for the Dashboard production smoke test.');

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

const context = await browser.newContext({
  viewport: { width: 1100, height: 900 },
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const consoleErrors = [];
const pageErrors = [];

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.addInitScript(() => {
  window.__rekasongLongTasks = [];
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__rekasongLongTasks.push({
          duration: entry.duration,
          startTime: entry.startTime,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // Older embedded Chromium builds may not expose the Long Tasks API.
  }
});

try {
  const response = await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  assert.ok(response?.ok(), `Dashboard returned HTTP ${response?.status() ?? 'no response'}.`);

  await page.locator('h1.logo').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.dashboard-output-route-bar-inner').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.source-tabs').waitFor({ state: 'visible', timeout: 20_000 });

  assert.equal((await page.locator('h1.logo').innerText()).trim(), 'Rekasong');
  assert.equal(await page.locator('.dashboard-header .subtitle').count(), 0, 'The removed subtitle returned.');
  assert.equal(await page.locator('.source-tab').count(), 3, 'YouTube must remain one top-level source.');
  assert.deepEqual(
    await page.locator('.source-tab-label').allInnerTexts(),
    ['YouTube', 'Setlink', '멜로밍'],
  );
  assert.equal(await page.locator('.source-tab[data-source="youtube"]').count(), 1);
  assert.equal(await page.locator('.youtube-mode-switch button').count(), 2);
  assert.deepEqual(
    await page.locator('.youtube-mode-switch button').allInnerTexts(),
    ['검색', '플레이리스트'],
  );

  await page.waitForFunction(() => {
    const status = document.querySelector('#output-route-live-status');
    return status?.classList.contains('is-speaker') && status.textContent?.includes('스피커 송출 중');
  }, null, { timeout: 20_000 });

  await page.waitForTimeout(1_000);
  const readRuntime = () => page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const sum = (field) => resources.reduce((total, entry) => total + (Number(entry[field]) || 0), 0);
    return {
      domNodes: document.querySelectorAll('*').length,
      navigation: navigation ? {
        domContentLoadedMs: navigation.domContentLoadedEventEnd,
        loadMs: navigation.loadEventEnd,
        transferBytes: navigation.transferSize,
        decodedBytes: navigation.decodedBodySize,
      } : null,
      resources: {
        count: resources.length,
        transferBytes: sum('transferSize'),
        encodedBytes: sum('encodedBodySize'),
        decodedBytes: sum('decodedBodySize'),
        scriptCount: resources.filter((entry) => entry.initiatorType === 'script').length,
        cssCount: resources.filter((entry) => entry.initiatorType === 'css' || entry.name.endsWith('.css')).length,
      },
      longTasks: window.__rekasongLongTasks || [],
    };
  });
  const coldRuntime = await readRuntime();

  const responsiveLayouts = [];
  for (const width of [320, 375, 768, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const layout = await page.evaluate(() => {
      const bar = document.querySelector('.dashboard-output-route-bar');
      const hairpin = document.querySelector('.dashboard-output-route-bar-inner');
      const lineElement = document.querySelector('.dashboard-brand-hairline');
      const line = getComputedStyle(lineElement);
      const hairpinRect = hairpin.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const lineRect = lineElement.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bar: { left: barRect.left, right: barRect.right, width: barRect.width },
        hairpin: { left: hairpinRect.left, right: hairpinRect.right, width: hairpinRect.width },
        line: {
          left: lineRect.left,
          right: lineRect.right,
          top: lineRect.top,
          width: lineRect.width,
          display: line.display,
          height: line.height,
          color: line.backgroundColor,
          zIndex: line.zIndex,
        },
      };
    });

    assert.ok(
      layout.documentWidth <= width + 1,
      `${width}px layout overflows horizontally (${layout.documentWidth}px).`,
    );
    assert.ok(layout.hairpin.left >= -1 && layout.hairpin.right <= width + 1,
      `${width}px hairpin controls leave the viewport.`);
    assert.equal(layout.line.display, 'block');
    assert.equal(layout.line.height, '3px');
    assert.equal(layout.line.zIndex, '1');
    assert.ok(layout.line.width >= layout.bar.width - 1, 'The Eureka blonde line no longer spans the header.');
    assert.notEqual(layout.line.color, 'rgba(0, 0, 0, 0)', 'The Eureka blonde line is transparent.');
    responsiveLayouts.push(layout);
  }

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator('.output-settings-button').click();
  await page.locator('#obs-setup-dialog').waitFor({ state: 'visible' });

  const localeSelect = page.locator('.app-language-setting select');
  assert.equal(await localeSelect.inputValue(), 'ko');
  const routeButtons = page.locator('.output-route-button');
  assert.equal(await routeButtons.count(), 2);
  assert.equal(await routeButtons.nth(0).getAttribute('aria-checked'), 'true');
  assert.equal(await routeButtons.nth(0).isDisabled(), false, 'Speaker selection is unexpectedly locked.');
  assert.equal(await routeButtons.nth(1).isDisabled(), false, 'OBS selection is unexpectedly locked.');
  await localeSelect.selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.deepEqual(
    await page.locator('.source-tab-label').allInnerTexts(),
    ['YouTube', 'Setlink', 'Meloming'],
  );
  assert.deepEqual(
    await page.locator('.youtube-mode-switch button').allInnerTexts(),
    ['Search', 'Playlist'],
  );
  assert.match(await page.locator('#output-route-live-status').innerText(), /speaker/i);

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.dashboard-output-route-bar-inner').waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.match(await page.locator('#output-route-live-status').innerText(), /speaker/i);

  await page.waitForTimeout(1_000);
  const warmRuntime = await readRuntime();
  const englishResponsiveLayouts = [];
  for (const width of [320, 375, 768, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const layout = await page.evaluate(() => {
      const hairpinRect = document.querySelector('.dashboard-output-route-bar-inner').getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        hairpin: { left: hairpinRect.left, right: hairpinRect.right, width: hairpinRect.width },
      };
    });
    assert.ok(layout.documentWidth <= width + 1,
      `${width}px English layout overflows horizontally (${layout.documentWidth}px).`);
    assert.ok(layout.hairpin.left >= -1 && layout.hairpin.right <= width + 1,
      `${width}px English hairpin controls leave the viewport.`);
    englishResponsiveLayouts.push(layout);
  }

  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('.output-settings-button').click();
  await page.locator('#obs-setup-dialog').waitFor({ state: 'visible' });
  const mobileDialog = await page.locator('#obs-setup-dialog').evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  assert.ok(mobileDialog.left >= -1 && mobileDialog.right <= mobileDialog.viewportWidth + 1,
    'The 320px English settings dialog leaves the viewport.');
  assert.ok(mobileDialog.documentWidth <= mobileDialog.viewportWidth + 1,
    'The 320px English settings dialog causes horizontal overflow.');

  const { metrics } = await cdp.send('Performance.getMetrics');
  const cdpMetrics = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));

  // These are deliberately roomy regression ceilings, not network-speed gates.
  assert.ok(coldRuntime.domNodes < 2_000, `Initial Dashboard DOM is too large (${coldRuntime.domNodes} nodes).`);
  assert.ok(coldRuntime.resources.decodedBytes < 6 * 1024 * 1024,
    `Initial decoded resources exceed 6 MiB (${coldRuntime.resources.decodedBytes} bytes).`);
  assert.ok(warmRuntime.resources.decodedBytes < 6 * 1024 * 1024,
    `Warm decoded resources exceed 6 MiB (${warmRuntime.resources.decodedBytes} bytes).`);
  assert.ok((cdpMetrics.JSHeapUsedSize || 0) < 64 * 1024 * 1024,
    `Initial JS heap exceeds 64 MiB (${cdpMetrics.JSHeapUsedSize} bytes).`);
  assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join(' | ')}`);

  const benignConsoleError = /favicon|ERR_BLOCKED_BY_CLIENT/i;
  const actionableConsoleErrors = consoleErrors.filter((message) => !benignConsoleError.test(message));
  assert.equal(actionableConsoleErrors.length, 0,
    `Console errors: ${actionableConsoleErrors.join(' | ')}`);

  process.stdout.write(`${JSON.stringify({
    targetUrl,
    executablePath,
    checks: {
      defaultOutput: 'speaker',
      topLevelSources: ['YouTube', 'Setlink', 'Meloming'],
      youtubeModes: ['Search', 'Playlist'],
      localePersistence: 'ko -> en -> reload',
      responsiveWidths: responsiveLayouts.map(({ viewportWidth }) => viewportWidth),
      englishResponsiveWidths: englishResponsiveLayouts.map(({ viewportWidth }) => viewportWidth),
      mobileSettingsDialog: 'fits at 320px in English',
      outputButtons: 'Speaker and OBS available after Speaker readiness',
      blondeLine: 'visible at every tested width',
    },
    runtime: {
      cold: coldRuntime,
      warm: warmRuntime,
      jsHeapUsedBytes: cdpMetrics.JSHeapUsedSize,
      jsHeapTotalBytes: cdpMetrics.JSHeapTotalSize,
      cdpNodeCount: cdpMetrics.Nodes,
      taskDurationSeconds: cdpMetrics.TaskDuration,
    },
  }, null, 2)}\n`);
} finally {
  await context.close();
  await browser.close();
}
