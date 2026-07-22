import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUXILIARY_CONTROL_COMMAND_TYPES,
  CONTROL_COMMAND_TYPES,
  ROUTE_COMMAND_TYPES,
  RUN_COMMAND_TYPES,
  TEST_COMMAND_TYPES,
} from '../src/lib/onAirProtocol.js';

const FORBIDDEN_BROADCAST_COMMANDS = [
  'start_streaming',
  'stop_streaming',
  'start_recording',
  'stop_recording',
];

test('On-Air protocol has media controls but no OBS broadcast or recording authority', () => {
  const commands = new Set([
    ...Object.values(RUN_COMMAND_TYPES),
    ...Object.values(ROUTE_COMMAND_TYPES),
    ...Object.values(TEST_COMMAND_TYPES),
    ...Object.values(CONTROL_COMMAND_TYPES),
    ...Object.values(AUXILIARY_CONTROL_COMMAND_TYPES),
  ]);

  assert.equal(commands.has('load'), true);
  assert.equal(commands.has('stop'), true);
  for (const forbidden of FORBIDDEN_BROADCAST_COMMANDS) {
    assert.equal(commands.has(forbidden), false, `${forbidden} must never enter the app protocol`);
  }
});

test('Worker command allowlists cannot relay OBS broadcast or recording commands', async () => {
  const worker = await readFile(
    new URL('../workers/rekasong-session/src/index.js', import.meta.url),
    'utf8',
  );

  for (const forbidden of FORBIDDEN_BROADCAST_COMMANDS) {
    assert.doesNotMatch(worker, new RegExp(`['"]${forbidden}['"]`));
  }
});
