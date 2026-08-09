import React, { useEffect, useMemo, useRef } from 'react';

import { compileLyricsTimeline, resolveLyricsTimeline } from '../../lib/lyrics/lyricsCueTimeline.js';
import './LyricsOverlayRenderer.css';

const cueText = (cue) => ({
  original: (cue?.originalLines || []).slice(0, 2).join('\n'),
  translation: (cue?.translationLinesKo || []).slice(0, 2).join('\n'),
});

function applyLayer(layer, cue, opacity, active, offset, overallOpacity) {
  if (!layer) return;
  const nextId = cue?.cueId || '';
  if (layer.dataset.cueId !== nextId) {
    const text = cueText(cue);
    layer.dataset.cueId = nextId;
    layer.querySelector('[data-lyrics-original]').textContent = text.original;
    layer.querySelector('[data-lyrics-translation]').textContent = text.translation;
  }
  layer.style.opacity = String(opacity * overallOpacity);
  layer.style.transform = `translate3d(var(--lyrics-x-base, 0px), calc(var(--lyrics-y-base, 0px) + ${(1 - opacity) * offset}px), 0)`;
  layer.dataset.active = active ? 'true' : 'false';
}

function LyricsLayer({ layerRef }) {
  return (
    <div ref={layerRef} className="lyrics-overlay__layer">
      <div data-lyrics-original className="lyrics-overlay__original" />
      <div data-lyrics-translation className="lyrics-overlay__translation" />
    </div>
  );
}

export default function LyricsOverlayRenderer({ audioRef, playbackPackage }) {
  const firstLayerRef = useRef(null);
  const secondLayerRef = useRef(null);
  const startedRef = useRef(false);
  const timeline = useMemo(() => compileLyricsTimeline(playbackPackage), [playbackPackage]);
  const display = playbackPackage?.displayDefaults || {};
  const overallOpacity = Math.max(0, Math.min(1, Number(display.opacity ?? 1)));

  useEffect(() => {
    startedRef.current = false;
    let animationFrame = null;
    const render = () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) startedRef.current = true;
      const timeMs = Math.max(0, Number(audio?.currentTime || 0) * 1_000);
      const state = resolveLyricsTimeline(timeline, timeMs);
      if (!startedRef.current) {
        applyLayer(firstLayerRef.current, null, 0, false, -4, overallOpacity);
        applyLayer(secondLayerRef.current, null, 0, false, 4, overallOpacity);
        animationFrame = requestAnimationFrame(render);
        return;
      }
      applyLayer(
        firstLayerRef.current,
        state.previousCue,
        state.previousOpacity,
        state.singingCue?.cueId === state.previousCue?.cueId,
        -4,
        overallOpacity,
      );
      applyLayer(
        secondLayerRef.current,
        state.destinationCue,
        state.destinationOpacity,
        state.wordHighlightActive,
        4,
        overallOpacity,
      );
      animationFrame = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(animationFrame);
  }, [audioRef, overallOpacity, timeline]);

  if (!playbackPackage) return null;
  return (
    <div
      className="lyrics-overlay"
      data-lyrics-package-hash={playbackPackage.packageHash}
      data-position={display.positionPreset || 'right_center'}
      style={{
        '--lyrics-offset-x': `${Number(display.offsetX) || 0}px`,
        '--lyrics-offset-y': `${Number(display.offsetY) || 0}px`,
        '--lyrics-width': `${Math.max(320, Number(display.areaWidth) || 840)}px`,
        '--lyrics-original-size': `${Math.max(28, Number(display.originalFontSize) || 62)}px`,
        '--lyrics-translation-size': `${Math.max(22, Number(display.translationFontSize) || 40)}px`,
        '--lyrics-stroke': `${Math.max(0, Number(display.strokeWidth) || 0)}px`,
        '--lyrics-shadow': Math.max(0, Math.min(1, Number(display.shadowStrength ?? 0.8))),
        '--lyrics-font-family': display.fontFamily || 'Inter, Pretendard, "Noto Sans KR", sans-serif',
        '--lyrics-font-weight': Math.max(400, Number(display.fontWeight) || 800),
        '--lyrics-text-align': display.textAlign || 'right',
      }}
    >
      <LyricsLayer layerRef={firstLayerRef} />
      <LyricsLayer layerRef={secondLayerRef} />
    </div>
  );
}
