import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_OUTPUT_VOLUME,
  LEGACY_OUTPUT_VOLUME_STORAGE_KEY,
  OUTPUT_VOLUME_PROFILES_STORAGE_KEY,
  createOutputVolumeProfiles,
  loadOutputVolumeProfiles,
  outputVolumeForMode,
  saveOutputVolumeProfiles,
  updateOutputVolumeProfile,
} from '../src/lib/outputVolumeProfiles.js';

function storageHarness(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test('legacy single volume migrates to both outputs without a sudden gain change', () => {
  const storage = storageHarness({ [LEGACY_OUTPUT_VOLUME_STORAGE_KEY]: '37' });
  assert.deepEqual(loadOutputVolumeProfiles(storage), {
    version: 1,
    speaker: 37,
    obs: 37,
  });
});

test('Speaker and OBS volume profiles change independently', () => {
  const initial = createOutputVolumeProfiles({ speaker: 25, obs: 84 });
  const speakerChanged = updateOutputVolumeProfile(initial, 'speaker', 42);
  const obsChanged = updateOutputVolumeProfile(speakerChanged, 'obs', 73);

  assert.deepEqual(speakerChanged, { version: 1, speaker: 42, obs: 84 });
  assert.deepEqual(obsChanged, { version: 1, speaker: 42, obs: 73 });
  assert.equal(outputVolumeForMode(obsChanged, 'speaker'), 42);
  assert.equal(outputVolumeForMode(obsChanged, 'obs'), 73);
});

test('stored profiles take precedence over legacy volume and remain bounded', () => {
  const storage = storageHarness({
    [LEGACY_OUTPUT_VOLUME_STORAGE_KEY]: '12',
    [OUTPUT_VOLUME_PROFILES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      speaker: -4,
      obs: 140,
    }),
  });
  assert.deepEqual(loadOutputVolumeProfiles(storage), {
    version: 1,
    speaker: 0,
    obs: 100,
  });
});

test('damaged or unavailable storage falls back without throwing', () => {
  const damaged = storageHarness({
    [OUTPUT_VOLUME_PROFILES_STORAGE_KEY]: '{broken',
    [LEGACY_OUTPUT_VOLUME_STORAGE_KEY]: 'not-a-number',
  });
  assert.deepEqual(loadOutputVolumeProfiles(damaged), {
    version: 1,
    speaker: DEFAULT_OUTPUT_VOLUME,
    obs: DEFAULT_OUTPUT_VOLUME,
  });

  const unavailable = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
  };
  assert.deepEqual(loadOutputVolumeProfiles(unavailable), {
    version: 1,
    speaker: DEFAULT_OUTPUT_VOLUME,
    obs: DEFAULT_OUTPUT_VOLUME,
  });
  assert.equal(saveOutputVolumeProfiles(unavailable, { speaker: 10, obs: 20 }), false);
});

test('saving writes only the versioned profile and preserves the rollback key', () => {
  const storage = storageHarness({ [LEGACY_OUTPUT_VOLUME_STORAGE_KEY]: '55' });
  assert.equal(saveOutputVolumeProfiles(storage, { speaker: 23, obs: 91 }), true);
  assert.equal(storage.values.get(LEGACY_OUTPUT_VOLUME_STORAGE_KEY), '55');
  assert.deepEqual(JSON.parse(storage.values.get(OUTPUT_VOLUME_PROFILES_STORAGE_KEY)), {
    version: 1,
    speaker: 23,
    obs: 91,
  });
});
