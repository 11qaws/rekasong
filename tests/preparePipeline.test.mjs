import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PREPARE_REQUEST_ERROR_CODES,
  PrepareRequestError,
  fetchPrepareStatus,
  prepareBlockMessage,
  prepareBlockMessageKey,
  prepareFailureInfo,
  prepareInfoState,
  prepareSessionIdentity,
  requestPrepare,
} from '../src/lib/preparePipeline.js';

const AUTH = { room: 'room-1234', token: 'player-token' };
const VIDEO_ID = 'abcdefghijk';

const failedResponse = (status) => ({
  ok: false,
  status,
  json: async () => ({})
});

test('prepare HTTP failures keep session, network, and server causes distinct', async () => {
  const cases = [
    [401, PREPARE_REQUEST_ERROR_CODES.SESSION_INVALID],
    [403, PREPARE_REQUEST_ERROR_CODES.SESSION_INVALID],
    [410, PREPARE_REQUEST_ERROR_CODES.SESSION_ENDED],
    [429, PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR],
    [503, PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR],
  ];

  for (const [status, code] of cases) {
    await assert.rejects(
      requestPrepare(VIDEO_ID, AUTH, { fetchImpl: async () => failedResponse(status) }),
      (error) => {
        assert.ok(error instanceof PrepareRequestError);
        assert.equal(error.code, code);
        assert.equal(error.httpStatus, status);
        assert.equal(error.message, code);
        return true;
      },
    );
  }

  const networkCause = new TypeError('offline');
  await assert.rejects(
    fetchPrepareStatus(VIDEO_ID, AUTH, {
      fetchImpl: async () => { throw networkCause; }
    }),
    (error) => {
      assert.ok(error instanceof PrepareRequestError);
      assert.equal(error.code, PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR);
      assert.equal(error.httpStatus, null);
      assert.equal(error.cause, networkCause);
      return true;
    },
  );
});

test('successful prepare requests preserve the API contract and normalize response fields', async () => {
  let requestUrl = '';
  let requestInit = null;
  const info = await requestPrepare(VIDEO_ID, AUTH, {
    force: true,
    fetchImpl: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ready', failureKind: 42, reason: null })
      };
    }
  });

  assert.match(requestUrl, /\/v1\/prepare\?/);
  assert.match(requestUrl, /room=room-1234/);
  assert.match(requestUrl, /token=player-token/);
  assert.equal(requestInit.method, 'POST');
  assert.deepEqual(JSON.parse(requestInit.body), { videoId: VIDEO_ID, force: true });
  assert.deepEqual(info, { status: 'ready', failureKind: null, reason: '' });
});

test('prepare failure UI state prefers authoritative session lifecycle evidence', () => {
  assert.deepEqual(
    prepareFailureInfo(
      new PrepareRequestError(PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR),
      { sessionState: 'ended' },
    ),
    { status: 'session_ended', failureKind: PREPARE_REQUEST_ERROR_CODES.SESSION_ENDED },
  );
  assert.deepEqual(
    prepareFailureInfo(
      new PrepareRequestError(PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR),
      { sessionState: 'invalid' },
    ),
    { status: 'session_invalid', failureKind: PREPARE_REQUEST_ERROR_CODES.SESSION_INVALID },
  );
  assert.deepEqual(
    prepareFailureInfo(new PrepareRequestError(PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR)),
    { status: 'temporarily_unavailable', failureKind: PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR },
  );
  assert.deepEqual(
    prepareFailureInfo(new PrepareRequestError(PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR)),
    { status: 'temporarily_unavailable', failureKind: PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR },
  );
});

test('prepare presentation keeps the legacy safe gate while exposing the precise connection cause', () => {
  assert.deepEqual(
    prepareInfoState({ status: 'session_invalid' }),
    { kind: 'unreachable', connectionKind: 'session_invalid', reason: '' },
  );
  assert.deepEqual(
    prepareInfoState({ status: 'session_ended' }),
    { kind: 'unreachable', connectionKind: 'session_ended', reason: '' },
  );
  assert.deepEqual(
    prepareInfoState({
      status: 'temporarily_unavailable',
      failureKind: PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR,
    }),
    { kind: 'unreachable', connectionKind: 'network_error', reason: '' },
  );
  assert.deepEqual(
    prepareInfoState({
      status: 'temporarily_unavailable',
      failureKind: PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR,
    }),
    { kind: 'unreachable', connectionKind: 'server_error', reason: '' },
  );
});

test('prepare session identity rotates on either room or player token', () => {
  const first = prepareSessionIdentity({ room: 'room-a', playerToken: 'token-a' });
  assert.ok(first);
  assert.notEqual(first, prepareSessionIdentity({ room: 'room-b', playerToken: 'token-a' }));
  assert.notEqual(first, prepareSessionIdentity({ room: 'room-a', playerToken: 'token-b' }));
  assert.equal(prepareSessionIdentity({ room: 'room-a' }), '');
});

test('prepare messages use semantic translation keys in Korean and English', () => {
  assert.equal(prepareBlockMessageKey({ kind: 'unreachable', connectionKind: 'session_ended' }), 'prepare.block.sessionEnded');
  assert.equal(
    prepareBlockMessage('network_error', 'ko'),
    '네트워크 상태 때문에 곡 준비 여부를 잠시 확인하지 못했습니다. 자동으로 다시 확인합니다.',
  );
  assert.equal(
    prepareBlockMessage('network_error', 'en'),
    'The preparation status could not be checked briefly because of the network. It will be checked again automatically.',
  );
});

test('Dashboard resets prepare state by session identity and fences stale async results', async () => {
  const source = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(source, /const prepareSessionKey = prepareSessionIdentity\(onAirSession\)/);
  assert.match(source, /prepareSessionKeyRef\.current === prepareSessionKey\s+\? storedPrepareStates\s+: EMPTY_PREPARE_STATES/);
  assert.match(source, /prepareGenerationRef\.current \+= 1/);
  assert.match(source, /prepareRequestedRef\.current\.clear\(\)/);
  assert.match(source, /prepareStatesRef\.current = \{\}/);
  assert.match(source, /generation !== prepareGenerationRef\.current/);
  assert.match(source, /prepareSessionKey,\s+watchedVideoIds,/);
  assert.match(source, /prepareStatus === 'session_invalid'/);
  assert.match(source, /prepareStatus === 'session_ended'/);
  assert.match(source, /recoverOnAirConnection\(\)/);
});
