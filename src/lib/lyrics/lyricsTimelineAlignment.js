const finite = (value) => Number.isFinite(Number(value));

export function remapCueAnchorsByReferences(cues, references) {
  const sourceStartMs = Number(references?.sourceStartMs);
  const targetStartMs = Number(references?.targetStartMs);
  const sourceEndMs = Number(references?.sourceEndMs);
  const targetEndMs = Number(references?.targetEndMs);
  if (![sourceStartMs, targetStartMs, sourceEndMs, targetEndMs].every(finite)
    || sourceStartMs < 0
    || targetStartMs < 0
    || sourceEndMs <= sourceStartMs
    || targetEndMs <= targetStartMs) {
    throw new TypeError('lyrics_timing_references_invalid');
  }
  const scale = (targetEndMs - targetStartMs) / (sourceEndMs - sourceStartMs);
  if (scale < 0.5 || scale > 2) throw new RangeError('lyrics_timing_scale_unsafe');
  return (Array.isArray(cues) ? cues : []).map((cue) => ({
    ...cue,
    anchorMs: Math.max(0, Math.round(targetStartMs + ((Number(cue.anchorMs) - sourceStartMs) * scale))),
  }));
}
