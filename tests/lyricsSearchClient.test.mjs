import test from 'node:test';
import assert from 'node:assert/strict';

import { searchHostedLyrics, songbookLyricsCatalogKey } from '../src/lib/lyrics/lyricsSearchClient.js';

const input = {
  videoId: 'abcdefghijk',
  title: 'Synthetic Song',
  artist: 'Example Artist',
  sourcePriority: 'namuwiki_only',
};

test('browser lyrics search uses only the hosted API', async () => {
  const requests = [];
  const result = await searchHostedLyrics({
    endpoint: 'https://rekasong.pages.dev/api/lyrics-search',
    input,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json({ status: 'review_required' });
    },
  });

  assert.equal(result.status, 'review_required');
  assert.deepEqual(requests, [{
    url: 'https://rekasong.pages.dev/api/lyrics-search',
    body: input,
  }]);
});

test('hosted lyrics search preserves bounded server diagnostics', async () => {
  await assert.rejects(searchHostedLyrics({
    endpoint: 'https://rekasong.pages.dev/api/lyrics-search',
    input,
    fetchImpl: async () => Response.json({
      error: 'lyrics_web_candidate_not_found',
      diagnostics: { sourceHost: 'namu.wiki' },
    }, { status: 404 }),
  }), (error) => error.code === 'lyrics_web_candidate_not_found'
    && error.status === 404
    && error.diagnostics?.sourceHost === 'namu.wiki');
});

test('a matching bundled songbook record wins without calling the hosted provider', async () => {
  const defaultInput = { ...input, sourcePriority: 'default' };
  const key = await songbookLyricsCatalogKey(defaultInput);
  const requests = [];
  const result = await searchHostedLyrics({
    endpoint: 'https://rekasong.pages.dev/api/lyrics-search',
    catalogBaseUrl: 'https://11qaws.github.io/rekasong/lyrics-catalog/v1/',
    input: defaultInput,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return Response.json({
        schemaVersion: 1,
        title: defaultInput.title,
        artist: defaultInput.artist,
        status: 'review_required',
        language: 'ja',
        sourceKind: 'vocaro_verbatim_lyrics',
        lines: ['one', 'two'],
        translations: ['하나', '둘'],
        discoveryPath: ['vocaro'],
      });
    },
  });

  assert.deepEqual(requests, [`https://11qaws.github.io/rekasong/lyrics-catalog/v1/${key}.json`]);
  assert.equal(result.videoId, defaultInput.videoId);
  assert.deepEqual(result.discoveryPath, ['bundled_songbook_catalog', 'vocaro']);
});

test('a mismatched bundled record fails closed and falls through to the hosted provider', async () => {
  const requests = [];
  const result = await searchHostedLyrics({
    endpoint: 'https://rekasong.pages.dev/api/lyrics-search',
    catalogBaseUrl: 'https://11qaws.github.io/rekasong/lyrics-catalog/v1/',
    input,
    fetchImpl: async (url, options) => {
      requests.push(String(url));
      if (options.method === 'GET') return Response.json({ schemaVersion: 1, title: 'Wrong', artist: '' });
      return Response.json({ status: 'review_required', sourceKind: 'hosted' });
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(result.sourceKind, 'hosted');
});
