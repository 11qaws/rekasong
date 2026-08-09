import { LYRICS_SOURCE_TIERS } from './lyricsSchema.js';

export const TRANSLATION_TIER_PRIORITY = Object.freeze(
  Object.fromEntries(LYRICS_SOURCE_TIERS.map((tier, index) => [tier, index])),
);

const automaticCandidate = (candidate) => candidate
  && candidate.translationType !== 'official_adaptation'
  && candidate.sourceTier !== 'machine_literal';

export function effectiveTranslationTier(candidate) {
  if (candidate?.lockedByUser) return 'user_locked';
  if (candidate?.sourceTier === 'community_consensus') {
    const families = new Set((candidate.independentSourceFamilies || []).filter(Boolean));
    if (families.size < 2) return 'trusted_web';
  }
  return LYRICS_SOURCE_TIERS.includes(candidate?.sourceTier)
    ? candidate.sourceTier
    : 'trusted_web';
}

export function selectTranslationCandidate(candidates, { currentRevision = null } = {}) {
  if (currentRevision?.lockedByUser) {
    return Object.freeze({
      candidate: currentRevision,
      reason: 'user_locked',
      higherPriorityAvailable: false,
    });
  }
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter(automaticCandidate)
    .map((candidate, index) => ({ candidate, index, tier: effectiveTranslationTier(candidate) }))
    .sort((a, b) => (TRANSLATION_TIER_PRIORITY[a.tier] - TRANSLATION_TIER_PRIORITY[b.tier])
      || (a.index - b.index));
  const selected = eligible[0] || null;
  return Object.freeze({
    candidate: selected?.candidate || null,
    reason: selected?.tier || 'no_candidate',
    higherPriorityAvailable: false,
  });
}

export function shouldOfferMachineTranslation(candidates) {
  return !(Array.isArray(candidates) ? candidates : []).some((candidate) => (
    automaticCandidate(candidate)
    && !['machine_contextual', 'machine_literal'].includes(effectiveTranslationTier(candidate))
  ));
}

export function lockTranslationRevision(revision, now = Date.now()) {
  return Object.freeze({
    ...revision,
    sourceTier: revision?.sourceTier || 'trusted_web',
    lockedByUser: true,
    selected: true,
    updatedAt: now,
  });
}

export function compareCandidatePriority(a, b) {
  return TRANSLATION_TIER_PRIORITY[effectiveTranslationTier(a)]
    - TRANSLATION_TIER_PRIORITY[effectiveTranslationTier(b)];
}
