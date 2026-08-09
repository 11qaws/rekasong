import test from 'node:test';
import assert from 'node:assert/strict';

import { searchHostedLyrics } from '../src/lib/lyrics/lyricsSearchClient.js';

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
