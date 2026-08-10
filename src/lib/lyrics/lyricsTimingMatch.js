const normalize = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[^\p{L}\p{N}]+/gu, '');

const bigrams = (value) => {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
};

export function lyricsLineSimilarity(leftValue, rightValue) {
  const left = normalize(leftValue);
  const right = normalize(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 4 && longer.includes(shorter)) return 0.9 * (shorter.length / longer.length) + 0.1;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  const matches = [...leftBigrams].filter((item) => rightBigrams.has(item)).length;
  return (2 * matches) / Math.max(1, leftBigrams.size + rightBigrams.size);
}

const interpolatedAnchor = (matches, lineIndex) => {
  const previous = [...matches].reverse().find((match) => match.lineIndex < lineIndex);
  const next = matches.find((match) => match.lineIndex > lineIndex);
  if (previous && next) {
    const progress = (lineIndex - previous.lineIndex) / (next.lineIndex - previous.lineIndex);
    return previous.anchorMs + ((next.anchorMs - previous.anchorMs) * progress);
  }
  if (previous) return previous.anchorMs + ((lineIndex - previous.lineIndex) * 4_000);
  if (next) return Math.max(0, next.anchorMs - ((next.lineIndex - lineIndex) * 4_000));
  return lineIndex * 5_000;
};

export function attachTrustedLyricsTiming(trustedCandidate, timingCandidate, {
  minimumSimilarity = 0.6,
  minimumCoverage = 0.7,
  searchWindow = 12,
} = {}) {
  const lines = Array.isArray(trustedCandidate?.lines) ? trustedCandidate.lines : [];
  const timingCues = Array.isArray(timingCandidate?.cues) ? timingCandidate.cues : [];
  if (lines.length < 5 || timingCues.length < 5) return trustedCandidate;
  const matches = [];
  let cursor = 0;
  for (const [lineIndex, line] of lines.entries()) {
    let best = null;
    const end = Math.min(timingCues.length, cursor + searchWindow);
    for (let cueIndex = cursor; cueIndex < end; cueIndex += 1) {
      const score = lyricsLineSimilarity(line, timingCues[cueIndex]?.text);
      if (!best || score > best.score) best = { lineIndex, cueIndex, score, anchorMs: timingCues[cueIndex].anchorMs };
    }
    if (best?.score >= minimumSimilarity && Number.isFinite(best.anchorMs)) {
      matches.push(best);
      cursor = best.cueIndex + 1;
    }
  }
  const coverage = matches.length / lines.length;
  if (coverage < minimumCoverage) return trustedCandidate;
  const byLine = new Map(matches.map((match) => [match.lineIndex, match]));
  let previousAnchor = 0;
  const cues = lines.map((text, lineIndex) => {
    const match = byLine.get(lineIndex);
    const anchorMs = Math.max(previousAnchor, Math.round(match?.anchorMs ?? interpolatedAnchor(matches, lineIndex)));
    previousAnchor = anchorMs;
    return Object.freeze({ anchorMs, text });
  });
  const averageSimilarity = matches.reduce((total, match) => total + match.score, 0) / matches.length;
  return Object.freeze({
    ...trustedCandidate,
    cues: Object.freeze(cues),
    timingEstimated: timingCandidate.timingEstimated === true || matches.length !== lines.length,
    timingSourceKind: String(timingCandidate.sourceKind || '').slice(0, 80),
    timingSourceUrl: String(timingCandidate.sourceUrl || '').slice(0, 1_024) || null,
    timingMatchCount: matches.length,
    timingLineCount: lines.length,
    timingAlignmentConfidence: Number(averageSimilarity.toFixed(3)),
    timingAnalysisConfidence: Number.isFinite(timingCandidate.timingAnalysisConfidence)
      ? timingCandidate.timingAnalysisConfidence
      : null,
    discoveryPath: [...new Set([
      ...(trustedCandidate.discoveryPath || []),
      'trusted_text_timing_alignment',
      ...(timingCandidate.discoveryPath || []),
    ])].slice(0, 8),
  });
}
