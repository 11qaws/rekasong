import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PrepareQueue,
  prepareWakeFrame,
} from '../workers/rekasong-session/src/index.js';

test('prepare wake frame is a stable versioned non-authoritative hint', () => {
  assert.deepEqual(JSON.parse(prepareWakeFrame('app_active', 1234)), {
    type: 'prepare.wake',
    version: 1,
    reason: 'app_active',
    sentAt: 1234,
  });
});

test('app activity and enqueue wake every connected prepare worker', async () => {
  const frames = [];
  const jobs = new Map();
  const sockets = Array.from({ length: 2 }, () => {
    let attachment = {};
    return {
      send: (frame) => frames.push(JSON.parse(frame)),
      deserializeAttachment: () => attachment,
      serializeAttachment: (value) => {
        attachment = value;
      },
    };
  });
  const queue = new PrepareQueue({
    storage: {
      put: async (key, value) => jobs.set(key, value),
    },
    getWebSockets: (tag) => {
      assert.equal(tag, 'prepare-worker');
      return sockets;
    },
  }, {});

  assert.equal(queue.lastActivityWakeAt, 0);
  const activityResponse = queue.noteAppActivity();
  assert.equal(activityResponse.status, 204);
  assert.deepEqual(frames.map((frame) => frame.reason), ['app_active', 'app_active']);
  const duplicateActivityResponse = queue.noteAppActivity();
  assert.equal(duplicateActivityResponse.status, 204);
  assert.deepEqual(
    frames.map((frame) => frame.reason),
    ['app_active', 'app_active'],
    'activity wake must be globally coalesced during the cooldown',
  );

  const rehydratedQueue = new PrepareQueue({
    storage: queue.ctx.storage,
    getWebSockets: queue.ctx.getWebSockets,
  }, {});
  rehydratedQueue.noteAppActivity();
  assert.deepEqual(
    frames.map((frame) => frame.reason),
    ['app_active', 'app_active'],
    'activity cooldown must survive Durable Object hibernation',
  );

  const job = await queue.enqueue('abcdefghijk', null);
  assert.equal(job.status, 'queued');
  assert.equal(jobs.get('job:abcdefghijk').status, 'queued');
  assert.deepEqual(frames.map((frame) => frame.reason), [
    'app_active',
    'app_active',
    'job_enqueued',
    'job_enqueued',
  ]);
});

test('prepare wake routes keep browser and worker authentication boundaries separate', async () => {
  const source = await readFile(
    new URL('../workers/rekasong-session/src/index.js', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /url\.pathname === '\/v1\/prepare\/activity' && request\.method === 'POST'/,
  );
  assert.match(
    source,
    /url\.pathname === '\/v1\/prepare\/wake' && request\.method === 'GET'/,
  );
  assert.match(source, /await this\.verifyWorker\(request\)/);
  assert.match(source, /this\.ctx\.acceptWebSocket\(server, \[PREPARE_WAKE_WORKER_TAG\]\)/);
  assert.match(source, /socket\.deserializeAttachment\?\.\(\)/);
  assert.match(source, /lastActivityWakeAt/);
  assert.match(source, /this\.signalWorkers\('job_enqueued'\)/);
});
