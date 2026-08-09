import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractNamuWikiLyricsBlocks,
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

function groundedResponse(options, {
  sourceUrl = 'https://example.com/lyrics/synthetic',
  sourceCategory = 'other',
  verify = true,
} = {}) {
  const body = JSON.parse(options.body);
  const isDiscovery = (body.tools || []).some((tool) => tool.type === 'google_search');
  const isBlockSelection = body.input.startsWith('Select the one candidate block');
  const isExtraction = !isDiscovery && body.response_format;
  const text = isDiscovery
    ? JSON.stringify({ sourceFound: true, sourceTitle: 'Attributed lyric page', sourceUrl, sourceCategory })
    : isBlockSelection
      ? JSON.stringify({ selectedBlockIndex: 0, exactSongMatch: true, completeLyricsConfirmed: true, language: 'ko' })
    : isExtraction
      ? JSON.stringify({ completeLyricsConfirmed: true, language: 'en', lines: ['alpha', 'beta'] })
      : verify ? 'VERIFIED' : 'REJECTED';
  return new Response(JSON.stringify({
    status: 'completed',
    steps: [
      ...(!isDiscovery ? [{
        type: 'url_context_result',
        is_error: false,
        result: [{ status: 'success', url: sourceUrl }],
      }] : []),
      {
        type: 'model_output',
        content: [{
          type: 'text',
          text,
          ...(isDiscovery ? { annotations: [{ type: 'url_citation', url: sourceUrl }] } : {}),
        }],
      },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('NamuWiki HTML candidates preserve displayed line text without model rewriting', () => {
  const blocks = extractNamuWikiLyricsBlocks(`
    <h3><span>1. Exact Song</span></h3>
    <table><tr><td>
      first <strong>verbatim</strong> lyric line<br data-v-x>
      second verbatim lyric line<br>
      third verbatim lyric line<br>
      fourth verbatim lyric line<br>
      fifth verbatim lyric line
    </td></tr></table>
  `);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].lines, [
    'first verbatim lyric line',
    'second verbatim lyric line',
    'third verbatim lyric line',
    'fourth verbatim lyric line',
    'fifth verbatim lyric line',
  ]);
  assert.match(blocks[0].heading, /Exact Song/);
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

test('NamuWiki-only priority bypasses LRCLIB and accepts a cited NamuWiki page', async () => {
  const priorityInput = validateLyricsSearchRequest({
    ...input,
    sourcePriority: 'namuwiki_only',
  });
  const requests = [];
  const candidate = await searchLyrics(priorityInput, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).startsWith('https://namu.wiki/')) {
        return new Response(`
          <h3>1. Synthetic Song</h3>
          <table><tr><td>
            first synthetic lyric line<br>
            second synthetic lyric line<br>
            third synthetic lyric line<br>
            fourth synthetic lyric line<br>
            fifth synthetic lyric line
          </td></tr></table>
        `, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return groundedResponse(options, {
        sourceUrl: 'https://namu.wiki/w/Synthetic',
        sourceCategory: 'namuwiki',
      });
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://namu.wiki/w/Synthetic%20Song');
  assert.deepEqual(JSON.parse(requests[1].options.body).tools || [], []);
  assert.deepEqual(candidate.discoveryPath, ['google_search', 'namuwiki']);
  assert.equal(candidate.originalTextPolicy, 'verbatim');
  assert.equal(candidate.lines.length, 5);
});

test('NamuWiki direct-title miss falls through to AI page discovery', async () => {
  const priorityInput = validateLyricsSearchRequest({ ...input, sourcePriority: 'namuwiki_only' });
  const requests = [];
  const candidate = await searchLyrics(priorityInput, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      requests.push(requestUrl);
      if (requestUrl.includes('Synthetic%20Song')) {
        return new Response('<html><h2>Not this page</h2></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (requestUrl === 'https://namu.wiki/w/Discovered') {
        return new Response('<h3>Synthetic Song</h3><table><tr><td>first long lyric line<br>second long lyric line<br>third long lyric line<br>fourth long lyric line<br>fifth long lyric line</td></tr></table>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return groundedResponse(options, {
        sourceUrl: 'https://namu.wiki/w/Discovered',
        sourceCategory: 'namuwiki',
      });
    },
  });

  assert.deepEqual(requests, [
    'https://namu.wiki/w/Synthetic%20Song',
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    'https://namu.wiki/w/Discovered',
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  ]);
  assert.equal(candidate.sourceUrl, 'https://namu.wiki/w/Discovered');
  assert.equal(candidate.lines.length, 5);
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
  assert.equal(candidate.originalTextPolicy, 'verbatim');

  const touhouCandidate = validateGroundedLyricsResult({
    ...value,
    sourceUrl: 'https://thwiki.cc/Lyrics:Fixture',
  }, ['https://thwiki.cc/Lyrics:Fixture'], input);
  assert.deepEqual(touhouCandidate.discoveryPath, ['lrclib', 'google_search', 'touhou_wiki']);

  const officialCandidate = validateGroundedLyricsResult({
    ...value,
    sourceUrl: 'https://artist.example/lyrics/synthetic',
    sourceCategory: 'official_web',
  }, ['https://artist.example/lyrics/synthetic'], input);
  assert.equal(officialCandidate.sourceKind, 'gemini_grounded_official_web_lyrics');
  assert.deepEqual(officialCandidate.discoveryPath, ['lrclib', 'google_search', 'official_web']);
});

test('lyrics search falls through LRCLIB to AI discovery, verbatim extraction, and independent verification', async () => {
  const requests = [];
  const candidate = await searchLyrics(input, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).startsWith('https://lrclib.net/')) {
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return groundedResponse(options);
    },
  });

  assert.equal(requests.length, 5);
  const interactionBodies = requests.slice(2).map((request) => JSON.parse(request.options.body));
  assert.deepEqual(interactionBodies.map((body) => body.tools), [
    [{ type: 'google_search' }],
    [{ type: 'url_context' }],
    [{ type: 'url_context' }],
  ]);
  assert.equal(interactionBodies[0].response_format.schema.properties.lines, undefined);
  assert.equal(interactionBodies[1].response_format.schema.properties.lines.items.type, 'string');
  assert.match(interactionBodies[0].input, /1\. NamuWiki\.[\s\S]*2\. An official artist[\s\S]*Touhou Wiki and VocaDB/);
  assert.match(interactionBodies[1].input, /Never reconstruct, correct, translate, paraphrase, summarize, or complete it/);
  assert.equal(candidate.sourceUrl, 'https://example.com/lyrics/synthetic');
  assert.deepEqual(candidate.discoveryPath, ['lrclib', 'google_search', 'general_web']);
});

test('grounded lyrics are rejected when the independent page comparison fails', async () => {
  await assert.rejects(searchLyrics(input, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      if (String(url).startsWith('https://lrclib.net/')) {
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const body = JSON.parse(options.body);
      return groundedResponse(options, { verify: Boolean(body.response_format) });
    },
  }), (error) => error.message === 'lyrics_web_candidate_not_found' && error.status === 404);
});
