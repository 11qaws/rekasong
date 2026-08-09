import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNamuWikiLyricsHelperServer,
} from '../scripts/namuwiki-lyrics-helper.mjs';
import {
  searchLyricsWithNamuWikiHelper,
} from '../src/lib/lyrics/namuWikiLyricsHelper.js';

const input = {
  videoId: 'abcdefghijk',
  title: 'Synthetic Song',
  artist: 'Example Artist',
  sourcePriority: 'namuwiki_only',
};
const relay = {
  schemaVersion: 1,
  sourceTitle: 'Synthetic Song - NamuWiki',
  sourceUrl: 'https://namu.wiki/w/Synthetic',
  blocks: [{
    blockIndex: 0,
    heading: 'Synthetic Song',
    lines: [
      'first synthetic lyric line',
      'second synthetic lyric line',
      'third synthetic lyric line',
      'fourth synthetic lyric line',
      'fifth synthetic lyric line',
    ],
  }],
};

test('browser client sends an exact-title local relay with NamuWiki-first search', async () => {
  const requests = [];
  const candidate = await searchLyricsWithNamuWikiHelper({
    endpoint: 'https://example.test/api/lyrics-search',
    input,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/health')) return Response.json({ ok: true });
      if (String(url).endsWith('/v1/namuwiki')) return Response.json(relay);
      const body = JSON.parse(options.body);
      assert.deepEqual(body.namuRelay, relay);
      return Response.json({ status: 'review_required', sourceUrl: relay.sourceUrl });
    },
  });

  assert.equal(candidate.status, 'review_required');
  assert.deepEqual(requests.map(({ url }) => url), [
    'http://127.0.0.1:47653/health',
    'http://127.0.0.1:47653/v1/namuwiki',
    'https://example.test/api/lyrics-search',
  ]);
});

test('browser client retries a citation-verified discovered NamuWiki URL through the helper', async () => {
  let helperPostCount = 0;
  let remotePostCount = 0;
  const candidate = await searchLyricsWithNamuWikiHelper({
    endpoint: 'https://example.test/api/lyrics-search',
    input,
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/health')) return Response.json({ ok: true });
      if (requestUrl.endsWith('/v1/namuwiki')) {
        helperPostCount += 1;
        const body = JSON.parse(options.body);
        return body.sourceUrl ? Response.json(relay) : Response.json({ error: 'not_found' }, { status: 404 });
      }
      remotePostCount += 1;
      const body = JSON.parse(options.body);
      return body.namuRelay
        ? Response.json({ status: 'review_required', sourceUrl: relay.sourceUrl })
        : Response.json({
          error: 'lyrics_web_candidate_not_found',
          diagnostics: { namuRelayUrl: relay.sourceUrl },
        }, { status: 404 });
    },
  });

  assert.equal(candidate.status, 'review_required');
  assert.equal(helperPostCount, 2);
  assert.equal(remotePostCount, 2);
});

test('loopback helper enforces browser origin and returns bounded NamuWiki blocks', async (t) => {
  let upstreamCalls = 0;
  const helper = createNamuWikiLyricsHelperServer({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(`
        <h3>Synthetic Song</h3><table><tr><td>
          first synthetic lyric line<br>
          second synthetic lyric line<br>
          third synthetic lyric line<br>
          fourth synthetic lyric line<br>
          fifth synthetic lyric line
        </td></tr></table>
      `, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  });
  await new Promise((resolve, reject) => {
    helper.once('error', reject);
    helper.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => helper.close(resolve)));
  const { port } = helper.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const origin = 'https://11qaws.github.io';

  const preflight = await fetch(`${baseUrl}/v1/namuwiki`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

  const response = await fetch(`${baseUrl}/v1/namuwiki`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Synthetic Song' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const body = await response.json();
  assert.equal(body.blocks.length, 1);
  assert.deepEqual(body.blocks[0].lines, relay.blocks[0].lines);

  const rejected = await fetch(`${baseUrl}/v1/namuwiki`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUrl: 'https://example.com/private' }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(upstreamCalls, 1);
});
