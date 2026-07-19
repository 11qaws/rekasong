import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTPUT_CONTROL_AUTHORITY_STATES,
  deriveOutputControlAuthority,
  isSafeOutputControlTakeover,
} from '../src/lib/outputControlAuthority.js';

function readySnapshot(overrides = {}) {
  const playerSnapshot = {
    controlLease: {
      controlEpoch: 7,
      writableControlInstanceId: 'control-a',
      writableConnected: true,
    },
    ...(overrides.playerSnapshot ?? {}),
  };
  return {
    state: 'ready',
    ready: true,
    writable: true,
    welcome: { controlInstanceId: 'control-a' },
    ...overrides,
    playerSnapshot,
  };
}

test('authority remains starting until a trusted ready observation exists', () => {
  for (const snapshot of [undefined, {}, { state: 'connecting', ready: false }]) {
    assert.deepEqual(deriveOutputControlAuthority(snapshot), {
      state: OUTPUT_CONTROL_AUTHORITY_STATES.STARTING,
      writable: false,
      otherOwnerConnected: false,
      shouldRetryReleasedOwner: false,
      controlEpoch: null,
    });
  }
});

test('a terminal connection is unavailable even if it retains a cached writable snapshot', () => {
  const authority = deriveOutputControlAuthority(readySnapshot({ state: 'disconnected' }));

  assert.deepEqual(authority, {
    state: OUTPUT_CONTROL_AUTHORITY_STATES.UNAVAILABLE,
    writable: false,
    otherOwnerConnected: false,
    shouldRetryReleasedOwner: false,
    controlEpoch: null,
  });
});

test('a matching writable observation owns output control', () => {
  const authority = deriveOutputControlAuthority(readySnapshot());

  assert.deepEqual(authority, {
    state: OUTPUT_CONTROL_AUTHORITY_STATES.WRITABLE,
    writable: true,
    otherOwnerConnected: false,
    shouldRetryReleasedOwner: false,
    controlEpoch: 7,
  });
  assert.equal(Object.isFrozen(authority), true);
});

test('an unknown authority fence overrides a cached writable observation', () => {
  for (const unknownEvidence of [
    { authorityUnknown: true },
    { unknown: true },
    { unknownLock: { code: 'command_outcome_unknown' } },
  ]) {
    const authority = deriveOutputControlAuthority(readySnapshot(unknownEvidence));
    assert.deepEqual(authority, {
      state: OUTPUT_CONTROL_AUTHORITY_STATES.UNAVAILABLE,
      writable: false,
      otherOwnerConnected: false,
      shouldRetryReleasedOwner: false,
      controlEpoch: 7,
    });
  }
});

test('a live foreign owner is an explicit read-only conflict and never asks to reconnect', () => {
  const authority = deriveOutputControlAuthority(readySnapshot({
    writable: false,
    playerSnapshot: {
      controlLease: {
        controlEpoch: 8,
        writableControlInstanceId: 'control-b',
        writableConnected: true,
      },
    },
  }));

  assert.deepEqual(authority, {
    state: OUTPUT_CONTROL_AUTHORITY_STATES.OTHER_OWNER,
    writable: false,
    otherOwnerConnected: true,
    shouldRetryReleasedOwner: false,
    controlEpoch: 8,
  });
});

test('a released owner asks for one epoch-keyed reconnect while ambiguous authority stays unavailable', () => {
  const released = deriveOutputControlAuthority(readySnapshot({
    writable: false,
    playerSnapshot: {
      controlLease: {
        controlEpoch: 9,
        writableControlInstanceId: null,
        writableConnected: false,
      },
    },
  }));
  assert.deepEqual(released, {
    state: OUTPUT_CONTROL_AUTHORITY_STATES.OWNER_RELEASED,
    writable: false,
    otherOwnerConnected: false,
    shouldRetryReleasedOwner: true,
    controlEpoch: 9,
  });

  const ambiguous = deriveOutputControlAuthority(readySnapshot({
    writable: false,
    playerSnapshot: {
      controlLease: {
        controlEpoch: 9,
        writableControlInstanceId: 'control-a',
        writableConnected: false,
      },
    },
  }));
  assert.equal(ambiguous.state, OUTPUT_CONTROL_AUTHORITY_STATES.UNAVAILABLE);
  assert.equal(ambiguous.shouldRetryReleasedOwner, false);
});

test('takeover preflight accepts only exact idle or strong-stopped proof', () => {
  const base = {
    ...readySnapshot({ writable: false }),
    unknown: false,
    authorityUnknown: false,
    unknownLock: null,
    activeRun: null,
    pendingSwitch: null,
    pendingTest: null,
    desiredTransport: { status: 'idle', song: null, entryId: null, runId: null },
    confirmedPlayback: { status: 'unknown', reasonCode: 'not_confirmed' },
    playerSnapshot: {
      controlLease: {
        controlEpoch: 7,
        writableControlInstanceId: 'control-b',
        writableConnected: true,
      },
      lease: {
        epoch: 0,
        leaseTarget: null,
        clientKind: null,
        status: 'inactive',
        switchId: null,
      },
      activeFamily: null,
      activeCheckId: null,
    },
  };
  assert.equal(isSafeOutputControlTakeover(base), true);
  assert.equal(isSafeOutputControlTakeover({
    ...base,
    desiredTransport: { ...base.desiredTransport, status: 'stopped' },
    confirmedPlayback: {
      status: 'stopped',
      paused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  }), true);

  for (const unsafe of [
    { confirmedPlayback: { status: 'unknown', reasonCode: 'target_disconnected' } },
    { confirmedPlayback: { status: 'paused', audible: false } },
    { confirmedPlayback: { status: 'stopped', paused: true, sourceDetached: false, autoplayCancelled: true, audible: false } },
    { playerSnapshot: { ...base.playerSnapshot, lease: { ...base.playerSnapshot.lease, leaseTarget: 'stale-player' } } },
    { unknown: true },
  ]) {
    assert.equal(isSafeOutputControlTakeover({ ...base, ...unsafe }), false);
  }
});
