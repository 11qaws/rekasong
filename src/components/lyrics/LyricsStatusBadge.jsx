import { Check, Languages, LoaderCircle, TriangleAlert } from 'lucide-react';

import { getLyricsMessage as t } from '../../copy/lyricsMessages.js';
import './LyricsStatusBadge.css';

export default function LyricsStatusBadge({ lyricsRef, preparationState = null }) {
  const ready = lyricsRef?.status === 'ready';
  const phase = ready ? 'ready' : preparationState?.phase || lyricsRef?.status || 'none';
  const failed = phase === 'failed';
  const review = phase === 'review_required' || phase === 'candidate_review';
  const preparing = ['collecting', 'translating', 'timing'].includes(phase);
  const published = ready && Boolean(lyricsRef.assetId);
  const label = failed
    ? t('status.failed')
    : review ? t('status.reviewRequired')
      : preparing ? t(`status.${phase}`)
        : published ? t('status.ready') : ready ? t('status.localReady') : t('status.none');
  const kind = failed ? 'failed' : review ? 'review' : preparing ? 'preparing' : ready ? 'ready' : 'none';
  return (
    <span className={`lyrics-status-badge is-${kind}`}>
      {failed ? <TriangleAlert size={12} />
        : preparing ? <LoaderCircle size={12} className="spinner" />
          : ready ? <Check size={12} /> : <Languages size={12} />}
      {label}
    </span>
  );
}
