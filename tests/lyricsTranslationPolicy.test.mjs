import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveTranslationTier,
  lockTranslationRevision,
  selectTranslationCandidate,
  shouldOfferMachineTranslation,
} from '../src/lib/lyrics/lyricsTranslationPolicy.js';

test('user lock is stable and official translations beat web and machine drafts', () => {
  const web = { id: 'web', sourceTier: 'trusted_web' };
  const officialWork = { id: 'work', sourceTier: 'official_same_work' };
  const officialRelease = { id: 'release', sourceTier: 'official_same_release' };
  const machine = { id: 'machine', sourceTier: 'machine_contextual' };

  assert.equal(
    selectTranslationCandidate([machine, web, officialWork, officialRelease]).candidate.id,
    'release',
  );
  const locked = lockTranslationRevision(web, 100);
  assert.equal(selectTranslationCandidate([officialRelease], { currentRevision: locked }).candidate.id, 'web');
  assert.equal(locked.updatedAt, 100);
});

test('official adaptations and literal drafts are never automatic translation choices', () => {
  const result = selectTranslationCandidate([
    { id: 'adaptation', sourceTier: 'official_same_release', translationType: 'official_adaptation' },
    { id: 'literal', sourceTier: 'machine_literal' },
    { id: 'contextual', sourceTier: 'machine_contextual' },
  ]);
  assert.equal(result.candidate.id, 'contextual');
});

test('consensus requires independent source families and machine fallback stays last', () => {
  const copied = {
    sourceTier: 'community_consensus',
    independentSourceFamilies: ['same-source', 'same-source'],
  };
  assert.equal(effectiveTranslationTier(copied), 'trusted_web');
  assert.equal(effectiveTranslationTier({
    ...copied,
    independentSourceFamilies: ['family-a', 'family-b'],
  }), 'community_consensus');
  assert.equal(shouldOfferMachineTranslation([copied]), false);
  assert.equal(shouldOfferMachineTranslation([{ sourceTier: 'machine_contextual' }]), true);
});
