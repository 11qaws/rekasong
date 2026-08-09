import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ingestNamuWikiLyrics,
  onRequest,
  validateNamuWikiIngestRequest,
} from '../functions/api/lyrics-ingest.js';

const lines = [
  'first synthetic lyric line',
  'second synthetic lyric line',
  'third synthetic lyric line',
  'fourth synthetic lyric line',
  'fifth synthetic lyric line',
];

const input = {
  title: 'Synthetic Song',
  artist: 'Example Artist',
  sourceTitle: 'Synthetic Song - NamuWiki',
  sourceUrl: 'https://namu.wiki/w/Synthetic',
  blocks: [{ blockIndex: 42, heading: 'Lyrics', lines }],
};

test('NamuWiki ingestion accepts only bounded exact-host candidate blocks', () => {
  const value = validateNamuWikiIngestRequest(input);
  assert.equal(value.sourceUrl, 'https://namu.wiki/w/Synthetic');
  assert.equal(value.blocks[0].blockIndex, 0);
  assert.equal(validateNamuWikiIngestRequest({
    ...input,
    sourceUrl: 'https://namu.wiki.example/w/Synthetic',
  }), null);
  assert.equal(validateNamuWikiIngestRequest({
    ...input,
    blocks: [{ heading: 'Too short', lines: lines.slice(0, 4) }],
  }), null);
});

test('protected ingestion stores the selected original lines without returning them', async () => {
  let storedKey = '';
  let storedRecord = null;
  const result = await ingestNamuWikiLyrics(input, {
    apiKey: 'fixture-key',
    cache: {
      async put(key, value) {
        storedKey = key;
        storedRecord = JSON.parse(value);
      },
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.tools || [], []);
      assert.match(body.input, /Return only the selected block index/);
      return Response.json({
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              selectedBlockIndex: 0,
              exactSongMatch: true,
              completeLyricsConfirmed: true,
              language: 'en',
            }),
          }],
        }],
      });
    },
  });

  assert.match(storedKey, /^lyrics:v1:[a-f\d]{64}$/u);
  assert.deepEqual(storedRecord.lines, lines);
  assert.equal(storedRecord.originalTextPolicy, 'verbatim');
  assert.deepEqual(result, {
    stored: true,
    sourceUrl: 'https://namu.wiki/w/Synthetic',
    lineCount: 5,
    language: 'en',
    originalTextPolicy: 'verbatim',
  });
  assert.equal(Object.hasOwn(result, 'lines'), false);
});

test('ingestion route rejects an invalid bearer secret before reading the payload', async () => {
  const response = await onRequest({
    request: new Request('https://rekasong.pages.dev/api/lyrics-ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret' },
      body: '{not-json',
    }),
    env: { LYRICS_INGEST_SECRET: 'fixture-secret-that-is-long-enough' },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});
