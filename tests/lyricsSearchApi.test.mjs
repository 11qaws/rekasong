import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractNamuWikiLyricsBlocks,
  extractNamuWikiSourceBlocks,
  extractVocaroLyrics,
  lyricsCacheKey,
  parseSyncedLyrics,
  searchPlaybackLyricsTiming,
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

const timingLines = Array.from({ length: 5 }, (_, index) => `locked lyric line ${index + 1}`);
const timingInput = validateLyricsSearchRequest({
  videoId: 'abcdefghijk',
  title: 'Synthetic Song',
  artist: 'Example Artist',
  durationMs: 180_000,
  sourcePriority: 'timing_only',
  lines: timingLines,
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

test('NamuWiki parallel translations keep only the styled original-language layer', () => {
  const blocks = extractNamuWikiLyricsBlocks(`
    <h3>1. Exact Song</h3>
    <table><tr><td>
      <span style="color:#f0f">original one complete line</span><br>reading one<br>translation one<br><br>
      <span style="color:#f0f">original two complete line</span><br>reading two<br>translation two<br><br>
      <span style="color:#f0f">original three complete line</span><br>reading three<br>translation three<br><br>
      <span style="color:#f0f">original four complete line</span><br>reading four<br>translation four<br><br>
      <span style="color:#f0f">original five long enough</span><br>reading five<br>translation five
    </td></tr></table>
  `);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].extractionMode, 'styled_original_layer');
  assert.deepEqual(blocks[0].lines, [
    'original one complete line',
    'original two complete line',
    'original three complete line',
    'original four complete line',
    'original five long enough',
  ]);
});

test('NamuWiki API source candidates remove markup without rewriting lyric text', () => {
  const blocks = extractNamuWikiSourceBlocks(`
= Lyrics =
||<table width=100%><#111> {{{#fff first verbatim lyric line[br]
second verbatim lyric line[br]
third verbatim lyric line[br]
fourth verbatim lyric line[br]
fifth verbatim lyric line}}} ||
  `);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].lines, [
    'first verbatim lyric line',
    'second verbatim lyric line',
    'third verbatim lyric line',
    'fourth verbatim lyric line',
    'fifth verbatim lyric line',
  ]);
  assert.equal(blocks[0].heading, 'Lyrics');
});

test('Vocaro triplets preserve the original and Korean translation layers without model rewriting', () => {
  const triplets = Array.from({ length: 5 }, (_, index) => `
    <tr><td>original ${index + 1} 日本語</td></tr>
    <tr><td>reading ${index + 1}</td></tr>
    <tr><td>번역 ${index + 1}</td></tr>
  `).join('');
  const extracted = extractVocaroLyrics(`
    <div id="page-title">Synthetic Song</div>
    <h1><span>정보</span></h1>
    <h1><span>가사</span></h1>
    <table>${triplets}</table>
    <h1><span>댓글</span></h1>
  `, input);

  assert.equal(extracted.language, 'ja');
  assert.deepEqual(extracted.lines, Array.from({ length: 5 }, (_, index) => `original ${index + 1} 日本語`));
  assert.deepEqual(extracted.translations, Array.from({ length: 5 }, (_, index) => `번역 ${index + 1}`));
});

test('playback audio timing returns anchors attached only to the locked input lines', async () => {
  let requestBody;
  const candidate = await searchPlaybackLyricsTiming(timingInput, 'fixture-key', async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return Response.json({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{
          type: 'text',
          text: JSON.stringify({
            vocalsDetected: true,
            exactLyricsSequence: true,
            analysisConfidencePercent: 88,
            anchors: timingLines.map((_, lineIndex) => ({
              lineIndex,
              anchorMs: 1_000 + (lineIndex * 2_500),
              confidencePercent: 82,
            })),
          }),
        }],
      }],
    });
  });

  assert.equal(requestBody.input[0].type, 'video');
  assert.equal(requestBody.input[0].uri, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(requestBody.input[1].type, 'text');
  assert.equal(candidate.sourceKind, 'gemini_playback_audio_timing');
  assert.equal(candidate.timingEstimated, true);
  assert.equal(candidate.timingAnalysisConfidence, 0.88);
  assert.deepEqual(candidate.cues.map((cue) => cue.text), timingLines);
  assert.deepEqual(candidate.cues.map((cue) => cue.anchorMs), [1_000, 3_500, 6_000, 8_500, 11_000]);
});

test('playback audio timing fails closed without vocals or enough anchors', async () => {
  await assert.rejects(
    searchPlaybackLyricsTiming(timingInput, 'fixture-key', async () => Response.json({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{
          type: 'text',
          text: JSON.stringify({
            vocalsDetected: false,
            exactLyricsSequence: false,
            analysisConfidencePercent: 30,
            anchors: [],
          }),
        }],
      }],
    })),
    (error) => error.message === 'lyrics_timing_candidate_not_found' && error.status === 404,
  );
  assert.equal(validateLyricsSearchRequest({
    videoId: 'abcdefghijk',
    title: 'Synthetic Song',
    sourcePriority: 'timing_only',
    lines: ['too few'],
  }), null);
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
  assert.equal(validateLyricsSearchRequest({ ...input, sourcePriority: 'official_only' }).sourcePriority, 'official_only');
});

test('official-only priority uses AI discovery and independent source verification without LRCLIB', async () => {
  const priorityInput = validateLyricsSearchRequest({ ...input, sourcePriority: 'official_only' });
  const requests = [];
  const sourceUrl = 'https://artist.example/lyrics/synthetic';
  const candidate = await searchLyrics(priorityInput, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return groundedResponse(options, { sourceUrl, sourceCategory: 'official_web' });
    },
  });

  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => !request.url.startsWith('https://lrclib.net/')));
  assert.match(JSON.parse(requests[0].options.body).input, /Search only an official public artist/);
  assert.equal(candidate.sourceKind, 'gemini_grounded_official_web_lyrics');
  assert.deepEqual(candidate.discoveryPath, ['google_search', 'official_web']);
  assert.equal(candidate.originalTextPolicy, 'verbatim');
});

test('Vocaro-only priority verifies the exact host triplets and returns both locked text layers', async () => {
  const priorityInput = validateLyricsSearchRequest({ ...input, sourcePriority: 'vocaro_only' });
  const sourceUrl = 'https://vocaro.wikidot.com/synthetic-song';
  const triplets = Array.from({ length: 5 }, (_, index) => `
    <tr><td>original ${index + 1} 日本語</td></tr>
    <tr><td>reading ${index + 1}</td></tr>
    <tr><td>번역 ${index + 1}</td></tr>
  `).join('');
  const requests = [];
  const candidate = await searchLyrics(priorityInput, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      requests.push(String(url));
      if (String(url) === sourceUrl) {
        return new Response(`
          <div id="page-title">Synthetic Song</div>
          <h1>가사</h1><table>${triplets}</table><h1>댓글</h1>
        `, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return groundedResponse(options, { sourceUrl, sourceCategory: 'vocaro' });
    },
  });

  assert.deepEqual(requests, [
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    sourceUrl,
  ]);
  assert.equal(candidate.sourceKind, 'vocaro_verbatim_lyrics');
  assert.equal(candidate.originalTextPolicy, 'verbatim');
  assert.equal(candidate.autoGenerated, false);
  assert.equal(candidate.lines.length, 5);
  assert.equal(candidate.translations.length, 5);
  assert.deepEqual(candidate.discoveryPath, ['google_search', 'vocaro']);
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
  assert.equal(requests[0].url, 'https://namu.wiki/w/Synthetic%20Song(Example%20Artist)');
  assert.deepEqual(JSON.parse(requests[1].options.body).tools || [], []);
  assert.deepEqual(candidate.discoveryPath, ['deterministic_namuwiki_url', 'namuwiki']);
  assert.equal(candidate.originalTextPolicy, 'verbatim');
  assert.equal(candidate.lines.length, 5);
});

test('NamuWiki-only priority reads official API source with a server-only bearer token', async () => {
  const priorityInput = validateLyricsSearchRequest({
    ...input,
    sourcePriority: 'namuwiki_only',
  });
  const requests = [];
  const candidate = await searchLyrics(priorityInput, {
    apiKey: 'fixture-key',
    namuWikiApiToken: 'fixture-namu-token',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).startsWith('https://namu.wiki/api/edit/')) {
        return new Response(JSON.stringify({
          exists: true,
          text: `= Synthetic Song =
||<table><#111> {{{#fff first synthetic lyric line[br]
second synthetic lyric line[br]
third synthetic lyric line[br]
fourth synthetic lyric line[br]
fifth synthetic lyric line}}} ||`,
        }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }
      return groundedResponse(options, {
        sourceUrl: 'https://namu.wiki/w/Synthetic%20Song(Example%20Artist)',
        sourceCategory: 'namuwiki',
      });
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://namu.wiki/api/edit/Synthetic%20Song(Example%20Artist)');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-namu-token');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(requests[1].options.body).tools || [], []);
  assert.equal(candidate.sourceKind, 'namuwiki_api_verbatim_lyrics');
  assert.equal(candidate.autoGenerated, false);
  assert.deepEqual(candidate.discoveryPath, ['deterministic_namuwiki_url', 'namuwiki_api', 'namuwiki']);
  assert.deepEqual(candidate.lines, [
    'first synthetic lyric line',
    'second synthetic lyric line',
    'third synthetic lyric line',
    'fourth synthetic lyric line',
    'fifth synthetic lyric line',
  ]);
});

test('hosted NamuWiki cache serves verbatim originals before network providers', async () => {
  const priorityInput = validateLyricsSearchRequest({
    ...input,
    sourcePriority: 'namuwiki_only',
  });
  const expectedKey = await lyricsCacheKey(priorityInput);
  let requestedKey = '';
  const candidate = await searchLyrics(priorityInput, {
    lyricsCache: {
      async get(key) {
        requestedKey = key;
        return {
          schemaVersion: 1,
          title: input.title,
          artist: input.artist,
          language: 'en',
          sourceTitle: 'Synthetic NamuWiki source',
          sourceUrl: 'https://namu.wiki/w/Synthetic',
          retrievedAt: 123,
          originalTextPolicy: 'verbatim',
          lines: [
            'first synthetic lyric line',
            'second synthetic lyric line',
            'third synthetic lyric line',
            'fourth synthetic lyric line',
            'fifth synthetic lyric line',
          ],
        };
      },
    },
    fetchImpl: async () => {
      throw new Error('network providers must not run on a cache hit');
    },
  });

  assert.equal(requestedKey, expectedKey);
  assert.equal(candidate.videoId, priorityInput.videoId);
  assert.equal(candidate.sourceKind, 'namuwiki_cached_verbatim_lyrics');
  assert.equal(candidate.autoGenerated, false);
  assert.equal(candidate.originalTextPolicy, 'verbatim');
  assert.deepEqual(candidate.discoveryPath, ['hosted_namuwiki_cache', 'namuwiki']);
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
    'https://namu.wiki/w/Synthetic%20Song(Example%20Artist)',
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    'https://namu.wiki/w/Synthetic%20Song',
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    'https://namu.wiki/w/Discovered',
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  ]);
  assert.equal(candidate.sourceUrl, 'https://namu.wiki/w/Discovered');
  assert.equal(candidate.lines.length, 5);
});

test('deterministic NamuWiki artist page uses URL Context when server HTML is challenged', async () => {
  const priorityInput = validateLyricsSearchRequest({ ...input, sourcePriority: 'namuwiki_only' });
  const sourceUrl = 'https://namu.wiki/w/Synthetic%20Song(Example%20Artist)';
  const requests = [];
  const candidate = await searchLyrics(priorityInput, {
    apiKey: 'fixture-key',
    fetchImpl: async (url, options = {}) => {
      requests.push(String(url));
      if (String(url).startsWith('https://namu.wiki/')) {
        return new Response('challenge', { status: 403, headers: { 'Content-Type': 'text/plain' } });
      }
      return groundedResponse(options, { sourceUrl, sourceCategory: 'namuwiki' });
    },
  });

  assert.deepEqual(requests, [
    sourceUrl,
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  ]);
  assert.deepEqual(candidate.discoveryPath, ['deterministic_namuwiki_url', 'url_context', 'namuwiki']);
  assert.equal(candidate.originalTextPolicy, 'verbatim');
  assert.deepEqual(candidate.lines, ['alpha', 'beta']);
});

test('citation-free NamuWiki discovery returns a host-validated URL when URL Context is blocked', async () => {
  const priorityInput = validateLyricsSearchRequest({ ...input, sourcePriority: 'namuwiki_only' });
  const sourceUrl = 'https://namu.wiki/w/Discovered';
  const modelUrl = 'https://namu.wiki/w/Discvered';
  await assert.rejects(searchLyrics(priorityInput, {
    apiKey: 'fixture-key',
    namuWikiApiToken: 'fixture-namu-token',
    fetchImpl: async (url, options = {}) => {
      if (String(url).startsWith('https://namu.wiki/')) {
        return new Response('blocked', { status: 403, headers: { 'Content-Type': 'text/plain' } });
      }
      const body = JSON.parse(options.body);
      const isDiscovery = (body.tools || []).some((tool) => tool.type === 'google_search');
      const isIdentityVerification = body.input.startsWith('Open this exact source URL');
      const text = isDiscovery
        ? JSON.stringify({ sourceFound: true, sourceTitle: 'Discovered', sourceUrl: modelUrl, sourceCategory: 'namuwiki' })
        : isIdentityVerification
          ? 'REJECTED'
          : JSON.stringify({ completeLyricsConfirmed: false, language: 'und', lines: [] });
      return new Response(JSON.stringify({
        status: 'completed',
        steps: [
          ...(isDiscovery ? [{
            type: 'google_search_result',
            result: [{ title: 'Discovered', url: sourceUrl, snippet: 'fixture' }],
          }] : []),
          { type: 'model_output', content: [{ type: 'text', text }] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  }), (error) => error.message === 'lyrics_web_candidate_not_found'
    && error.diagnostics?.namuCandidateUrl === sourceUrl
    && error.diagnostics?.namuCandidateUrls?.includes(modelUrl)
    && error.diagnostics?.directNamu?.apiAttempts?.length === 1
    && error.diagnostics.directNamu.apiAttempts.every((attempt) => (
      attempt.status === 403 && attempt.outcome === 'authorization_rejected'
    )));
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
