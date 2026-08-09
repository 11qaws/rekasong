export const LYRICS_PACKAGE_SCHEMA_VERSION = 1;
export const LYRICS_REPOSITORY_SCHEMA_VERSION = 1;

export const LYRICS_SOURCE_TIERS = Object.freeze([
  'user_locked',
  'official_same_release',
  'official_same_work',
  'community_consensus',
  'trusted_web',
  'machine_contextual',
  'machine_literal',
]);

export const LYRICS_STATUS = Object.freeze({
  NONE: 'none',
  IDENTIFYING: 'identifying',
  COLLECTING: 'collecting',
  CANDIDATE_REVIEW: 'candidate_review',
  TIMING: 'timing',
  READY: 'ready',
  FAILED: 'failed',
});

const boundedText = (value, max = 512) => String(value ?? '').trim().slice(0, max);
const boundedId = (value) => {
  const id = boundedText(value, 256);
  const hasControlCharacter = [...id]
    .some((character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127);
  return id && !hasControlCharacter ? id : null;
};

export function sanitizeLyricsRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== LYRICS_PACKAGE_SCHEMA_VERSION) return null;
  const packageId = boundedId(value.packageId);
  const packageHash = /^sha256:[a-f0-9]{64}$/u.test(value.packageHash || '')
    ? value.packageHash
    : null;
  if (!packageId || !packageHash) return null;
  const status = Object.values(LYRICS_STATUS).includes(value.status)
    ? value.status
    : LYRICS_STATUS.READY;
  return {
    packageId,
    packageHash,
    schemaVersion: LYRICS_PACKAGE_SCHEMA_VERSION,
    status,
    requireLyrics: value.requireLyrics === true,
    timingMode: value.timingMode === 'tempo_map' ? 'tempo_map' : 'fixed_ms_fallback',
    ...(boundedId(value.songWorkId) ? { songWorkId: boundedId(value.songWorkId) } : {}),
    ...(boundedId(value.trackVersionId) ? { trackVersionId: boundedId(value.trackVersionId) } : {}),
    ...(boundedId(value.cueSheetRevisionId)
      ? { cueSheetRevisionId: boundedId(value.cueSheetRevisionId) }
      : {}),
    ...(boundedId(value.assetId) ? { assetId: boundedId(value.assetId) } : {}),
    ...(boundedId(value.sessionRoom) ? { sessionRoom: boundedId(value.sessionRoom) } : {}),
  };
}

export function createSongWork({
  songWorkId,
  canonicalTitle,
  canonicalArtist,
  artistAliases = [],
  titleAliases = [],
  originalLanguage = 'und',
  identityStatus = 'confirmed',
  identityEvidence = [],
  now = Date.now(),
} = {}) {
  return Object.freeze({
    songWorkId: boundedId(songWorkId),
    canonicalTitle: boundedText(canonicalTitle, 240),
    canonicalArtist: boundedText(canonicalArtist, 240),
    artistAliases: artistAliases.map((item) => boundedText(item, 240)).filter(Boolean).slice(0, 32),
    titleAliases: titleAliases.map((item) => boundedText(item, 240)).filter(Boolean).slice(0, 32),
    originalLanguage: boundedText(originalLanguage, 16) || 'und',
    album: null,
    trackNumber: null,
    identityStatus,
    identityEvidence: identityEvidence.slice(0, 32),
    createdAt: now,
    updatedAt: now,
  });
}

export function createTrackVersion({
  trackVersionId,
  songWorkId,
  sourceType = 'local',
  sourceIdentity = '',
  durationMs = 0,
  versionKind = 'unknown',
  versionLabel = '',
  leadingSilenceMs = 0,
  playbackRateBase = 1,
  globalTimingOffsetMs = 0,
  matchStatus = 'confirmed',
} = {}) {
  return Object.freeze({
    trackVersionId: boundedId(trackVersionId),
    songWorkId: boundedId(songWorkId),
    sourceType,
    sourceIdentity: boundedText(sourceIdentity, 512),
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
    audioFingerprint: null,
    versionKind,
    versionLabel: boundedText(versionLabel, 120),
    leadingSilenceMs: Number.isFinite(leadingSilenceMs) ? leadingSilenceMs : 0,
    playbackRateBase: Number.isFinite(playbackRateBase) && playbackRateBase > 0
      ? playbackRateBase
      : 1,
    globalTimingOffsetMs: Number.isFinite(globalTimingOffsetMs) ? globalTimingOffsetMs : 0,
    matchStatus,
    matchEvidence: [],
  });
}

export function createLyricDocument({
  lyricDocumentId,
  songWorkId,
  language = 'und',
  source,
  lines = [],
  status = 'confirmed',
} = {}) {
  return Object.freeze({
    lyricDocumentId: boundedId(lyricDocumentId),
    songWorkId: boundedId(songWorkId),
    language: boundedText(language, 16) || 'und',
    source: { ...(source || {}) },
    lines: lines.map((line, index) => Object.freeze({
      lineId: boundedId(line.lineId) || `L${String(index + 1).padStart(3, '0')}`,
      text: String(line.text ?? '').normalize('NFC'),
      sectionId: boundedId(line.sectionId) || 'main',
      order: index + 1,
    })),
    status,
  });
}

export function createTranslationRevision({
  translationRevisionId,
  songWorkId,
  lyricDocumentId,
  sourceTier = 'trusted_web',
  translationType = 'semantic_translation',
  source,
  mappings = [],
  selected = true,
  lockedByUser = false,
  now = Date.now(),
} = {}) {
  return Object.freeze({
    translationRevisionId: boundedId(translationRevisionId),
    songWorkId: boundedId(songWorkId),
    lyricDocumentId: boundedId(lyricDocumentId),
    language: 'ko',
    sourceTier: LYRICS_SOURCE_TIERS.includes(sourceTier) ? sourceTier : 'trusted_web',
    translationType,
    source: { ...(source || {}) },
    mappings: mappings.map((mapping, index) => Object.freeze({
      mappingId: boundedId(mapping.mappingId) || `M${String(index + 1).padStart(3, '0')}`,
      originalLineIds: [...new Set((mapping.originalLineIds || []).map(boundedId).filter(Boolean))],
      displayKo: String(mapping.displayKo ?? '').normalize('NFC'),
      literalKo: mapping.literalKo == null ? null : String(mapping.literalKo).normalize('NFC'),
      reviewStatus: mapping.reviewStatus || 'candidate',
      notes: Array.isArray(mapping.notes) ? mapping.notes.slice(0, 16) : [],
    })),
    selected: Boolean(selected),
    lockedByUser: Boolean(lockedByUser),
    createdAt: now,
    updatedAt: now,
  });
}
