import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  OBS_PENDING_STOP_ACTIONS,
  isConfirmedDiscardSnapshot,
  isConfirmedDiscardStop,
  isConfirmedPendingObsStop,
  isConfirmedPendingObsStopSnapshot,
  pendingObsStopAction,
} from '../src/lib/dashboardPlaybackSafety.js';

const fixture = {
  protocolVersion: 2,
  event: { type: 'stopped', sessionId: 'run-a' },
  active: {
    entryId: 'entry-a',
    runId: 'run-a',
    phase: 'discarding',
    discardRequested: true,
  },
  currentEntry: { entryId: 'entry-a' },
};

test('discard finalizes only for the exact Protocol v2 strong-stop relay', () => {
  assert.equal(isConfirmedDiscardStop(fixture), true);

  for (const unsafe of [
    { protocolVersion: 1 },
    { event: { type: 'paused', sessionId: 'run-a' } },
    { event: { type: 'stopped', sessionId: 'run-old' } },
    { active: { ...fixture.active, discardRequested: false } },
    { active: { ...fixture.active, entryId: 'entry-old' } },
    { currentEntry: null },
  ]) {
    assert.equal(isConfirmedDiscardStop({ ...fixture, ...unsafe }), false);
  }
});

test('authoritative strong-stop snapshot can recover a missed relay event', () => {
  const snapshotFixture = {
    confirmedPlayback: {
      status: 'stopped',
      entryId: 'entry-a',
      runId: 'run-a',
      paused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
    active: fixture.active,
    currentEntry: fixture.currentEntry,
  };
  assert.equal(isConfirmedDiscardSnapshot(snapshotFixture), true);

  for (const unsafe of [
    { confirmedPlayback: { ...snapshotFixture.confirmedPlayback, status: 'paused' } },
    { confirmedPlayback: { ...snapshotFixture.confirmedPlayback, runId: 'run-old' } },
    { confirmedPlayback: { ...snapshotFixture.confirmedPlayback, sourceDetached: false } },
    { confirmedPlayback: { ...snapshotFixture.confirmedPlayback, audible: true } },
    { active: { ...fixture.active, discardRequested: false } },
  ]) {
    assert.equal(isConfirmedDiscardSnapshot({ ...snapshotFixture, ...unsafe }), false);
  }
});

test('completion waits for the exact current-run strong stop, including after a timeout', () => {
  const completion = {
    ...fixture,
    active: {
      ...fixture.active,
      phase: 'stop_unconfirmed',
      pendingStopAction: OBS_PENDING_STOP_ACTIONS.COMPLETE,
      pendingCompletionReason: 'skipped',
      pendingNextEntryId: 'entry-b',
      discardRequested: false,
    },
  };
  assert.equal(pendingObsStopAction(completion.active), OBS_PENDING_STOP_ACTIONS.COMPLETE);
  assert.equal(isConfirmedPendingObsStop(completion), true);

  const confirmedPlayback = {
    status: 'stopped',
    entryId: 'entry-a',
    runId: 'run-a',
    paused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  };
  assert.equal(isConfirmedPendingObsStopSnapshot({
    confirmedPlayback,
    active: completion.active,
    currentEntry: completion.currentEntry,
  }), true);

  for (const unsafe of [
    { event: { type: 'ended', sessionId: 'run-a' } },
    { event: { type: 'stopped', sessionId: 'run-old' } },
    { active: { ...completion.active, pendingStopAction: null } },
    { currentEntry: { entryId: 'entry-old' } },
  ]) {
    assert.equal(isConfirmedPendingObsStop({ ...completion, ...unsafe }), false);
  }
  for (const unsafeProof of [
    { ...confirmedPlayback, status: 'ended' },
    { ...confirmedPlayback, paused: false },
    { ...confirmedPlayback, sourceDetached: false },
    { ...confirmedPlayback, autoplayCancelled: false },
    { ...confirmedPlayback, audible: true },
    { ...confirmedPlayback, runId: 'run-old' },
  ]) {
    assert.equal(isConfirmedPendingObsStopSnapshot({
      confirmedPlayback: unsafeProof,
      active: completion.active,
      currentEntry: completion.currentEntry,
    }), false);
  }
});

test('Dashboard observes one normalized strong-stop proof for completion and discard', async () => {
  const source = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /const confirmedObsPlayback = outputControl\.snapshot\?\.confirmedPlayback[\s\S]*?\?\? outputControl\.snapshot\?\.playerSnapshot\?\.confirmedPlayback/,
  );
  assert.match(
    source,
    /isConfirmedPendingObsStopSnapshot\(\{[\s\S]*?confirmedPlayback: confirmedObsPlayback[\s\S]*?\}\)[\s\S]*?active\?\.pendingStopAction[\s\S]*?confirmedObsPlayback[\s\S]*?currentEntry\?\.entryId/,
    'completion/discard recovery must recheck when either strong-stop proof or the local intent arrives first',
  );
  assert.match(
    source,
    /if \(act\?\.outputMode !== 'obs'\)[\s\S]*?finalizeConfirmedCompletion\(marker, completionReason\)[\s\S]*?requestPendingObsStop\(\{[\s\S]*?OBS_PENDING_STOP_ACTIONS\.COMPLETE/,
    'an OBS ended event must request strong stop instead of immediately completing the song',
  );
  assert.match(
    source,
    /if \(useOnAirPlayer && act\?\.outputMode === 'obs'\)[\s\S]*?requestPendingObsStop\(\{[\s\S]*?pendingNextEntryId: nextEntry\?\.entryId/,
    'an OBS skip must preserve the current song and selected next entry behind the stop barrier',
  );
  assert.match(
    source,
    /const finalizationKey = `\$\{act\.entryId\}\\u0000\$\{act\.runId\}`[\s\S]*?finalizedPendingObsStopKeyRef\.current === finalizationKey[\s\S]*?finalizedPendingObsStopKeyRef\.current = finalizationKey/,
    'snapshot and relayed stopped evidence must not start the next track twice',
  );
});
