import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBS_MIXER_VERIFICATION_OUTCOMES,
  OBS_MIXER_VERIFICATION_STORAGE_KEY,
  createObsMixerVerification,
  deriveObsMixerVerificationView,
  loadObsMixerVerification,
  parseObsMixerVerification,
  saveObsMixerVerification,
} from '../src/lib/obsMixerVerification.js';

function currentCheck(overrides = {}) {
  return {
    stage: 'progress',
    checkId: 'check-1',
    actualPlayingObserved: true,
    requestObserved: true,
    staleEvidence: false,
    ...overrides,
  };
}

test('OBS mixer confirmation is enabled only after current G2 playing evidence', () => {
  const base = { room: 'room-1', playerInstanceId: 'player-1' };
  assert.equal(deriveObsMixerVerificationView({ ...base }).canConfirm, false);
  assert.equal(deriveObsMixerVerificationView({
    ...base,
    obsAudioCheck: currentCheck({ actualPlayingObserved: false }),
  }).canConfirm, false);
  assert.equal(deriveObsMixerVerificationView({
    ...base,
    obsAudioCheck: currentCheck({ staleEvidence: true }),
  }).canConfirm, false);

  const view = deriveObsMixerVerificationView({ ...base, obsAudioCheck: currentCheck() });
  assert.equal(view.status, 'awaiting_user');
  assert.equal(view.canConfirm, true);
  assert.equal(view.shouldShow, true);
});

test('user-confirmed OBS mixer records are exact, bounded, and locally persistent', () => {
  const record = createObsMixerVerification({
    outcome: OBS_MIXER_VERIFICATION_OUTCOMES.PASSED,
    room: 'room-1',
    playerInstanceId: 'player-1',
    checkId: 'check-1',
    checkedAt: 1234,
  });
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };

  assert.equal(saveObsMixerVerification(storage, record), true);
  assert.equal(data.has(OBS_MIXER_VERIFICATION_STORAGE_KEY), true);
  assert.deepEqual(loadObsMixerVerification(storage), record);
  assert.equal(parseObsMixerVerification('{broken'), null);
  assert.equal(parseObsMixerVerification({ ...record, evidenceLevel: 'measured' }), null);
  assert.equal(parseObsMixerVerification({ ...record, room: '' }), null);
});

test('confirmation remains scoped to one session player and never invents higher evidence', () => {
  const record = createObsMixerVerification({
    outcome: OBS_MIXER_VERIFICATION_OUTCOMES.PASSED,
    room: 'room-1',
    playerInstanceId: 'player-1',
    checkId: 'check-1',
    checkedAt: 1234,
  });
  const passed = deriveObsMixerVerificationView({
    record,
    room: 'room-1',
    playerInstanceId: 'player-1',
  });
  const stale = deriveObsMixerVerificationView({
    record,
    room: 'room-1',
    playerInstanceId: 'player-2',
  });

  assert.deepEqual(passed, {
    status: 'passed',
    messageKey: 'obs.audioCheck.mixerVerification.passed',
    canConfirm: false,
    shouldShow: true,
    checkedAt: 1234,
    evidenceLevel: 'user_confirmed',
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.checkedAt, null);
  assert.equal(stale.evidenceLevel, null);
  assert.equal(Object.hasOwn(passed, 'recording'), false);
  assert.equal(Object.hasOwn(passed, 'stream'), false);
  assert.equal(Object.hasOwn(passed, 'karaokeSync'), false);

  const sameCheck = deriveObsMixerVerificationView({
    record,
    room: 'room-1',
    playerInstanceId: 'player-1',
    obsAudioCheck: currentCheck(),
  });
  const newCheck = deriveObsMixerVerificationView({
    record,
    room: 'room-1',
    playerInstanceId: 'player-1',
    obsAudioCheck: currentCheck({ checkId: 'check-2' }),
  });
  assert.equal(sameCheck.status, 'passed', 'one click must settle the current check');
  assert.equal(newCheck.status, 'awaiting_user', 'a new check may replace the prior confirmation');
});

test('a missing mixer signal is recorded without changing route or playback state', () => {
  const record = createObsMixerVerification({
    outcome: OBS_MIXER_VERIFICATION_OUTCOMES.FAILED,
    room: 'room-1',
    playerInstanceId: 'player-1',
    checkId: 'check-1',
    checkedAt: 1234,
  });
  const view = deriveObsMixerVerificationView({
    record,
    room: 'room-1',
    playerInstanceId: 'player-1',
  });

  assert.equal(view.status, 'failed');
  assert.equal(view.canConfirm, false);
  assert.deepEqual(Object.keys(record).sort(), [
    'checkId', 'checkedAt', 'evidenceLevel', 'outcome', 'playerInstanceId', 'room', 'scope', 'version',
  ]);
});
