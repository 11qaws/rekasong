import test from 'node:test';
import assert from 'node:assert/strict';

import { onAirSessionRecoveryGate } from '../src/lib/onAirSessionRecoveryGate.js';

test('automatic session recovery is claimed only once per page lifetime', () => {
  // These calls model StrictMode's repeated effect setup plus later re-renders
  // and a Dashboard remount within the same JavaScript page lifetime.
  const claims = Array.from({ length: 6 }, () => onAirSessionRecoveryGate.claim());

  assert.deepEqual(claims, [true, false, false, false, false, false]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(Object.hasOwn(onAirSessionRecoveryGate, 'reset'), false);
  assert.equal(Object.isFrozen(onAirSessionRecoveryGate), true);
});
