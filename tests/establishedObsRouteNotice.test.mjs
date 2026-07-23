import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveEstablishedObsRouteNotice } from '../src/lib/establishedObsRouteNotice.js';

test('established OBS candidate gaps are actionable notices, not disconnections', () => {
  assert.deepEqual(
    deriveEstablishedObsRouteNotice({
      confirmedOutputMode: 'obs',
      isRouteStable: true,
      candidateState: 'duplicate',
    }),
    {
      code: 'established_obs_duplicate',
      messageKey: 'onair.output.status.obs.duplicateConnected',
      nextActionKey: 'onair.output.nextAction.obs.duplicateConnected',
    },
  );
  assert.deepEqual(
    deriveEstablishedObsRouteNotice({
      confirmedOutputMode: 'obs',
      isRouteStable: true,
      candidateState: 'none',
    }),
    {
      code: 'established_obs_missing',
      messageKey: 'onair.output.status.obs.missingConnected',
      nextActionKey: 'onair.output.nextAction.obs.missingConnected',
    },
  );
});

test('new OBS setup and explicitly hidden-source guidance keep their stricter paths', () => {
  assert.equal(deriveEstablishedObsRouteNotice({
    confirmedOutputMode: 'obs',
    isRouteStable: false,
    candidateState: 'duplicate',
  }), null);
  assert.equal(deriveEstablishedObsRouteNotice({
    confirmedOutputMode: 'obs',
    isRouteStable: true,
    candidateState: 'none',
    sourceInactive: true,
  }), null);
  assert.equal(deriveEstablishedObsRouteNotice({
    confirmedOutputMode: 'speaker',
    isRouteStable: true,
    candidateState: 'duplicate',
  }), null);
});
