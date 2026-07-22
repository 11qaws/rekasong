import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { transformWithOxc } from 'vite';
import { appMessageCatalog } from '../src/copy/appMessages.js';
import { outputMessageCatalog } from '../src/copy/outputMessages.js';

const mergedCatalog = Object.freeze({
  ko: Object.freeze({ ...outputMessageCatalog.ko, ...appMessageCatalog.ko }),
  en: Object.freeze({ ...outputMessageCatalog.en, ...appMessageCatalog.en }),
});

test('YouTube search and playlists share one top-level source before Setlink and Meloming', async () => {
  const file = fileURLToPath(new URL('../src/components/SearchPanel.jsx', import.meta.url));
  const source = await readFile(file, 'utf8');
  await transformWithOxc(source, file, { lang: 'jsx' });

  const orderedSources = ['youtube', 'setlink', 'meloming'];
  let cursor = -1;
  for (const sourceName of orderedSources) {
    const next = source.indexOf(`data-source="${sourceName}"`, cursor + 1);
    assert.ok(next > cursor, `${sourceName} tab must follow the requested order`);
    cursor = next;
  }
  assert.equal(appMessageCatalog.ko['search.tab.youtube'], 'YouTube');
  assert.match(source, /data-source-tab-count="3"/);
  assert.equal((source.match(/data-source="youtube"/g) || []).length, 1);
  assert.doesNotMatch(source, /data-source="youtube-playlist"/);
  assert.match(source, /role="tablist"[\s\S]*?search\.youtube\.mode\.search[\s\S]*?search\.youtube\.mode\.playlist/);
  assert.match(source, /lastYoutubeTabRef/);
  assert.doesNotMatch(source, />유튜브 검색</);
  assert.match(source, /platform === 'youtube-playlist'[\s\S]*?search\.import\.source\.youtubePlaylist/);
  assert.match(source, /storedSetlinkName === 'Setlink 공개 목록'/);

  const semanticKeys = [...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]);
  for (const key of semanticKeys) {
    assert.ok(mergedCatalog.ko[key]?.trim(), `missing Korean search copy for ${key}`);
    assert.ok(mergedCatalog.en[key]?.trim(), `missing English search copy for ${key}`);
  }
});

test('song and songbook rows expose a visible review interaction with immediate busy feedback', async () => {
  const file = fileURLToPath(new URL('../src/components/SearchPanel.jsx', import.meta.url));
  const source = await readFile(file, 'utf8');
  await transformWithOxc(source, file, { lang: 'jsx' });

  assert.match(source, /<button[\s\S]*?className="result-select-button"[\s\S]*?selectYoutubeResult\(v\)/);
  assert.match(source, /<button[\s\S]*?className="songbook-copy"[\s\S]*?selectSongbookSong\(song, platform, youtubeId, cachedMr\)/);
  assert.match(source, /search\.songbook\.selectHint/);
  assert.match(source, /openingSongbookKey/);
  assert.match(source, /aria-busy=\{isOpening \|\| undefined\}/);
  assert.match(source, /search\.songbook\.opening/);
});

test('search, review, and language surfaces use Korean-English semantic keys', async () => {
  const files = await Promise.all([
    readFile(new URL('../src/components/SearchPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/StagingPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/SongComposer.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/QueuePanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
  ]);
  const semanticKeys = files.flatMap((source) => (
    [...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1])
  ));
  for (const key of semanticKeys) {
    assert.ok(mergedCatalog.ko[key]?.trim(), `missing Korean app copy for ${key}`);
    assert.ok(mergedCatalog.en[key]?.trim(), `missing English app copy for ${key}`);
  }
  for (const prefix of ['search.', 'composer.', 'staging.', 'settings.language.']) {
    const koreanKeys = Object.keys(mergedCatalog.ko).filter((key) => key.startsWith(prefix)).sort();
    const englishKeys = Object.keys(mergedCatalog.en).filter((key) => key.startsWith(prefix)).sort();
    assert.deepEqual(englishKeys, koreanKeys, `${prefix} locale keys must stay in parity`);
  }
  assert.deepEqual(
    Object.keys(mergedCatalog.en).sort(),
    Object.keys(mergedCatalog.ko).sort(),
    'the complete app catalog must stay in Korean-English parity',
  );
  assert.match(files[3], /settings\.language\.title/);
  assert.match(files[3], /onLocaleChange\?\.\(event\.target\.value\)/);
});

test('songbook text uses a readable dark green while emerald remains available for decoration', async () => {
  const css = await readFile(new URL('../src/pages/Dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.songbook-summary\[data-source='meloming'\] \{ color: var\(--chr-vest\); \}/);
  assert.match(css, /\.songbook-mr-state\.is-linked \{ color: var\(--chr-vest\);/);
  assert.match(css, /\.songbook-copy:focus-visible/);
});

test('import APIs persist locale-neutral default source metadata', async () => {
  const [youtubeApi, setlinkApi] = await Promise.all([
    readFile(new URL('../functions/api/youtube-playlist.js', import.meta.url), 'utf8'),
    readFile(new URL('../functions/api/setlink.js', import.meta.url), 'utf8'),
  ]);

  assert.match(youtubeApi, /kind: 'youtube-playlist'/);
  assert.match(youtubeApi, /name: 'YouTube'/);
  assert.doesNotMatch(youtubeApi, /name: `YouTube 플레이리스트/);
  assert.match(setlinkApi, /defaultName: !sourceName/);
  assert.match(setlinkApi, /name: sourceName \|\| 'Setlink'/);
});

test('dashboard header permanently keeps the blonde line behind the compact hairpin', async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/Dashboard.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(dashboard, /className="subtitle"/);
  assert.match(dashboard, /id="dashboard-output-route-bar"/);
  assert.match(
    dashboard,
    /<span className="dashboard-brand-hairline" aria-hidden="true" \/>/,
    'the blonde line must be a permanent element, not portal content or a conditional pseudo-element',
  );
  const hairlineRules = [...css.matchAll(/\.dashboard-brand-hairline\s*\{([^}]*)\}/g)];
  assert.ok(hairlineRules.length >= 1, 'the blonde line must have a dedicated rule');
  const barRule = css.match(/\.dashboard-output-route-bar\s*\{([^}]*)\}/);
  assert.ok(barRule, 'the blonde line container must have a dedicated rule');
  assert.match(
    barRule[1],
    /isolation:\s*isolate/,
    'the line needs a local stacking context so later header rules cannot move it behind the header',
  );
  assert.match(hairlineRules[0][1], /background: var\(--chr-hair\);/);
  assert.match(hairlineRules[0][1], /z-index:\s*1/);
  assert.match(hairlineRules[0][1], /height:\s*3px/);
  for (const [, rule] of hairlineRules) {
    assert.doesNotMatch(rule, /display:\s*none|visibility:\s*hidden|opacity:\s*0(?:\D|$)/);
  }
});
