import { LYRICS_PACKAGE_SCHEMA_VERSION } from './lyricsSchema.js';

export const LYRICS_PACKAGE_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  maxCues: 2_000,
  maxLinesPerLanguage: 4,
  maxStringLength: 500,
});

const encoder = new TextEncoder();
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => Number.isFinite(value);

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256TextHash(value) {
  return `sha256:${await sha256(String(value ?? '').normalize('NFC'))}`;
}

export async function computeLyricsPackageHash(playbackPackage) {
  const { packageHash: _ignored, ...hashable } = playbackPackage || {};
  return `sha256:${await sha256(canonicalJson(hashable))}`;
}

function validateLines(lines, path, errors) {
  if (!Array.isArray(lines) || lines.length > LYRICS_PACKAGE_LIMITS.maxLinesPerLanguage) {
    errors.push(`${path}:invalid_lines`);
    return;
  }
  lines.forEach((line, index) => {
    if (typeof line !== 'string' || line.length > LYRICS_PACKAGE_LIMITS.maxStringLength) {
      errors.push(`${path}[${index}]:invalid_string`);
    }
  });
}

function validateDisplayDefaults(display, errors) {
  if (!isRecord(display)) {
    errors.push('displayDefaults:required_record');
    return;
  }
  const allowed = new Set([
    'mode', 'canvasWidth', 'canvasHeight', 'positionPreset', 'maxOriginalLines',
    'maxTranslationLines', 'offsetX', 'offsetY', 'areaWidth', 'originalFontSize',
    'translationFontSize', 'fontFamily', 'fontWeight', 'textAlign', 'strokeWidth',
    'shadowStrength', 'opacity',
  ]);
  for (const field of Object.keys(display)) {
    if (!allowed.has(field)) errors.push(`displayDefaults.${field}:unexpected`);
  }
  if (!['original_ko', 'ko_only', 'original_romanized_ko'].includes(display.mode)) {
    errors.push('displayDefaults.mode:unsupported');
  }
  if (!['right_center', 'center', 'lower_third'].includes(display.positionPreset)) {
    errors.push('displayDefaults.positionPreset:unsupported');
  }
  if (!['left', 'center', 'right'].includes(display.textAlign)) {
    errors.push('displayDefaults.textAlign:unsupported');
  }
  for (const [field, min, max] of [
    ['canvasWidth', 320, 3_840], ['canvasHeight', 180, 2_160],
    ['maxOriginalLines', 1, 4], ['maxTranslationLines', 1, 4],
    ['offsetX', -1_920, 1_920], ['offsetY', -1_080, 1_080],
    ['areaWidth', 320, 1_920], ['originalFontSize', 28, 160],
    ['translationFontSize', 22, 140], ['fontWeight', 400, 900],
    ['strokeWidth', 0, 8], ['shadowStrength', 0, 1], ['opacity', 0, 1],
  ]) {
    if (!finite(display[field]) || display[field] < min || display[field] > max) {
      errors.push(`displayDefaults.${field}:invalid_number`);
    }
  }
  if (typeof display.fontFamily !== 'string' || display.fontFamily.length > 256) {
    errors.push('displayDefaults.fontFamily:invalid_string');
  }
}

export function validatePlaybackLyricsPackage(playbackPackage, { expectedHash = null } = {}) {
  const errors = [];
  if (!isRecord(playbackPackage)) return { ok: false, errors: ['$:required_record'] };
  if (playbackPackage.schemaVersion !== LYRICS_PACKAGE_SCHEMA_VERSION) {
    errors.push('schemaVersion:unsupported');
  }
  for (const field of [
    'packageId',
    'packageHash',
    'songWorkId',
    'trackVersionId',
    'cueSheetRevisionId',
    'translationRevisionId',
  ]) {
    if (typeof playbackPackage[field] !== 'string' || !playbackPackage[field]) {
      errors.push(`${field}:required_identifier`);
    }
  }
  if (expectedHash && playbackPackage.packageHash !== expectedHash) errors.push('packageHash:mismatch');
  if (!['tempo_map', 'fixed_ms_fallback'].includes(playbackPackage.timingMode)) {
    errors.push('timingMode:unsupported');
  }
  if (!finite(playbackPackage.durationMs) || playbackPackage.durationMs < 0) {
    errors.push('durationMs:invalid_number');
  }
  if (!Number.isSafeInteger(playbackPackage.ppq) || playbackPackage.ppq <= 0) {
    errors.push('ppq:invalid_integer');
  }
  if (!isRecord(playbackPackage.transitionRule)) errors.push('transitionRule:required_record');
  else {
    for (const field of [
      'fadeStartTicksBeforeAnchor', 'fadeEndTicksBeforeAnchor',
      'fallbackFadeStartMsBeforeAnchor', 'fallbackFadeEndMsBeforeAnchor',
    ]) {
      if (!finite(playbackPackage.transitionRule[field]) || playbackPackage.transitionRule[field] < 0) {
        errors.push(`transitionRule.${field}:invalid_number`);
      }
    }
  }
  validateDisplayDefaults(playbackPackage.displayDefaults, errors);
  if (!Array.isArray(playbackPackage.tempoSegments)) errors.push('tempoSegments:required_array');
  else if (playbackPackage.tempoSegments.length > 1_000) errors.push('tempoSegments:too_many');
  if (!Array.isArray(playbackPackage.cues)) {
    errors.push('cues:required_array');
  } else if (playbackPackage.cues.length > LYRICS_PACKAGE_LIMITS.maxCues) {
    errors.push('cues:too_many');
  } else {
    const ids = new Set();
    let lastAnchor = -1;
    playbackPackage.cues.forEach((cue, index) => {
      const path = `cues[${index}]`;
      if (!isRecord(cue)) {
        errors.push(`${path}:required_record`);
        return;
      }
      if (typeof cue.cueId !== 'string' || !cue.cueId) errors.push(`${path}.cueId:required_identifier`);
      if (ids.has(cue.cueId)) errors.push(`${path}.cueId:duplicate`);
      ids.add(cue.cueId);
      if (!['lyric', 'blank'].includes(cue.kind)) errors.push(`${path}.kind:unsupported`);
      if (!finite(cue.anchorMs) || cue.anchorMs < 0) errors.push(`${path}.anchorMs:invalid_number`);
      if (finite(cue.anchorMs) && cue.anchorMs < lastAnchor) errors.push(`${path}.anchorMs:unordered`);
      lastAnchor = cue.anchorMs;
      if (cue.anchorTick !== null && cue.anchorTick !== undefined
        && (!finite(cue.anchorTick) || cue.anchorTick < 0)) {
        errors.push(`${path}.anchorTick:invalid_number`);
      }
      if (cue.transitionOverride !== null && cue.transitionOverride !== undefined) {
        const override = cue.transitionOverride;
        if (!isRecord(override)
          || !finite(override.fadeStartMs)
          || !finite(override.fadeEndMs)
          || override.fadeStartMs < 0
          || override.fadeEndMs < override.fadeStartMs
          || override.fadeEndMs > cue.anchorMs) {
          errors.push(`${path}.transitionOverride:invalid`);
        }
      }
      validateLines(cue.originalLines, `${path}.originalLines`, errors);
      validateLines(cue.translationLinesKo, `${path}.translationLinesKo`, errors);
      validateLines(cue.romanizationLines || [], `${path}.romanizationLines`, errors);
      const textCount = (cue.originalLines?.length || 0)
        + (cue.translationLinesKo?.length || 0)
        + (cue.romanizationLines?.length || 0);
      if (cue.kind === 'blank' && textCount > 0) errors.push(`${path}:blank_has_text`);
      if (cue.kind === 'lyric' && textCount === 0) errors.push(`${path}:lyric_has_no_text`);
    });
  }
  for (const forbidden of ['rawLyrics', 'lyricDocument', 'translationCandidates', 'providerCache']) {
    if (Object.hasOwn(playbackPackage, forbidden)) errors.push(`${forbidden}:forbidden_projection`);
  }
  const bytes = encoder.encode(JSON.stringify(playbackPackage)).byteLength;
  if (bytes > LYRICS_PACKAGE_LIMITS.maxBytes) errors.push('$:package_too_large');
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), bytes });
}

export async function verifyPlaybackLyricsPackage(playbackPackage, expectedHash = null) {
  const structural = validatePlaybackLyricsPackage(playbackPackage, { expectedHash });
  if (!structural.ok) return structural;
  const calculatedHash = await computeLyricsPackageHash(playbackPackage);
  if (calculatedHash !== playbackPackage.packageHash) {
    return Object.freeze({ ok: false, errors: Object.freeze(['packageHash:mismatch']), bytes: structural.bytes });
  }
  return Object.freeze({ ...structural, calculatedHash });
}

export async function createPlaybackLyricsPackage(input) {
  const candidate = {
    schemaVersion: LYRICS_PACKAGE_SCHEMA_VERSION,
    packageId: input.packageId,
    packageHash: 'sha256:pending',
    songWorkId: input.songWorkId,
    trackVersionId: input.trackVersionId,
    cueSheetRevisionId: input.cueSheetRevisionId,
    translationRevisionId: input.translationRevisionId,
    durationMs: input.durationMs ?? 0,
    timingMode: input.timingMode === 'tempo_map' ? 'tempo_map' : 'fixed_ms_fallback',
    ppq: input.ppq ?? 960,
    transitionRule: {
      fadeStartTicksBeforeAnchor: input.transitionRule?.fadeStartTicksBeforeAnchor ?? (input.ppq ?? 960),
      fadeEndTicksBeforeAnchor: input.transitionRule?.fadeEndTicksBeforeAnchor ?? ((input.ppq ?? 960) / 2),
      fallbackFadeStartMsBeforeAnchor: input.transitionRule?.fallbackFadeStartMsBeforeAnchor ?? 600,
      fallbackFadeEndMsBeforeAnchor: input.transitionRule?.fallbackFadeEndMsBeforeAnchor ?? 300,
    },
    tempoSegments: input.tempoSegments || [],
    cues: input.cues || [],
    displayDefaults: {
      mode: input.displayDefaults?.mode || 'original_ko',
      canvasWidth: input.displayDefaults?.canvasWidth ?? 1920,
      canvasHeight: input.displayDefaults?.canvasHeight ?? 1080,
      positionPreset: input.displayDefaults?.positionPreset || 'right_center',
      maxOriginalLines: input.displayDefaults?.maxOriginalLines ?? 2,
      maxTranslationLines: input.displayDefaults?.maxTranslationLines ?? 2,
      offsetX: input.displayDefaults?.offsetX ?? 0,
      offsetY: input.displayDefaults?.offsetY ?? 0,
      areaWidth: input.displayDefaults?.areaWidth ?? 840,
      originalFontSize: input.displayDefaults?.originalFontSize ?? 62,
      translationFontSize: input.displayDefaults?.translationFontSize ?? 40,
      fontFamily: input.displayDefaults?.fontFamily || 'Inter, Pretendard, "Noto Sans KR", sans-serif',
      fontWeight: input.displayDefaults?.fontWeight ?? 800,
      textAlign: input.displayDefaults?.textAlign || 'right',
      strokeWidth: input.displayDefaults?.strokeWidth ?? 0,
      shadowStrength: input.displayDefaults?.shadowStrength ?? 0.8,
      opacity: input.displayDefaults?.opacity ?? 1,
    },
  };
  candidate.packageHash = await computeLyricsPackageHash(candidate);
  const validation = validatePlaybackLyricsPackage(candidate);
  if (!validation.ok) throw new TypeError(`lyrics_package_invalid:${validation.errors.join(',')}`);
  return Object.freeze(candidate);
}
