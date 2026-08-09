export const LYRICS_SESSION_ASSET_MAX_BYTES = 512 * 1024;
export const LYRICS_SESSION_ASSET_MAX_CUES = 2_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

export const lyricsAssetKey = (room, assetId) => `sessions/${room}/lyrics/${assetId}`;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function packageHash(playbackPackage) {
  const { packageHash: _ignored, ...hashable } = playbackPackage;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(hashable)));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function validateLyricsAssetValue(value, { declaredHash = null } = {}) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['$:required_record'] };
  if (value.schemaVersion !== 1) errors.push('schemaVersion:unsupported');
  if (typeof value.packageId !== 'string' || !value.packageId || value.packageId.length > 256) {
    errors.push('packageId:invalid');
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.packageHash || '')) errors.push('packageHash:invalid');
  if (declaredHash && value.packageHash !== declaredHash) errors.push('packageHash:declared_mismatch');
  if (!Array.isArray(value.cues) || value.cues.length > LYRICS_SESSION_ASSET_MAX_CUES) {
    errors.push('cues:invalid');
  }
  if (!['tempo_map', 'fixed_ms_fallback'].includes(value.timingMode)) errors.push('timingMode:invalid');
  if (errors.length === 0 && await packageHash(value) !== value.packageHash) errors.push('packageHash:mismatch');
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

export async function readLyricsAssetRequest(request) {
  const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return { ok: false, code: 'lyrics_content_type_unsupported' };
  const declaredSize = Number(request.headers.get('X-Rekasong-Size'));
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0
    || declaredSize > LYRICS_SESSION_ASSET_MAX_BYTES) {
    return { ok: false, code: 'lyrics_size_unsupported' };
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength !== declaredSize || body.byteLength > LYRICS_SESSION_ASSET_MAX_BYTES) {
    return { ok: false, code: 'lyrics_size_mismatch' };
  }
  let value;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    return { ok: false, code: 'lyrics_json_invalid' };
  }
  const declaredHash = request.headers.get('X-Rekasong-Hash') || '';
  const validation = await validateLyricsAssetValue(value, { declaredHash });
  if (!validation.ok) return { ok: false, code: 'lyrics_package_invalid', errors: validation.errors };
  return Object.freeze({ ok: true, body, value, size: body.byteLength });
}
