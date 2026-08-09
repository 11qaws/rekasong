import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LYRICS_TRANSLATION_POLICY_VERSION,
  lyricsTranslationCacheKey,
  translateWithGemini,
  validateLyricsTranslationRequest,
  validateLyricsTranslationResult,
} from '../functions/api/lyrics-translate.js';

const hash = `sha256:${'a'.repeat(64)}`;

test('whole-song polish request preserves the source language and all lines', () => {
  const request = validateLyricsTranslationRequest({
    contentHash: hash,
    title: 'Synthetic',
    artist: 'Fixture',
    originalLanguage: 'ko',
    preserveOriginal: true,
    originalLines: ['첫 줄 오타', '둘째 줄'],
  });
  assert.equal(request.originalLanguage, 'ko');
  assert.equal(request.preserveOriginal, true);
  assert.deepEqual(request.originalLines, ['첫 줄 오타', '둘째 줄']);
  assert.match(lyricsTranslationCacheKey(request), new RegExp(LYRICS_TRANSLATION_POLICY_VERSION));
  assert.equal(LYRICS_TRANSLATION_POLICY_VERSION, 'lyrics-ko-context-v5-verbatim-source-owned');
});

test('whole-song polish result cannot add or drop corrected or translated lines', () => {
  assert.equal(validateLyricsTranslationResult({
    correctedOriginalLines: ['one'],
    translations: ['하나', '둘'],
  }, 2), null);
  assert.equal(validateLyricsTranslationResult({
    correctedOriginalLines: ['one', 'two'],
    translations: ['하나'],
  }, 2), null);

  const result = validateLyricsTranslationResult({
    correctedOriginalLines: ['one', 'two'],
    translations: ['하나', '둘'],
  }, 2);
  assert.deepEqual(result.correctedOriginalLines, ['one', 'two']);
  assert.deepEqual(result.translations, ['하나', '둘']);
});

test('verified lyrics schema asks only for translations and preserves application-owned originals', async () => {
  const request = validateLyricsTranslationRequest({
    contentHash: `sha256:${'b'.repeat(64)}`,
    title: 'Synthetic Song',
    artist: 'Example Artist',
    originalLanguage: 'ja',
    preserveOriginal: true,
    originalLines: ['line one', 'line two'],
  });
  const result = await translateWithGemini('fixture-key', request, async (_url, options) => {
    const body = JSON.parse(options.body);
    const properties = body.response_format.schema.properties;
    assert.equal(properties.correctedOriginalLines, undefined);
    assert.equal(properties.translations.minItems, undefined);
    assert.equal(properties.translations.maxItems, undefined);
    assert.deepEqual(body.response_format.schema.required, ['translations']);
    return Response.json({
      steps: [{
        type: 'model_output',
        content: [{
          type: 'text',
          text: JSON.stringify({
            translations: ['첫째 줄', '둘째 줄'],
          }),
        }],
      }],
    });
  });
  assert.deepEqual(result.correctedOriginalLines, request.originalLines);
  assert.equal(result.translations.length, request.originalLines.length);
});
