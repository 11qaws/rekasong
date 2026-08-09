import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLyricsProviderAdapter,
  LYRICS_PROVIDER_TYPES,
  normalizeLyricsCandidate,
} from '../src/lib/lyrics/lyricsProviders.js';
import {
  lyricsTranslationCacheKey,
  validateLyricsTranslationRequest,
  validateLyricsTranslationResult,
} from '../functions/api/lyrics-translate.js';

test('provider candidates normalize provenance without trusting an unknown tier', async () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const candidate = normalizeLyricsCandidate('fixture', {
    candidateId: 'one', sourceTierClaim: 'invented_official', contentHash: hash, confidence: 2,
  });
  assert.equal(candidate.sourceTierClaim, 'trusted_web');
  assert.equal(candidate.confidence, 1);
  const adapter = createLyricsProviderAdapter({
    providerId: 'fixture',
    type: LYRICS_PROVIDER_TYPES.TRANSLATION,
    search: async () => [{ candidateId: 'one', contentHash: hash }],
    fetchCandidate: async () => ({ lines: ['synthetic'] }),
  });
  assert.equal((await adapter.search({}))[0].providerId, 'fixture');
});

test('contextual translation validates bounded whole-song input and stable cache identity', () => {
  const request = validateLyricsTranslationRequest({
    contentHash: `sha256:${'b'.repeat(64)}`,
    title: 'Synthetic',
    originalLines: ['alpha', 'beta'],
  });
  assert.ok(request);
  assert.match(lyricsTranslationCacheKey(request), /lyrics-ko-context-v1/);
  assert.deepEqual(validateLyricsTranslationResult({ translations: ['가', '나'] }, 2), ['가', '나']);
  assert.equal(validateLyricsTranslationResult({ translations: ['one'] }, 2), null);
});
