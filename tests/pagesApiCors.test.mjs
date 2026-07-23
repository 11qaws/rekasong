import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest as extractLocal } from '../functions/api/extract-local.js';

test('local-title extraction accepts the GitHub Pages JSON preflight', async () => {
  const response = await extractLocal({
    request: new Request('https://rekasong.pages.dev/api/extract-local', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://11qaws.github.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }),
    env: {},
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(response.headers.get('Access-Control-Allow-Methods') || '', /\bPOST\b/);
  assert.match(response.headers.get('Access-Control-Allow-Methods') || '', /\bOPTIONS\b/);
  assert.match(response.headers.get('Access-Control-Allow-Headers') || '', /\bContent-Type\b/i);
  assert.equal(response.headers.get('Access-Control-Max-Age'), '86400');
});
