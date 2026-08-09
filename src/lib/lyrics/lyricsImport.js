const TIMESTAMP = /^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/u;

const normalizeText = (value) => String(value ?? '')
  .replace(/^\uFEFF/u, '')
  .replace(/\r\n?/gu, '\n')
  .normalize('NFC');

function timestampMs(value) {
  const match = String(value).trim().match(TIMESTAMP);
  if (!match) return null;
  const fraction = match[3] || '0';
  return ((Number(match[1]) * 60) + Number(match[2])) * 1_000
    + Number(fraction.padEnd(3, '0').slice(0, 3));
}

function makeResult(rows, warnings, metadata = {}) {
  const lines = [];
  const timedCues = [];
  rows.forEach((row) => {
    const text = normalizeText(row.text);
    if (text) {
      const lineId = `L${String(lines.length + 1).padStart(3, '0')}`;
      lines.push({ lineId, text, sectionId: 'main', order: lines.length + 1 });
      if (Number.isFinite(row.anchorMs)) timedCues.push({ kind: 'lyric', anchorMs: row.anchorMs, lineIds: [lineId] });
    } else if (Number.isFinite(row.anchorMs)) {
      timedCues.push({ kind: 'blank', anchorMs: row.anchorMs, lineIds: [] });
    }
  });
  return Object.freeze({ lines: Object.freeze(lines), timedCues: Object.freeze(timedCues), warnings, metadata });
}

function parseLrc(text) {
  const rows = [];
  const warnings = [];
  const seen = new Map();
  for (const [index, rawLine] of normalizeText(text).split('\n').entries()) {
    const tags = [...rawLine.matchAll(/\[([^\]]+)\]/gu)];
    const timestamps = tags.map((match) => timestampMs(match[1])).filter(Number.isFinite);
    if (timestamps.length === 0) {
      if (rawLine.trim() && !/^\[[a-z]+:/iu.test(rawLine.trim())) warnings.push(`line_${index + 1}:malformed`);
      continue;
    }
    const lyricText = rawLine.replace(/\[[^\]]+\]/gu, '').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/gu, '').trim();
    for (const anchorMs of timestamps) {
      if (seen.has(anchorMs)) warnings.push(`line_${index + 1}:duplicate_timestamp`);
      seen.set(anchorMs, true);
      rows.push({ anchorMs, text: lyricText });
    }
  }
  return makeResult(rows.sort((a, b) => a.anchorMs - b.anchorMs), warnings);
}

function parseSrtLike(text, webVtt = false) {
  const normalized = normalizeText(text).replace(/^WEBVTT[^\n]*\n+/u, '');
  const rows = [];
  const warnings = [];
  for (const block of normalized.split(/\n{2,}/u)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const start = lines[timingIndex].split('-->')[0].trim().replace(',', '.');
    const parts = start.split(':');
    const anchorMs = parts.length === 3
      ? ((Number(parts[0]) * 3600) + (Number(parts[1]) * 60) + Number(parts[2])) * 1_000
      : null;
    if (!Number.isFinite(anchorMs)) {
      warnings.push('cue:malformed_timestamp');
      continue;
    }
    rows.push({ anchorMs, text: lines.slice(timingIndex + 1).join('\n').replace(/<[^>]+>/gu, '') });
  }
  return makeResult(rows, warnings, { format: webVtt ? 'vtt' : 'srt' });
}

function parseTtml(text) {
  const rows = [];
  const warnings = [];
  for (const match of normalizeText(text).matchAll(/<p\b[^>]*\bbegin=["']([^"']+)["'][^>]*>([\s\S]*?)<\/p>/giu)) {
    const clock = match[1].replace(/^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})$/u, (_all, h, m, s, ms) => (
      `${Number(h) * 60 + Number(m)}:${s}.${ms}`
    ));
    const anchorMs = timestampMs(clock);
    if (!Number.isFinite(anchorMs)) {
      warnings.push('cue:malformed_timestamp');
      continue;
    }
    rows.push({ anchorMs, text: match[2].replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]+>/gu, '').trim() });
  }
  return makeResult(rows, warnings, { format: 'ttml' });
}

function parsePlain(text) {
  const rows = normalizeText(text).split('\n').map((line) => ({ text: line.trim() }));
  return makeResult(rows, []);
}

export function detectLyricsFormat(filename = '', text = '') {
  const extension = String(filename).toLowerCase().split('.').pop();
  if (['lrc', 'srt', 'vtt', 'ttml', 'xml', 'json'].includes(extension)) return extension;
  const normalized = normalizeText(text).trimStart();
  if (normalized.startsWith('WEBVTT')) return 'vtt';
  if (/\[\d{1,3}:\d{2}/u.test(normalized)) return 'lrc';
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/u.test(normalized)) return 'srt';
  if (/<tt\b|<p\b[^>]*\bbegin=/iu.test(normalized)) return 'ttml';
  if (normalized.startsWith('{')) return 'json';
  return 'text';
}

export function importLyricsText({ text, filename = '', format = null } = {}) {
  const detected = format || detectLyricsFormat(filename, text);
  if (detected === 'lrc') return parseLrc(text);
  if (detected === 'srt') return parseSrtLike(text, false);
  if (detected === 'vtt') return parseSrtLike(text, true);
  if (detected === 'ttml' || detected === 'xml') return parseTtml(text);
  if (detected === 'json') {
    const parsed = JSON.parse(normalizeText(text));
    const rows = (parsed.cues || parsed.lines || []).map((item) => ({
      anchorMs: Number.isFinite(item.anchorMs) ? item.anchorMs : undefined,
      text: item.text ?? item.originalLines?.join('\n') ?? '',
    }));
    return makeResult(rows, [], { format: 'json' });
  }
  return parsePlain(text);
}
