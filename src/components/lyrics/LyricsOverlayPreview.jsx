import { compileLyricsTimeline, resolveLyricsTimeline } from '../../lib/lyrics/lyricsCueTimeline.js';
import { getLyricsMessage as t } from '../../copy/lyricsMessages.js';

export default function LyricsOverlayPreview({ playbackPackage, timeMs }) {
  const resolved = resolveLyricsTimeline(compileLyricsTimeline(playbackPackage), timeMs);
  const cue = resolved.destinationOpacity >= resolved.previousOpacity
    ? resolved.destinationCue
    : resolved.previousCue;
  const opacity = Math.max(resolved.previousOpacity, resolved.destinationOpacity);
  const display = playbackPackage?.displayDefaults || {};
  return (
    <div className="lyrics-overlay-preview">
      {cue ? (
        <div className="lyrics-preview-group" style={{ opacity: opacity * (display.opacity ?? 1), textAlign: display.textAlign || 'right', maxWidth: display.areaWidth || 840 }}>
          <div className="lyrics-preview-original" style={{ fontSize: display.originalFontSize || 62, fontWeight: display.fontWeight || 800 }}>{cue.originalLines.map((line) => <span key={line}>{line}</span>)}</div>
          <div className="lyrics-preview-translation" style={{ fontSize: display.translationFontSize || 40 }}>{cue.translationLinesKo.map((line) => <span key={line}>{line}</span>)}</div>
        </div>
      ) : <span className="lyrics-preview-empty">{t('preview.empty')}</span>}
    </div>
  );
}
