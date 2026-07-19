import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRoom } from '../workers/rekasong-session/src/index.js';

class MemoryStorage {
  constructor(session, events) {
    this.values = new Map([
      ['session', structuredClone(session)],
      ['terminal-checkpoint', { retainedUntilCleanup: true }],
    ]);
    this.events = events;
    this.alarm = null;
    this.setAlarmCalls = [];
    this.deleteAllCalls = 0;
    this.failNextSetAlarm = null;
    this.failNextDeleteAll = null;
  }

  async get(key) {
    return this.values.get(key);
  }

  async setAlarm(value) {
    this.setAlarmCalls.push(value);
    this.events.push({ type: 'storage.setAlarm', value });
    if (this.failNextSetAlarm) {
      const error = this.failNextSetAlarm;
      this.failNextSetAlarm = null;
      throw error;
    }
    this.alarm = value;
  }

  async deleteAll() {
    this.deleteAllCalls += 1;
    this.events.push({ type: 'storage.deleteAll' });
    if (this.failNextDeleteAll) {
      const error = this.failNextDeleteAll;
      this.failNextDeleteAll = null;
      throw error;
    }
    this.values.clear();
  }
}

class MemoryBucket {
  constructor(events) {
    this.events = events;
    this.deleteCalls = [];
    this.failNextDelete = null;
  }

  async delete(keys) {
    const copiedKeys = [...keys];
    this.deleteCalls.push(copiedKeys);
    this.events.push({ type: 'r2.delete', keys: copiedKeys });
    if (this.failNextDelete) {
      const error = this.failNextDelete;
      this.failNextDelete = null;
      throw error;
    }
  }
}

function endedSession(cleanupAt) {
  return {
    room: 'cleanup-room',
    status: 'ended',
    endedAt: cleanupAt - (10 * 60 * 1000),
    cleanupAt,
    assets: {
      intro: { key: 'sessions/cleanup-room/intro.wav' },
      outro: { key: 'sessions/cleanup-room/outro.wav' },
    },
    transport: { status: 'stopped', song: null, sessionId: null, position: 0, volume: 100 },
    display: { currentSong: null, history: [] },
  };
}

function createCleanupHarness(cleanupAt) {
  const events = [];
  const session = endedSession(cleanupAt);
  const storage = new MemoryStorage(session, events);
  const bucket = new MemoryBucket(events);
  const context = {
    storage,
    getWebSockets() {
      return [];
    },
  };
  // Leave sessionState empty: the alarm must bootstrap from durable storage as
  // it would after the object instance was evicted and later re-created.
  const room = new SessionRoom(context, { MEDIA_BUCKET: bucket });
  return { events, session, storage, bucket, room };
}

test('final cleanup waits until the exact cleanupAt boundary, then deletes R2 before terminal storage', async () => {
  const originalNow = Date.now;
  const cleanupAt = originalNow() + 60_000;
  const harness = createCleanupHarness(cleanupAt);

  try {
    Date.now = () => cleanupAt - 1;
    await harness.room.alarm();

    assert.deepEqual(harness.storage.setAlarmCalls, [cleanupAt]);
    assert.equal(harness.storage.alarm, cleanupAt);
    assert.deepEqual(harness.bucket.deleteCalls, []);
    assert.equal(harness.storage.deleteAllCalls, 0);
    assert.deepEqual(harness.storage.values.get('session'), harness.session);

    // Cloudflare consumes the scheduled alarm before invoking alarm().
    Date.now = () => cleanupAt;
    harness.storage.alarm = null;
    await harness.room.alarm();

    assert.deepEqual(harness.bucket.deleteCalls, [[
      'sessions/cleanup-room/intro.wav',
      'sessions/cleanup-room/outro.wav',
    ]]);
    assert.equal(harness.storage.deleteAllCalls, 1);
    assert.equal(harness.storage.values.size, 0);
    assert.equal(harness.room.sessionState, null);
    assert.deepEqual(harness.events.slice(-2), [
      {
        type: 'r2.delete',
        keys: ['sessions/cleanup-room/intro.wav', 'sessions/cleanup-room/outro.wav'],
      },
      { type: 'storage.deleteAll' },
    ]);
  } finally {
    Date.now = originalNow;
  }
});

test('a failed premature cleanup re-arm propagates without deleting assets or durable state', async () => {
  const cleanupAt = Date.now() + 60_000;
  const harness = createCleanupHarness(cleanupAt);
  harness.storage.failNextSetAlarm = new Error('cleanup_alarm_rearm_failure');

  await assert.rejects(harness.room.alarm(), /cleanup_alarm_rearm_failure/);

  assert.deepEqual(harness.storage.setAlarmCalls, [cleanupAt]);
  assert.deepEqual(harness.bucket.deleteCalls, []);
  assert.equal(harness.storage.deleteAllCalls, 0);
  assert.deepEqual(harness.storage.values.get('session'), harness.session);
  assert.equal(harness.room.sessionState.status, 'ended');

  await harness.room.alarm();
  assert.deepEqual(harness.storage.setAlarmCalls, [cleanupAt, cleanupAt]);
  assert.equal(harness.storage.alarm, cleanupAt);
});

test('final cleanup failures retain terminal state and a redelivery completes idempotently', async (t) => {
  await t.test('R2 deletion failure never reaches storage.deleteAll', async () => {
    const harness = createCleanupHarness(Date.now() - 1);
    harness.bucket.failNextDelete = new Error('r2_delete_failure');

    await assert.rejects(harness.room.alarm(), /r2_delete_failure/);

    assert.equal(harness.bucket.deleteCalls.length, 1);
    assert.equal(harness.storage.deleteAllCalls, 0);
    assert.deepEqual(harness.storage.values.get('session'), harness.session);
    assert.equal(harness.room.sessionState.status, 'ended');

    await harness.room.alarm();
    assert.equal(harness.bucket.deleteCalls.length, 2);
    assert.equal(harness.storage.deleteAllCalls, 1);
    assert.equal(harness.storage.values.size, 0);
    assert.equal(harness.room.sessionState, null);
  });

  await t.test('storage deletion failure retains the session for an idempotent retry', async () => {
    const harness = createCleanupHarness(Date.now() - 1);
    harness.storage.failNextDeleteAll = new Error('storage_delete_failure');

    await assert.rejects(harness.room.alarm(), /storage_delete_failure/);

    assert.equal(harness.bucket.deleteCalls.length, 1);
    assert.equal(harness.storage.deleteAllCalls, 1);
    assert.deepEqual(harness.storage.values.get('session'), harness.session);
    assert.equal(harness.room.sessionState.status, 'ended');

    await harness.room.alarm();
    assert.equal(harness.bucket.deleteCalls.length, 2);
    assert.equal(harness.storage.deleteAllCalls, 2);
    assert.equal(harness.storage.values.size, 0);
    assert.equal(harness.room.sessionState, null);
  });
});
