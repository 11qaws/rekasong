const finite = (value) => Number.isFinite(value);

function normalizedSegments(tempoMap) {
  const ppq = Number.isSafeInteger(tempoMap?.ppq) && tempoMap.ppq > 0 ? tempoMap.ppq : 960;
  const source = Array.isArray(tempoMap?.segments) ? tempoMap.segments : [];
  if (source.length === 0) throw new TypeError('tempo_map_segments_required');
  const sorted = source.map((segment) => ({ ...segment })).sort((a, b) => a.startTick - b.startTick);
  let prior = null;
  for (const segment of sorted) {
    if (!finite(segment.startTick) || segment.startTick < 0 || !finite(segment.bpm) || segment.bpm <= 0) {
      throw new TypeError('tempo_map_segment_invalid');
    }
    if (prior && segment.startTick <= prior.startTick) throw new TypeError('tempo_map_segment_order');
    const derivedStartMs = prior
      ? prior.startMs + ((segment.startTick - prior.startTick) * 60_000) / (prior.bpm * ppq)
      : 0;
    segment.startMs = finite(segment.startMs) && segment.startMs >= 0
      ? segment.startMs
      : derivedStartMs;
    segment.numerator = Number.isSafeInteger(segment.numerator) && segment.numerator > 0
      ? segment.numerator
      : 4;
    segment.denominator = [1, 2, 4, 8, 16].includes(segment.denominator)
      ? segment.denominator
      : 4;
    segment.downbeatTick = finite(segment.downbeatTick) ? segment.downbeatTick : segment.startTick;
    prior = segment;
  }
  return { ppq, segments: sorted };
}

export function validateTempoMap(tempoMap) {
  try {
    return Object.freeze({ ok: true, ...normalizedSegments(tempoMap), errors: [] });
  } catch (error) {
    return Object.freeze({ ok: false, errors: [error.message] });
  }
}

export function tickToMs(tempoMap, tick) {
  const { ppq, segments } = normalizedSegments(tempoMap);
  const target = Math.max(0, finite(tick) ? tick : 0);
  let segment = segments[0];
  for (const candidate of segments) {
    if (candidate.startTick > target) break;
    segment = candidate;
  }
  return segment.startMs + ((target - segment.startTick) * 60_000) / (segment.bpm * ppq);
}

export function msToTick(tempoMap, milliseconds) {
  const { ppq, segments } = normalizedSegments(tempoMap);
  const target = Math.max(0, finite(milliseconds) ? milliseconds : 0);
  let segment = segments[0];
  for (const candidate of segments) {
    if (candidate.startMs > target) break;
    segment = candidate;
  }
  return segment.startTick + ((target - segment.startMs) * segment.bpm * ppq) / 60_000;
}

export function musicalPositionAtTick(tempoMap, tick) {
  const { ppq, segments } = normalizedSegments(tempoMap);
  const target = Math.max(0, finite(tick) ? tick : 0);
  let segment = segments[0];
  for (const candidate of segments) {
    if (candidate.startTick > target) break;
    segment = candidate;
  }
  const ticksPerBeat = (ppq * 4) / segment.denominator;
  const ticksPerBar = ticksPerBeat * segment.numerator;
  const relative = Math.max(0, target - segment.downbeatTick);
  return Object.freeze({
    bar: Math.floor(relative / ticksPerBar) + 1,
    beat: Math.floor((relative % ticksPerBar) / ticksPerBeat) + 1,
    tickInBeat: relative % ticksPerBeat,
  });
}

export function transitionBoundaryMs({
  anchorMs,
  anchorTick,
  tempoMap,
  transitionRule = {},
  transitionOverride = null,
}) {
  if (transitionOverride
    && finite(transitionOverride.fadeStartMs)
    && finite(transitionOverride.fadeEndMs)) {
    return Object.freeze({
      fadeStartMs: Math.max(0, transitionOverride.fadeStartMs),
      fadeEndMs: Math.max(0, transitionOverride.fadeEndMs),
      mode: 'override',
    });
  }
  if (tempoMap && finite(anchorTick)) {
    const ppq = Number.isSafeInteger(tempoMap.ppq) && tempoMap.ppq > 0 ? tempoMap.ppq : 960;
    const startTicks = finite(transitionRule.fadeStartTicksBeforeAnchor)
      ? transitionRule.fadeStartTicksBeforeAnchor
      : ppq;
    const endTicks = finite(transitionRule.fadeEndTicksBeforeAnchor)
      ? transitionRule.fadeEndTicksBeforeAnchor
      : ppq / 2;
    return Object.freeze({
      fadeStartMs: tickToMs(tempoMap, Math.max(0, anchorTick - startTicks)),
      fadeEndMs: tickToMs(tempoMap, Math.max(0, anchorTick - endTicks)),
      mode: 'tempo_map',
    });
  }
  const safeAnchor = Math.max(0, finite(anchorMs) ? anchorMs : 0);
  return Object.freeze({
    fadeStartMs: Math.max(0, safeAnchor - (transitionRule.fallbackFadeStartMsBeforeAnchor ?? 600)),
    fadeEndMs: Math.max(0, safeAnchor - (transitionRule.fallbackFadeEndMsBeforeAnchor ?? 300)),
    mode: 'fixed_ms_fallback',
  });
}
