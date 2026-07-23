import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  isConfirmedDiscardSnapshot,
  isConfirmedDiscardStop,
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

test('Dashboard observes the normalized root-or-player strong-stop proof', async () => {
  const source = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /const confirmedObsPlayback = outputControl\.snapshot\?\.confirmedPlayback[\s\S]*?\?\? outputControl\.snapshot\?\.playerSnapshot\?\.confirmedPlayback/,
  );
  assert.match(
    source,
    /isConfirmedDiscardSnapshot\(\{[\s\S]*?confirmedPlayback: confirmedObsPlayback[\s\S]*?\}\)[\s\S]*?active\?\.discardRequested[\s\S]*?confirmedObsPlayback[\s\S]*?currentEntry\?\.entryId/,
    'discard recovery must recheck when either strong-stop proof or the local discard intent arrives first',
  );
});
