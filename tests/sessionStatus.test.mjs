import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { SessionRoom } from '../workers/rekasong-session/src/index.js';

const CONTROL_TOKEN = 'control-token-fixture';

async function hashToken(token) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(token || '')),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createRoom(status = 'active') {
  const storedSession = status === null
    ? null
    : {
        room: 'status-room',
        status,
        controlHash: await hashToken(CONTROL_TOKEN),
        playerHash: await hashToken('player-token-fixture'),
        displayHash: await hashToken('display-token-fixture'),
      };
  const context = {
    storage: {
      async get(key) {
        return key === 'session' ? storedSession : undefined;
      },
    },
  };
  return new SessionRoom(context, {});
}

function statusRequest(token = CONTROL_TOKEN) {
  return new Request('https://session.internal/v1/sessions/status-room/status', {
    method: 'GET',
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

test('session status returns only active for a valid control token', async () => {
  const room = await createRoom('active');
  const response = await room.fetch(statusRequest());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await responseBody(response), { status: 'active' });
});

test('session status returns only ended with 410 for a valid ended session', async () => {
  const room = await createRoom('ended');
  const response = await room.fetch(statusRequest());

  assert.equal(response.status, 410);
  assert.deepEqual(await responseBody(response), { status: 'ended' });
});

test('missing session, missing token, and invalid token share the same bounded 401 response', async () => {
  const cases = [
    { room: await createRoom(null), request: statusRequest() },
    { room: await createRoom('active'), request: statusRequest(null) },
    { room: await createRoom('active'), request: statusRequest('wrong-control-token') },
  ];

  for (const fixture of cases) {
    const response = await fixture.room.fetch(fixture.request);
    const body = await responseBody(response);
    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: 'Unauthorized' });
    assert.equal(JSON.stringify(body).includes(CONTROL_TOKEN), false);
    assert.equal(JSON.stringify(body).includes('controlHash'), false);
  }
});

test('public Worker routes GET session status to the matching Durable Object unchanged', async () => {
  const roomId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let resolvedName = null;
  let forwardedRequest = null;
  const env = {
    SESSION_ROOM: {
      idFromName(name) {
        resolvedName = name;
        return `id:${name}`;
      },
      get(id) {
        assert.equal(id, `id:${roomId}`);
        return {
          async fetch(request) {
            forwardedRequest = request;
            return new Response(JSON.stringify({ status: 'active' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        };
      },
    },
  };
  const request = new Request(`https://worker.example/v1/sessions/${roomId}/status`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.equal(resolvedName, roomId);
  assert.equal(new URL(forwardedRequest.url).pathname, `/v1/sessions/${roomId}/status`);
  assert.equal(forwardedRequest.method, 'GET');
  assert.equal(forwardedRequest.headers.get('Authorization'), `Bearer ${CONTROL_TOKEN}`);
});
