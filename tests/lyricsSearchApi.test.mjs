import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSyncedLyrics,
  searchLrclibLyrics,
  selectLrclibCandidate,
  validateLyricsSearchRequest,
} from '../functions/api/lyrics-search.js';

const input = validateLyricsSearchRequest({
  videoId: 'abcdefghijk',
  title: 'Synthetic Song',
  artist: 'Example Artist',
  durationMs: 180_000,
});

test('synced web lyrics normalize into bounded timed cues', () => {
  assert.deepEqual(parseSyncedLyrics('[00:01.20]alpha\r\n[00:02.345][00:03.00]<00:02.34>beta'), [
    { anchorMs: 1_200, text: 'alpha' },
    { anchorMs: 2_345, text: 'beta' },
    { anchorMs: 3_000, text: 'beta' },
  ]);
  assert.equal(parseSyncedLyrics('plain text only').length, 0);
});

test('web search selects a matching synchronized candidate with explicit provenance', () => {
  const candidate = selectLrclibCandidate(input, [
    { id: 1, trackName: 'Different Song', artistName: 'Other Artist', duration: 180, syncedLyrics: '[00:01.00]wrong' },
    { id: 2, trackName: 'Synthetic Song', artistName: 'Example Artist', duration: 181, lang: 'en', syncedLyrics: '[00:01.00]alpha' },
  ]);
  assert.equal(candidate.sourceKind, 'lrclib_synced_lyrics');
  assert.equal(candidate.sourceUrl, 'https://lrclib.net/api/get/2');
  assert.equal(candidate.status, 'review_required');
  assert.deepEqual(candidate.cues, [{ anchorMs: 1_000, text: 'alpha' }]);
});

test('web search calls only the fixed provider endpoint and returns the prepared candidate', async () => {
  let requestedUrl = '';
  const candidate = await searchLrclibLyrics(input, async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify([
      { id: 3, trackName: 'Synthetic Song', artistName: 'Example Artist', duration: 180, syncedLyrics: '[00:01.00]alpha' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const parsedUrl = new URL(requestedUrl);
  assert.equal(parsedUrl.origin + parsedUrl.pathname, 'https://lrclib.net/api/search');
  assert.equal(parsedUrl.searchParams.get('track_name'), input.title);
  assert.equal(parsedUrl.searchParams.get('artist_name'), input.artist);
  assert.equal(candidate.videoId, input.videoId);
});

test('web search request rejects missing identity or unbounded metadata', () => {
  assert.equal(validateLyricsSearchRequest({ title: 'Synthetic Song' }), null);
  assert.equal(validateLyricsSearchRequest({ videoId: 'bad', title: 'Synthetic Song' }), null);
});
