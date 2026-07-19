const REDACTED = '[REDACTED]';
const MAX_SANITIZE_DEPTH = 8;
const MAX_SANITIZE_NODES = 2_048;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s<>"'`\\]+/giu;
const PLAIN_ASSIGNMENT_PATTERN = /(^|[?&#;])([^?&#;=\s]{1,128})=([^?&#;\s]*)/giu;
const ENCODED_ASSIGNMENT_PATTERN = /(%(?:25)?3[fF]|%(?:25)?26)([^%&#;\s]{1,128})(%(?:25)?3[dD])((?:(?!%(?:25)?26|%(?:25)?23)[^\s&#;])*)/giu;
const JSON_STRING_ASSIGNMENT_PATTERN = /(["'])([^"'\\]{1,128})\1(\s*:\s*)(["'])((?:\\.|(?!\4)[^\\])*)\4/giu;

function safeDecode(value) {
  let current = String(value ?? '');
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function sensitiveKey(key) {
  const normalized = safeDecode(key).toLowerCase().replace(/[^a-z0-9]/gu, '');
  return [
    'token',
    'key',
    'auth',
    'authorization',
    'secret',
    'credential',
    'password',
    'passwd',
    'signature',
  ].some((term) => normalized === term
    || normalized.startsWith(term)
    || normalized.endsWith(term));
}

function secretVariants(secret) {
  const variants = new Set();
  let current = String(secret ?? '');
  if (!current) return variants;
  variants.add(current);
  for (let index = 0; index < 3; index += 1) {
    current = encodeURIComponent(current);
    variants.add(current);
  }
  return variants;
}

function replaceAllLiteral(value, needle, replacement) {
  return needle ? value.split(needle).join(replacement) : value;
}

/**
 * Fail-closed diagnostic sanitizer for executable OBS smoke harnesses.
 *
 * It deliberately redacts more than the production protocol requires. Harness
 * diagnostics may contain browser URLs, nested `api=` URLs, serialized command
 * bodies, and Error stacks, so preserving a questionable value is never worth
 * exposing a session credential in CI logs.
 */
export function createHarnessDiagnosticSanitizer(initialSecrets = []) {
  const secrets = new Set();
  const variants = new Set();

  const registerSecret = (secret) => {
    if (typeof secret !== 'string' || secret.length === 0) return;
    secrets.add(secret);
    for (const variant of secretVariants(secret)) variants.add(variant);
  };
  for (const secret of initialSecrets) registerSecret(secret);

  const maskKnownSecrets = (input) => {
    let output = String(input ?? '');
    const ordered = [...variants].sort((left, right) => right.length - left.length);
    for (const variant of ordered) output = replaceAllLiteral(output, variant, REDACTED);
    return output;
  };

  const sanitizeAssignments = (input) => maskKnownSecrets(input)
    .replace(
      JSON_STRING_ASSIGNMENT_PATTERN,
      (match, keyQuote, key, separator, valueQuote, value) => (
        sensitiveKey(key)
          ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`
          : `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${maskKnownSecrets(value)}${valueQuote}`
      ),
    )
    .replace(PLAIN_ASSIGNMENT_PATTERN, (match, delimiter, key, value) => (
      sensitiveKey(key)
        ? `${delimiter}${key}=${REDACTED}`
        : `${delimiter}${key}=${maskKnownSecrets(value)}`
    ))
    .replace(ENCODED_ASSIGNMENT_PATTERN, (match, delimiter, key, equals, value) => (
      sensitiveKey(key)
        ? `${delimiter}${key}${equals}${encodeURIComponent(REDACTED)}`
        : `${delimiter}${key}${equals}${maskKnownSecrets(value)}`
    ));

  const sanitizeUrl = (input, depth, sanitizeText) => {
    if (depth > MAX_SANITIZE_DEPTH) return REDACTED;
    let url;
    try {
      url = new URL(String(input));
    } catch {
      return sanitizeAssignments(input);
    }
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    const entries = [...url.searchParams.entries()];
    url.search = '';
    for (const [key, value] of entries) {
      url.searchParams.append(
        key,
        sensitiveKey(key) ? REDACTED : sanitizeText(value, depth + 1),
      );
    }
    if (url.hash) {
      const hash = url.hash.slice(1);
      const questionIndex = hash.indexOf('?');
      if (questionIndex >= 0) {
        const route = hash.slice(0, questionIndex);
        const parameters = new URLSearchParams(hash.slice(questionIndex + 1));
        const sanitized = new URLSearchParams();
        for (const [key, value] of parameters.entries()) {
          sanitized.append(
            key,
            sensitiveKey(key) ? REDACTED : sanitizeText(value, depth + 1),
          );
        }
        url.hash = `${route}?${sanitized.toString()}`;
      } else {
        url.hash = sanitizeAssignments(hash);
      }
    }
    return maskKnownSecrets(url.toString());
  };

  const sanitizeText = (input, depth = 0) => {
    if (depth > MAX_SANITIZE_DEPTH) return REDACTED;
    let output = sanitizeAssignments(input);
    output = output.replace(URL_PATTERN, (candidate) => {
      let suffix = '';
      let core = candidate;
      while (/[),.\]}]$/u.test(core)) {
        suffix = core.slice(-1) + suffix;
        core = core.slice(0, -1);
      }
      return sanitizeUrl(core, depth + 1, sanitizeText) + suffix;
    });
    return sanitizeAssignments(maskKnownSecrets(output));
  };

  const sanitizeValue = (value, state = { depth: 0, nodes: 0, seen: new WeakSet() }) => {
    if (state.depth > MAX_SANITIZE_DEPTH || state.nodes >= MAX_SANITIZE_NODES) return REDACTED;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return sanitizeText(value, state.depth);
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'undefined') return null;
    if (typeof value !== 'object') return sanitizeText(String(value), state.depth);
    if (state.seen.has(value)) return '[CIRCULAR]';
    state.seen.add(value);
    state.nodes += 1;
    const nextState = { ...state, depth: state.depth + 1 };
    if (value instanceof Error) {
      return {
        name: sanitizeText(value.name, state.depth),
        message: sanitizeText(value.message, state.depth),
        stack: sanitizeText(value.stack || '', state.depth),
        ...(typeof value.code === 'string' ? { code: sanitizeText(value.code, state.depth) } : {}),
        ...('detail' in value ? { detail: sanitizeValue(value.detail, nextState) } : {}),
        ...('cause' in value ? { cause: sanitizeValue(value.cause, nextState) } : {}),
      };
    }
    if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, nextState));
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = sanitizeText(key, state.depth);
      output[safeKey] = sensitiveKey(key) ? REDACTED : sanitizeValue(entry, nextState);
    }
    return output;
  };

  const json = (value) => {
    try {
      return JSON.stringify(sanitizeValue(value));
    } catch {
      return '"[DIAGNOSTIC_REDACTION_FAILED]"';
    }
  };

  const errorText = (error) => {
    try {
      if (error instanceof Error) return sanitizeText(error.stack || error.message || error.name);
      return sanitizeText(typeof error === 'string' ? error : json(error));
    } catch {
      return '[DIAGNOSTIC_REDACTION_FAILED]';
    }
  };

  const assertSafe = (value) => {
    const output = typeof value === 'string' ? value : json(value);
    for (const secret of secrets) {
      for (const variant of secretVariants(secret)) {
        if (variant && output.includes(variant)) {
          throw new Error('diagnostic sanitizer self-check failed');
        }
      }
    }
    return output;
  };

  const selfCheck = () => {
    const control = 'sanitizer-control-poison';
    const player = 'sanitizer-player-poison';
    registerSecret(control);
    registerSecret(player);
    const nested = `https://${control}:${player}@worker.invalid/v1?auth=${control}`;
    const poison = {
      token: control,
      info: `INFO https://${control}:${player}@app.invalid/#/widget?token=${player}`,
      query: `https://app.invalid/?apiKey=${control}&ok=kept#auth=${player}`,
      nestedApi: `https://app.invalid/#/widget?api=${encodeURIComponent(nested)}&token=${player}`,
      body: { authorization: `Bearer ${control}`, nested: { playerToken: player } },
      error: Object.assign(new Error(`failed ${nested}`), {
        detail: { url: nested, token: player },
      }),
    };
    const registeredPoison = [...secrets].map((secret, index) => ({
      raw: secret,
      encoded: encodeURIComponent(secret),
      url: `https://worker.invalid/v1?token=${encodeURIComponent(secret)}&slot=${index}`,
      nested: `https://app.invalid/#/widget?api=${encodeURIComponent(
        `https://worker.invalid/v1?auth=${encodeURIComponent(secret)}`,
      )}`,
      body: { authorization: `Bearer ${secret}`, playerToken: secret },
      error: new Error(`credential ${secret}`),
    }));
    const output = json({ poison, registeredPoison });
    assertSafe(output);
    for (const secret of secrets) {
      for (const variant of secretVariants(secret)) {
        if (variant && output.includes(variant)) {
          throw new Error('diagnostic sanitizer self-check failed');
        }
      }
    }
    return true;
  };

  return Object.freeze({
    registerSecret,
    text: sanitizeText,
    value: sanitizeValue,
    json,
    errorText,
    assertSafe,
    selfCheck,
  });
}

export const HARNESS_REDACTED_VALUE = REDACTED;

/**
 * Format a response parse failure without ever copying the untrusted body.
 * Session credentials cannot be registered until parsing succeeds, so no
 * sanitizer can safely infer every secret shape in a malformed response.
 */
export function omittedHttpBodyErrorMessage({ operation, status, body } = {}) {
  const safeOperation = typeof operation === 'string' && /^[a-z][a-z0-9 _-]{0,63}$/iu.test(operation)
    ? operation
    : 'request';
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 'unknown';
  const byteLength = new TextEncoder().encode(typeof body === 'string' ? body : '').byteLength;
  return `${safeOperation} returned non-JSON HTTP ${safeStatus}`
    + ` (response body omitted; ${byteLength} bytes)`;
}
