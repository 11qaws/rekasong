import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSyncedLyrics,
  searchLyrics,
  searchLrclibLyrics,
  selectLrclibCandidate,
  validateGroundedLyricsResult,
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

test('grounded lyrics require a direct matching citation and remain explicitly untimed', () => {
  const value = {
    completeLyricsConfirmed: true,
    language: 'ja',
    sourceTitle: 'Synthetic source',
    sourceUrl: 'https://namu.wiki/w/Synthetic',
    lines: ['alpha', 'beta'],
  };
  assert.equal(validateGroundedLyricsResult(value, ['https://example.com/not-the-source'], input), null);
  const candidate = validateGroundedLyricsResult(value, ['https://namu.wiki/w/Synthetic#lyrics'], input);
  assert.equal(candidate.timingEstimated, true);
  assert.equal(candidate.sourceKind, 'gemini_grounded_web_lyrics');
  assert.deepEqual(candidate.discoveryPath, ['lrclib', 'google_search', 'namuwiki']);
  assert.deepEqual(candidate.lines, ['alpha', 'beta']);
});

test('lyrics search falls through LRCLIB to one grounded Google and URL-context search', async () => {
  const requests = [];
  const candidate = await searchLyrics(input, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).startsWith('https://lrclib.net/')) {
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              completeLyricsConfirmed: true,
              language: 'en',
              sourceTitle: 'Attributed lyric page',
              sourceUrl: 'https://example.com/lyrics/synthetic',
              lines: ['alpha', 'beta'],
            }),
            annotations: [{
              type: 'url_citation',
              url: 'https://example.com/lyrics/synthetic',
              title: 'example.com',
            }],
          }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(requests.length, 3);
  const interactionBody = JSON.parse(requests[2].options.body);
  assert.deepEqual(interactionBody.tools, [{ type: 'url_context' }, { type: 'google_search' }]);
  assert.match(interactionBody.input, /NamuWiki, Touhou Wiki, and VocaDB/);
  assert.equal(candidate.sourceUrl, 'https://example.com/lyrics/synthetic');
  assert.deepEqual(candidate.discoveryPath, ['lrclib', 'google_search', 'general_web']);
});

test('grounded search retries once without URL Context when the combined tool request is rejected', async () => {
  const interactionTools = [];
  const candidate = await searchLyrics(input, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      if (String(url).startsWith('https://lrclib.net/')) {
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const tools = JSON.parse(options.body).tools;
      interactionTools.push(tools);
      if (interactionTools.length === 1) {
        return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              completeLyricsConfirmed: true,
              language: 'en',
              sourceTitle: 'Attributed lyric page',
              sourceUrl: 'https://example.com/lyrics/synthetic',
              lines: ['alpha', 'beta'],
            }),
            annotations: [{ type: 'url_citation', url: 'https://example.com/lyrics/synthetic' }],
          }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.deepEqual(interactionTools, [
    [{ type: 'url_context' }, { type: 'google_search' }],
    [{ type: 'google_search' }],
  ]);
  assert.equal(candidate.sourceUrl, 'https://example.com/lyrics/synthetic');
});
