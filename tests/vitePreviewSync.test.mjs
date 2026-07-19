import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import viteConfig from '../vite.config.js';

function installWith(hookName) {
  const plugin = viteConfig.plugins.find((candidate) => candidate.name === 'rekasong-widget-sync');
  assert.ok(plugin, 'widget sync plugin must be present');
  let registration = null;
  plugin[hookName]({
    middlewares: {
      use(path, handler) {
        registration = { path, handler };
      },
    },
  });
  assert.equal(registration?.path, '/api/sync');
  assert.equal(typeof registration?.handler, 'function');
  return registration.handler;
}

function responseRecorder() {
  let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  return {
    headers: {},
    statusCode: null,
    body: '',
    ended,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = '') {
      this.body = body;
      resolveEnded();
    },
  };
}

test('local widget sync middleware is installed for both dev and production preview', async () => {
  installWith('configureServer');
  const handler = installWith('configurePreviewServer');
  const room = `preview-test-${Date.now()}`;
  const payload = { state: { title: 'preview works' }, timestamp: 1_721_420_000_000 };

  const postRequest = new EventEmitter();
  postRequest.method = 'POST';
  postRequest.url = '/';
  const postResponse = responseRecorder();
  handler(postRequest, postResponse);
  postRequest.emit('data', JSON.stringify({ room, payload }));
  postRequest.emit('end');
  await postResponse.ended;
  assert.equal(postResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(postResponse.body), { success: true });

  const getResponse = responseRecorder();
  handler({ method: 'GET', url: `/?room=${encodeURIComponent(room)}` }, getResponse);
  await getResponse.ended;
  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(getResponse.body), payload);
});
