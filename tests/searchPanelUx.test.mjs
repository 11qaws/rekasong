import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { transformWithOxc } from 'vite';
import { outputMessageCatalog } from '../src/copy/outputMessages.js';

test('source tabs use one YouTube spelling and the beginner-first order', async () => {
  const file = fileURLToPath(new URL('../src/components/SearchPanel.jsx', import.meta.url));
  const source = await readFile(file, 'utf8');
  await transformWithOxc(source, file, { lang: 'jsx' });

  const orderedSources = ['youtube', 'youtube-playlist', 'setlink', 'meloming'];
  let cursor = -1;
  for (const sourceName of orderedSources) {
    const next = source.indexOf(`data-source="${sourceName}"`, cursor + 1);
    assert.ok(next > cursor, `${sourceName} tab must follow the requested order`);
    cursor = next;
  }
  assert.equal(outputMessageCatalog.ko['search.tab.youtubeSearch'], 'YouTube 검색');
  assert.equal(outputMessageCatalog.ko['search.tab.youtubeList'], 'YouTube 목록');
  assert.doesNotMatch(source, />유튜브 검색</);

  const semanticKeys = [...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]);
  for (const key of semanticKeys) {
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean search copy for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English search copy for ${key}`);
  }
});

test('song and songbook copy areas are real keyboard buttons, not hidden click zones', async () => {
  const file = fileURLToPath(new URL('../src/components/SearchPanel.jsx', import.meta.url));
  const source = await readFile(file, 'utf8');
  await transformWithOxc(source, file, { lang: 'jsx' });

  assert.match(source, /<button[\s\S]*?className="result-select-button"[\s\S]*?selectYoutubeResult\(v\)/);
  assert.match(source, /<button[\s\S]*?className="songbook-copy"[\s\S]*?selectSongbookSong\(song, platform, youtubeId, cachedMr\)/);
  assert.match(source, /search\.songbook\.selectHint/);
});

test('songbook text uses a readable dark green while emerald remains available for decoration', async () => {
  const css = await readFile(new URL('../src/pages/Dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.songbook-summary\[data-source='meloming'\] \{ color: var\(--chr-vest\); \}/);
  assert.match(css, /\.songbook-mr-state\.is-linked \{ color: var\(--chr-vest\);/);
  assert.match(css, /\.songbook-copy:focus-visible/);
});

test('dashboard header keeps the compact hairpin and removes the old subtitle', async () => {
  const dashboard = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(dashboard, /className="subtitle"/);
  assert.match(dashboard, /id="dashboard-output-route-bar"/);
});
