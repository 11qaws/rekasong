import assert from 'node:assert/strict';
import test from 'node:test';

import { getAppMessage } from '../src/copy/appMessages.js';
import {
  UserActionError,
  userActionErrorMessage,
} from '../src/lib/userActionError.js';

const translateEnglish = (key, values) => getAppMessage(key, values, 'en');

test('an explicitly marked user action error resolves its semantic translated message', () => {
  const error = new UserActionError('dashboard.drag.historyAdded', { title: 'Fixture' });

  assert.equal(
    userActionErrorMessage(
      error,
      translateEnglish,
      'dashboard.playback.startFailed',
    ),
    getAppMessage('dashboard.drag.historyAdded', { title: 'Fixture' }, 'en'),
  );
});

test('internal, browser, protocol, and absent errors always resolve the translated fallback', () => {
  const expected = getAppMessage('playback.control.toggleFailed', {}, 'en');
  const internalErrors = [
    new Error('observer_reentry'),
    new DOMException('The play() request was interrupted', 'AbortError'),
    { code: 'lease_conflict', message: 'lease_conflict' },
    null,
  ];

  for (const error of internalErrors) {
    assert.equal(
      userActionErrorMessage(
        error,
        translateEnglish,
        'playback.control.toggleFailed',
      ),
      expected,
    );
  }
});

test('message values are copied and frozen at the user-action boundary', () => {
  const values = { title: 'Original' };
  const error = new UserActionError('dashboard.drag.historyAdded', values);
  values.title = 'Changed';

  assert.equal(error.messageValues.title, 'Original');
  assert.throws(() => {
    error.messageValues.title = 'Mutated';
  }, TypeError);
});

test('malformed semantic message contracts are rejected', () => {
  assert.throws(() => new UserActionError('observer_reentry'), TypeError);
  assert.throws(() => new UserActionError('valid.key', []), TypeError);
  assert.throws(
    () => userActionErrorMessage(new Error('x'), translateEnglish, 'not_semantic'),
    TypeError,
  );
});
