import { Check, Languages, TriangleAlert } from 'lucide-react';

import { getLyricsMessage as t } from '../../copy/lyricsMessages.js';
import './LyricsStatusBadge.css';

export default function LyricsStatusBadge({ lyricsRef }) {
  const ready = lyricsRef?.status === 'ready';
  const failed = lyricsRef?.status === 'failed';
  const published = ready && Boolean(lyricsRef.assetId);
  const label = failed
    ? t('status.failed')
    : published ? t('status.ready') : ready ? t('status.localReady') : t('status.none');
  return (
    <span className={`lyrics-status-badge is-${failed ? 'failed' : ready ? 'ready' : 'none'}`}>
      {failed ? <TriangleAlert size={12} /> : ready ? <Check size={12} /> : <Languages size={12} />}
      {label}
    </span>
  );
}
