const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

// Only errors deliberately created at a user-action boundary may select their
// own message. Browser, transport, and protocol exceptions always use the
// caller's translated recovery fallback instead of leaking internal details.
export class UserActionError extends Error {
  constructor(messageKey, messageValues = {}) {
    if (!MESSAGE_KEY_PATTERN.test(messageKey) || !isRecord(messageValues)) {
      throw new TypeError('invalid_user_action_error');
    }
    super(messageKey);
    this.name = 'UserActionError';
    this.messageKey = messageKey;
    this.messageValues = Object.freeze({ ...messageValues });
  }
}

export function userActionErrorMessage(
  error,
  translate,
  fallbackKey,
  fallbackValues = {},
) {
  if (
    typeof translate !== 'function'
    || !MESSAGE_KEY_PATTERN.test(fallbackKey)
    || !isRecord(fallbackValues)
  ) {
    throw new TypeError('invalid_user_action_error_message');
  }

  if (error instanceof UserActionError) {
    return translate(error.messageKey, error.messageValues);
  }
  return translate(fallbackKey, fallbackValues);
}
