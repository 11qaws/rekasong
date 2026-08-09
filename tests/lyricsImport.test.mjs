import test from 'node:test';
import assert from 'node:assert/strict';

import { importLyricsText } from '../src/lib/lyrics/lyricsImport.js';

test('LRC and enhanced LRC preserve same-time lines and explicit blank cues', () => {
  const result = importLyricsText({
    filename: 'fixture.lrc',
    text: '\uFEFF[00:01.00]<00:01.00>alpha\r\n[00:01.00]beta\r\n[00:02.50]\r\nmalformed',
  });
  assert.deepEqual(result.lines.map(({ text }) => text), ['alpha', 'beta']);
  assert.deepEqual(result.timedCues.map(({ kind, anchorMs }) => [kind, anchorMs]), [
    ['lyric', 1_000],
    ['lyric', 1_000],
    ['blank', 2_500],
  ]);
  assert.ok(result.warnings.some((warning) => warning.includes('duplicate_timestamp')));
  assert.ok(result.warnings.some((warning) => warning.includes('malformed')));
});

test('SRT and VTT parse multiline cues with stable line IDs', () => {
  const srt = importLyricsText({
    filename: 'fixture.srt',
    text: '1\r\n00:00:01,500 --> 00:00:03,000\r\nalpha\r\nbeta\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\ngamma',
  });
  assert.deepEqual(srt.lines.map(({ lineId, text }) => [lineId, text]), [
    ['L001', 'alpha\nbeta'],
    ['L002', 'gamma'],
  ]);
  assert.deepEqual(srt.timedCues.map(({ anchorMs }) => anchorMs), [1_500, 4_000]);

  const vtt = importLyricsText({
    filename: 'fixture.vtt',
    text: 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\n<voice a>delta</voice>',
  });
  assert.equal(vtt.lines[0].text, 'delta');
  assert.equal(vtt.timedCues[0].anchorMs, 2_000);
});

test('plain text, TTML, and Rekasong JSON import through the same projection', () => {
  assert.deepEqual(
    importLyricsText({ filename: 'fixture.txt', text: 'alpha\r\n\r\nbeta' }).lines.map(({ text }) => text),
    ['alpha', 'beta'],
  );
  assert.equal(importLyricsText({
    filename: 'fixture.ttml',
    text: '<tt><body><p begin="00:00:03.250">alpha<br/>beta</p></body></tt>',
  }).timedCues[0].anchorMs, 3_250);
  assert.equal(importLyricsText({
    filename: 'fixture.json',
    text: JSON.stringify({ cues: [{ anchorMs: 500, originalLines: ['alpha'] }] }),
  }).lines[0].text, 'alpha');
});
