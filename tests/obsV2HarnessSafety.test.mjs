import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARNESS_REDACTED_VALUE,
  createHarnessDiagnosticSanitizer,
  omittedHttpBodyErrorMessage,
} from '../scripts/obs-v2-harness-safety.mjs';

const CONTROL = 'control-secret-value';
const PLAYER = 'player-secret-value';

test('v2 harness sanitizer redacts known credentials in text, encodings, and errors', () => {
  const sanitizer = createHarnessDiagnosticSanitizer([CONTROL, PLAYER]);
  assert.equal(sanitizer.selfCheck(), true);
  const error = new Error(
    `request https://${CONTROL}:${PLAYER}@worker.test/ws?token=${PLAYER}`,
  );
  error.detail = {
    url: `https://worker.test/?auth=${CONTROL}`,
    token: PLAYER,
  };
  const output = sanitizer.errorText(error);
  sanitizer.assertSafe(output);
  assert.doesNotMatch(output, new RegExp(CONTROL, 'u'));
  assert.doesNotMatch(output, new RegExp(PLAYER, 'u'));
  assert.doesNotMatch(output, new RegExp(encodeURIComponent(CONTROL), 'u'));
  assert.match(output, /REDACTED/u);
});

test('v2 harness sanitizer redacts userinfo, query/hash secrets, and nested api URLs', () => {
  const sanitizer = createHarnessDiagnosticSanitizer([CONTROL, PLAYER]);
  const nested = `https://${CONTROL}:${PLAYER}@worker.test/v1?authorization=${CONTROL}`;
  const url = `https://app.test/#/widget?api=${encodeURIComponent(nested)}`
    + `&token=${PLAYER}&safe=value`;
  const output = sanitizer.text(url);
  sanitizer.assertSafe(output);
  assert.doesNotMatch(output, new RegExp(CONTROL, 'u'));
  assert.doesNotMatch(output, new RegExp(PLAYER, 'u'));
  assert.match(output, /safe=value/u);
  assert.match(output, /REDACTED/u);
});

test('v2 harness sanitizer treats sensitive object keys as fail-closed JSON fields', () => {
  const sanitizer = createHarnessDiagnosticSanitizer([CONTROL, PLAYER]);
  const output = sanitizer.json({
    controlToken: CONTROL,
    player_token: PLAYER,
    Authorization: `Bearer ${CONTROL}`,
    safe: 'retained',
  });
  sanitizer.assertSafe(output);
  const parsed = JSON.parse(output);
  assert.equal(parsed.controlToken, HARNESS_REDACTED_VALUE);
  assert.equal(parsed.player_token, HARNESS_REDACTED_VALUE);
  assert.equal(parsed.Authorization, HARNESS_REDACTED_VALUE);
  assert.equal(parsed.safe, 'retained');
});

test('v2 harness sanitizer masks encoded sensitive assignments even before secrets register', () => {
  const sanitizer = createHarnessDiagnosticSanitizer();
  const single = 'https%3A%2F%2Fworker.test%2Fws%3Ftoken%3Dunknown-value%26safe%3Dok';
  const double = 'https%253A%252F%252Fworker.test%252Fws%253Fauth%253Dother-value';
  const output = sanitizer.text(`${single} ${double}`);
  assert.doesNotMatch(output, /unknown-value|other-value/u);
  assert.match(output, /REDACTED/u);
});

test('v2 harness sanitizer masks raw JSON response bodies before token registration', () => {
  const sanitizer = createHarnessDiagnosticSanitizer();
  const body = '{"room":"kept","controlToken":"unknown-control",'
    + '"player_token":"unknown-player","nested":{"apiKey":"unknown-key"}}';
  const output = sanitizer.text(`HTTP 500 body=${body}`);
  assert.doesNotMatch(output, /unknown-control|unknown-player|unknown-key/u);
  assert.match(output, /"room":"kept"/u);
  assert.match(output, /REDACTED/u);
});

test('v2 harness sanitizer masks an unregistered bare hash credential', () => {
  const sanitizer = createHarnessDiagnosticSanitizer();
  const output = sanitizer.text('https://app.test/status#authorization=unknown-bearer');
  assert.doesNotMatch(output, /unknown-bearer/u);
  assert.match(output, /authorization=.*REDACTED/u);
});

test('pre-parse HTTP failures omit every malformed response-body credential shape', () => {
  const secrets = [
    'unregistered-bearer-secret',
    'unregistered-array-secret',
    'unregistered-bare-secret',
  ];
  const body = '{ malformed ' + JSON.stringify({
    header: `Authorization: Bearer ${secrets[0]}`,
    tokens: [secrets[1]],
    value: secrets[2],
  });
  const output = omittedHttpBodyErrorMessage({
    operation: 'session creation',
    status: 502,
    body,
  });

  assert.match(output, /^session creation returned non-JSON HTTP 502/u);
  assert.match(output, /response body omitted/u);
  assert.match(output, new RegExp(`${new TextEncoder().encode(body).byteLength} bytes`, 'u'));
  for (const secret of secrets) assert.doesNotMatch(output, new RegExp(secret, 'u'));
  assert.doesNotMatch(output, /Authorization|Bearer|tokens|value/u);
});
