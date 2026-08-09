import { transitionBoundaryMs } from './lyricsTempoMap.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (value) => value * value * (3 - (2 * value));
const isBlank = (cue) => !cue || cue.kind === 'blank';

export function compileLyricsTimeline(playbackPackage) {
  const cues = Array.isArray(playbackPackage?.cues) ? playbackPackage.cues : [];
  const timeline = [];
  let previousAnchor = 0;
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const boundary = transitionBoundaryMs({
      anchorMs: cue.anchorMs,
      anchorTick: cue.anchorTick,
      tempoMap: playbackPackage.timingMode === 'tempo_map'
        ? { ppq: playbackPackage.ppq, segments: playbackPackage.tempoSegments }
        : null,
      transitionRule: playbackPackage.transitionRule,
      transitionOverride: cue.transitionOverride,
    });
    const anchorMs = Math.max(0, cue.anchorMs);
    const fadeStartMs = clamp(boundary.fadeStartMs, previousAnchor, anchorMs);
    const fadeEndMs = clamp(boundary.fadeEndMs, fadeStartMs, anchorMs);
    timeline.push(Object.freeze({
      cue,
      previousCue: index > 0 ? cues[index - 1] : null,
      fadeStartMs,
      fadeEndMs,
      anchorMs,
      timingMode: boundary.mode,
      collision: fadeStartMs !== boundary.fadeStartMs || fadeEndMs !== boundary.fadeEndMs,
    }));
    previousAnchor = anchorMs;
  }
  return Object.freeze(timeline);
}

function lastIndexAtOrBefore(timeline, milliseconds, field) {
  let low = 0;
  let high = timeline.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timeline[middle][field] <= milliseconds) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

export function resolveLyricsTimeline(timeline, mediaTimeMs) {
  const timeMs = Math.max(0, Number.isFinite(mediaTimeMs) ? mediaTimeMs : 0);
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return Object.freeze({
      timeMs,
      previousCue: null,
      destinationCue: null,
      visualCue: null,
      singingCue: null,
      progress: 0,
      easedProgress: 0,
      previousOpacity: 0,
      destinationOpacity: 0,
      phase: 'blank',
      wordHighlightActive: false,
    });
  }

  const transitionIndex = lastIndexAtOrBefore(timeline, timeMs, 'fadeStartMs');
  const anchorIndex = lastIndexAtOrBefore(timeline, timeMs, 'anchorMs');
  const singingCue = anchorIndex >= 0 && !isBlank(timeline[anchorIndex].cue)
    ? timeline[anchorIndex].cue
    : null;
  if (transitionIndex < 0) {
    return Object.freeze({
      timeMs,
      previousCue: null,
      destinationCue: timeline[0].cue,
      visualCue: null,
      singingCue,
      progress: 0,
      easedProgress: 0,
      previousOpacity: 0,
      destinationOpacity: 0,
      phase: 'before_first',
      wordHighlightActive: false,
    });
  }

  const transition = timeline[transitionIndex];
  const duration = transition.fadeEndMs - transition.fadeStartMs;
  const progress = timeMs >= transition.fadeEndMs
    ? 1
    : duration <= 0 ? 1 : clamp((timeMs - transition.fadeStartMs) / duration, 0, 1);
  const easedProgress = smoothstep(progress);
  const previousBlank = isBlank(transition.previousCue);
  const destinationBlank = isBlank(transition.cue);
  const visualCue = progress >= 1
    ? (destinationBlank ? null : transition.cue)
    : (previousBlank ? (destinationBlank ? null : transition.cue) : transition.previousCue);
  const phase = progress < 1
    ? 'transitioning'
    : timeMs < transition.anchorMs ? 'pre_anchor' : destinationBlank ? 'blank' : 'singing';

  return Object.freeze({
    timeMs,
    previousCue: previousBlank ? null : transition.previousCue,
    destinationCue: destinationBlank ? null : transition.cue,
    visualCue,
    singingCue,
    progress,
    easedProgress,
    previousOpacity: previousBlank ? 0 : 1 - easedProgress,
    destinationOpacity: destinationBlank ? 0 : easedProgress,
    phase,
    wordHighlightActive: Boolean(
      !destinationBlank && timeMs >= transition.anchorMs && singingCue?.cueId === transition.cue.cueId,
    ),
  });
}
