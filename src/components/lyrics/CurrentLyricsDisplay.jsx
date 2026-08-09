import { useEffect, useMemo, useState } from 'react';
import { Languages, LoaderCircle } from 'lucide-react';

import { getLyricsMessage as t } from '../../copy/lyricsMessages.js';
import useLyricsRepository from '../../hooks/useLyricsRepository.js';
import { compileLyricsTimeline, resolveLyricsTimeline } from '../../lib/lyrics/lyricsCueTimeline.js';
import { verifyPlaybackLyricsPackage } from '../../lib/lyrics/lyricsPackage.js';

const readyLyrics = (lyricsRef) => Boolean(
  lyricsRef?.status === 'ready'
  && lyricsRef.packageId
  && lyricsRef.packageHash,
);

function CueLayer({ cue, opacity, position }) {
  if (!cue) return null;
  return (
    <div
      className={`lyrics-live-layer is-${position}`}
      style={{ '--lyrics-live-opacity': Math.max(0, Math.min(1, opacity)) }}
      data-cue-id={cue.cueId}
    >
      <div className="lyrics-live-original">
        {(cue.originalLines || []).slice(0, 2).map((line, index) => <span key={`${index}-${line}`}>{line}</span>)}
      </div>
      <div className="lyrics-live-translation">
        {(cue.translationLinesKo || []).slice(0, 2).map((line, index) => <span key={`${index}-${line}`}>{line}</span>)}
      </div>
    </div>
  );
}

function EmptyState({ message, actionLabel, onPrepare, loading = false }) {
  return (
    <div className="lyrics-live-empty" role="status">
      {loading ? <LoaderCircle className="spinner" size={18} /> : <Languages size={18} />}
      <span>{message}</span>
      {!loading && onPrepare && (
        <button type="button" className="lyrics-live-action" onClick={onPrepare}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export default function CurrentLyricsDisplay({ lyricsRef, preparationState = null, currentTime = 0, onPrepare, onRetry, locale = 'ko' }) {
  const { getPlaybackPackage } = useLyricsRepository();
  const packageKey = readyLyrics(lyricsRef)
    ? `${lyricsRef.packageId}:${lyricsRef.packageHash}`
    : '';
  const [packageState, setPackageState] = useState({ key: '', status: 'disabled', playbackPackage: null });

  useEffect(() => {
    if (!packageKey) {
      setPackageState({ key: '', status: 'disabled', playbackPackage: null });
      return undefined;
    }

    let cancelled = false;
    setPackageState({ key: packageKey, status: 'loading', playbackPackage: null });
    getPlaybackPackage(lyricsRef.packageId)
      .then(async (playbackPackage) => {
        if (!playbackPackage) {
          if (!cancelled) setPackageState({ key: packageKey, status: 'missing', playbackPackage: null });
          return;
        }
        const validation = await verifyPlaybackLyricsPackage(playbackPackage, lyricsRef.packageHash);
        if (!cancelled) {
          setPackageState({
            key: packageKey,
            status: validation.ok ? 'ready' : 'invalid',
            playbackPackage: validation.ok ? playbackPackage : null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setPackageState({ key: packageKey, status: 'error', playbackPackage: null });
      });
    return () => { cancelled = true; };
  }, [getPlaybackPackage, lyricsRef?.packageHash, lyricsRef?.packageId, packageKey]);

  const state = packageState.key === packageKey
    ? packageState
    : { key: packageKey, status: packageKey ? 'loading' : 'disabled', playbackPackage: null };
  const timeline = useMemo(
    () => compileLyricsTimeline(state.playbackPackage),
    [state.playbackPackage],
  );
  const resolved = useMemo(
    () => resolveLyricsTimeline(timeline, Math.max(0, Number(currentTime) || 0) * 1_000),
    [currentTime, timeline],
  );

  if (state.status === 'disabled') {
    if (['collecting', 'translating', 'timing'].includes(preparationState?.phase)) {
      return (
        <section className="lyrics-live-stage is-loading" aria-label={t('live.region', {}, locale)}>
          <EmptyState message={t(`status.${preparationState.phase}`, {}, locale)} loading />
        </section>
      );
    }
    if (preparationState?.phase === 'review_required') {
      return (
        <section className="lyrics-live-stage is-waiting" aria-label={t('live.region', {}, locale)}>
          <EmptyState
            message={t('status.reviewRequired', {}, locale)}
            actionLabel={t('action.review', {}, locale)}
            onPrepare={onPrepare}
          />
        </section>
      );
    }
    if (preparationState?.phase === 'failed') {
      return (
        <section className="lyrics-live-stage is-error" aria-label={t('live.region', {}, locale)}>
          <EmptyState
            message={t('status.failed', {}, locale)}
            actionLabel={t('action.retry', {}, locale)}
            onPrepare={onRetry || onPrepare}
          />
        </section>
      );
    }
    return (
      <section className="lyrics-live-stage is-empty" aria-label={t('live.region', {}, locale)}>
        <EmptyState
          message={t('live.empty', {}, locale)}
          actionLabel={t('action.review', {}, locale)}
          onPrepare={onPrepare}
        />
      </section>
    );
  }
  if (state.status === 'loading') {
    return (
      <section className="lyrics-live-stage is-loading" aria-label={t('live.region', {}, locale)}>
        <EmptyState message={t('live.loading', {}, locale)} loading />
      </section>
    );
  }
  if (state.status !== 'ready') {
    return (
      <section className="lyrics-live-stage is-error" aria-label={t('live.region', {}, locale)}>
        <EmptyState
          message={t(state.status === 'missing' ? 'live.missing' : 'live.invalid', {}, locale)}
          actionLabel={t('action.retry', {}, locale)}
          onPrepare={onPrepare}
        />
      </section>
    );
  }

  const hasVisibleCue = Boolean(resolved.previousCue || resolved.destinationCue);
  return (
    <section
      className={`lyrics-live-stage ${hasVisibleCue ? 'is-active' : 'is-waiting'}`}
      aria-label={t('live.region', {}, locale)}
      data-lyrics-phase={resolved.phase}
    >
      {hasVisibleCue ? (
        <>
          <div className="lyrics-live-copy" aria-hidden="true">
            <CueLayer cue={resolved.previousCue} opacity={resolved.previousOpacity} position="previous" />
            <CueLayer cue={resolved.destinationCue} opacity={resolved.destinationOpacity} position="destination" />
          </div>
          <span className="lyrics-live-announcement" aria-live="polite" aria-atomic="true">
            {[
              ...(resolved.visualCue?.originalLines || []),
              ...(resolved.visualCue?.translationLinesKo || []),
            ].join(' · ')}
          </span>
        </>
      ) : (
        <div className="lyrics-live-waiting" role="status">
          <span className="lyrics-live-wave" aria-hidden="true"><i /><i /><i /></span>
          <span>{t(resolved.phase === 'before_first' ? 'live.beforeFirst' : 'live.interlude', {}, locale)}</span>
        </div>
      )}
    </section>
  );
}
