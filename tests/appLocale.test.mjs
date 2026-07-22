import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  APP_LOCALES,
  APP_LOCALE_STORAGE_KEY,
  normalizeAppLocale,
} from '../src/hooks/useAppLocale.js';
import {
  getWidgetMessage,
  normalizeWidgetLocale,
  widgetMessageCatalog,
} from '../src/copy/widgetMessages.js';
import { appMessageCatalog } from '../src/copy/appMessages.js';

test('app locale supports persisted Korean and English without accepting arbitrary DOM languages', () => {
  assert.deepEqual(APP_LOCALES, ['ko', 'en']);
  assert.equal(APP_LOCALE_STORAGE_KEY, 'rekasong.locale');
  assert.equal(normalizeAppLocale('ko-KR'), 'ko');
  assert.equal(normalizeAppLocale('EN-us'), 'en');
  assert.equal(normalizeAppLocale('ja-JP'), 'ko');
  assert.equal(normalizeAppLocale(null), 'ko');
});

test('display widget copy stays lightweight and keeps Korean-English key parity', () => {
  assert.equal(normalizeWidgetLocale('en-US'), 'en');
  assert.equal(normalizeWidgetLocale('ko-KR'), 'ko');
  assert.equal(getWidgetMessage('widget.playback.paused', 'en'), 'Paused');
  assert.deepEqual(
    Object.keys(widgetMessageCatalog.en).sort(),
    Object.keys(widgetMessageCatalog.ko).sort(),
  );
});

test('song drag actions keep Korean-English key parity', () => {
  const dragKeys = (catalog) => Object.keys(catalog)
    .filter((key) => key.startsWith('songDrag.') || key.startsWith('dashboard.drag.'))
    .sort();
  assert.deepEqual(
    dragKeys(appMessageCatalog.en),
    dragKeys(appMessageCatalog.ko),
  );
});

test('AI progress and display URLs carry semantic locale state instead of Korean prose checks', async () => {
  const [aiHook, stagingPanel, playbackPanel, sessionHook] = await Promise.all([
    readFile(new URL('../src/hooks/useAiTitleExtraction.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/StagingPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useOnAirSession.js', import.meta.url), 'utf8'),
  ]);

  assert.match(aiHook, /ai\.status\.preparing/);
  assert.doesNotMatch(aiHook, /setAiStatusMessage|AI 분석을 준비|저장된 곡명 적용/);
  assert.match(stagingPanel, /analysisPhase = isAiLoading \? aiStatusPhase : 0/);
  assert.doesNotMatch(stagingPanel, /한국어\|번역\|매칭/);
  assert.match(playbackPanel, /&lang=\$\{encodeURIComponent\(locale\)\}/);
  assert.match(playbackPanel, /withHashParam\(url, 'lang', locale\)/);
  assert.doesNotMatch(sessionHook, /new Error\('[^']*[가-힣][^']*'\)/);
});
