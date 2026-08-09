import test from 'node:test';
import assert from 'node:assert/strict';

import { extractSongTitle } from '../functions/api/gemini.js';

test('AI title extraction returns canonical artist metadata without trusting the uploader', async () => {
  const result = await extractSongTitle({
    apiKey: 'fixture-key',
    prompt: 'fixture prompt',
    fallbackTitle: 'Idol',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.response_format.schema.required, [
        'canonical_song_title',
        'canonical_artist',
      ]);
      return Response.json({
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              canonical_song_title: '아이돌',
              canonical_artist: 'YOASOBI',
            }),
          }],
        }],
      });
    },
  });

  assert.deepEqual(result, { title: '아이돌', artist: 'YOASOBI', mode: 'ai' });
});
