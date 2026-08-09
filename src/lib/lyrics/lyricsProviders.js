import { LYRICS_SOURCE_TIERS } from './lyricsSchema.js';

const bounded = (value, max = 500) => String(value ?? '').trim().slice(0, max);

export const LYRICS_PROVIDER_TYPES = Object.freeze({
  LYRICS: 'lyrics',
  TRANSLATION: 'translation',
  MACHINE_TRANSLATION: 'machine_translation',
});

export function normalizeLyricsCandidate(providerId, value = {}) {
  const candidateId = bounded(value.candidateId, 256);
  const sourceTierClaim = LYRICS_SOURCE_TIERS.includes(value.sourceTierClaim)
    ? value.sourceTierClaim
    : 'trusted_web';
  if (!bounded(providerId, 80) || !candidateId) throw new TypeError('lyrics_provider_candidate_invalid');
  return Object.freeze({
    providerId: bounded(providerId, 80),
    candidateId,
    title: bounded(value.title, 240),
    artist: bounded(value.artist, 240),
    sourceTierClaim,
    sourceUrl: bounded(value.sourceUrl, 1_024) || null,
    sourceTitle: bounded(value.sourceTitle, 240) || null,
    translatorName: bounded(value.translatorName, 160) || null,
    retrievedAt: Number.isFinite(value.retrievedAt) ? value.retrievedAt : Date.now(),
    contentHash: /^sha256:[a-f0-9]{64}$/u.test(value.contentHash || '') ? value.contentHash : null,
    rightsNote: bounded(value.rightsNote, 500) || null,
    confidence: Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(1, value.confidence))
      : null,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.map((warning) => bounded(warning, 120)).filter(Boolean).slice(0, 32)
      : [],
  });
}

export function createLyricsProviderAdapter({ providerId, type, search, fetchCandidate }) {
  if (!providerId || !Object.values(LYRICS_PROVIDER_TYPES).includes(type)
    || typeof search !== 'function' || typeof fetchCandidate !== 'function') {
    throw new TypeError('lyrics_provider_configuration_invalid');
  }
  return Object.freeze({
    providerId,
    type,
    async search(context) {
      const results = await search(context);
      return Object.freeze((results || []).map((candidate) => normalizeLyricsCandidate(providerId, candidate)));
    },
    fetchCandidate,
  });
}
