import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LYRICS_TRANSLATION_POLICY_VERSION,
  lyricsTranslationCacheKey,
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
    originalLines: ['첫 줄 오타', '둘째 줄'],
  });
  assert.equal(request.originalLanguage, 'ko');
  assert.deepEqual(request.originalLines, ['첫 줄 오타', '둘째 줄']);
  assert.match(lyricsTranslationCacheKey(request), /lyrics-ko-context-v2/);
  assert.equal(LYRICS_TRANSLATION_POLICY_VERSION, 'lyrics-ko-context-v2');
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
