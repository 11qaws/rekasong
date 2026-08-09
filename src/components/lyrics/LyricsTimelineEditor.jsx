import { Plus, Redo2, Trash2, Undo2 } from 'lucide-react';

import { getLyricsMessage as t } from '../../copy/lyricsMessages.js';

export default function LyricsTimelineEditor({ history, onChange, onUndo, onRedo }) {
  const cues = history.present;
  const updateCue = (index, patch) => onChange(cues.map((cue, cueIndex) => (
    cueIndex === index ? { ...cue, ...patch } : cue
  )));
  const updateOverride = (index, field, value) => {
    const cue = cues[index];
    const next = { ...(cue.transitionOverride || {}) };
    if (value === '') delete next[field];
    else next[field] = Math.max(0, Number(value) * 1_000);
    updateCue(index, {
      transitionOverride: Number.isFinite(next.fadeStartMs) || Number.isFinite(next.fadeEndMs)
        ? next
        : null,
    });
  };
  const addBlank = () => {
    const anchorMs = (cues.at(-1)?.anchorMs || 0) + 5_000;
    onChange([...cues, {
      cueId: `B${crypto.randomUUID()}`,
      kind: 'blank',
      anchorMs,
      originalLineIds: [],
      originalLines: [],
      translationMappingIds: [],
      translationLinesKo: [],
      romanizationLines: [],
      transitionOverride: null,
      reviewStatus: 'approved',
    }]);
  };

  return (
    <div className="lyrics-timeline-editor">
      <div className="lyrics-inline-actions">
        <button type="button" onClick={onUndo} disabled={history.past.length === 0}><Undo2 size={14} /> {t('timing.undo')}</button>
        <button type="button" onClick={onRedo} disabled={history.future.length === 0}><Redo2 size={14} /> {t('timing.redo')}</button>
        <button type="button" onClick={addBlank}><Plus size={14} /> {t('timing.addBlank')}</button>
      </div>
      <div className="lyrics-cue-table" role="table">
        {cues.map((cue, index) => (
          <div className="lyrics-cue-row" role="row" key={cue.cueId}>
            <select
              aria-label={t('timing.kind')}
              value={cue.kind}
              onChange={(event) => updateCue(index, event.target.value === 'blank'
                ? {
                    kind: 'blank',
                    originalLineIds: [],
                    originalLines: [],
                    translationMappingIds: [],
                    translationLinesKo: [],
                  }
                : { kind: 'lyric' })}
            >
              <option value="lyric">{t('timing.lyric')}</option>
              <option value="blank">{t('timing.blank')}</option>
            </select>
            <label>
              <span>{t('timing.anchor')}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={(cue.anchorMs / 1_000).toFixed(2)}
                onChange={(event) => updateCue(index, { anchorMs: Math.max(0, Number(event.target.value) * 1_000) })}
              />
            </label>
            <div className="lyrics-cue-copy">
              <span>{cue.kind === 'blank' ? t('timing.blank') : cue.originalLines.join(' / ')}</span>
              {cue.kind === 'lyric' && <small>{cue.translationLinesKo.join(' / ')}</small>}
              <details className="lyrics-cue-override">
                <summary>{t('timing.override')}</summary>
                <label><span>{t('timing.overrideStart')}</span><input type="number" min="0" step="0.01" value={Number.isFinite(cue.transitionOverride?.fadeStartMs) ? cue.transitionOverride.fadeStartMs / 1_000 : ''} onChange={(event) => updateOverride(index, 'fadeStartMs', event.target.value)} /></label>
                <label><span>{t('timing.overrideEnd')}</span><input type="number" min="0" step="0.01" value={Number.isFinite(cue.transitionOverride?.fadeEndMs) ? cue.transitionOverride.fadeEndMs / 1_000 : ''} onChange={(event) => updateOverride(index, 'fadeEndMs', event.target.value)} /></label>
              </details>
            </div>
            <button
              type="button"
              className="lyrics-icon-button"
              aria-label={t('timing.remove')}
              onClick={() => onChange(cues.filter((_, cueIndex) => cueIndex !== index))}
            ><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
