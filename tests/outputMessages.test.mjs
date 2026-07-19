import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getOutputMessage, outputMessageCatalog } from '../src/copy/outputMessages.js';
import {
  ON_AIR_OUTPUT_ACTIONS,
  ON_AIR_OUTPUT_GATE_CODES,
  ON_AIR_OUTPUT_LEASE_STATES,
  ON_AIR_OUTPUT_MODES,
} from '../src/lib/onAirOutputView.js';

const SEMANTIC_KEY = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function placeholders(template) {
  return [...String(template).matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

test('Korean output catalog uses semantic keys and non-empty source messages', () => {
  const entries = Object.entries(outputMessageCatalog.ko);
  assert.ok(entries.length >= 60, 'the first OBS/playback vertical slice should remain substantial');

  for (const [key, message] of entries) {
    assert.match(key, SEMANTIC_KEY, `non-semantic message key: ${key}`);
    assert.doesNotMatch(key, /[가-힣]/, `source prose must not be a key: ${key}`);
    assert.equal(typeof message, 'string');
    assert.ok(message.trim().length > 0, `empty Korean source message: ${key}`);
  }
});

test('requested locales fall back to authoritative Korean without exposing the key', () => {
  const key = 'obs.setup.player.connected';
  assert.equal(getOutputMessage(key, {}, 'en-US'), outputMessageCatalog.ko[key]);
  assert.equal(getOutputMessage(key, {}, 'ja'), outputMessageCatalog.ko[key]);
  assert.equal(getOutputMessage('missing.semantic.key', {}, 'en'), 'missing.semantic.key');
});

test('named interpolation replaces supplied values and preserves missing placeholders for diagnostics', () => {
  assert.equal(
    getOutputMessage('playback.failure.withAction', { detail: 'decode_failed' }, 'ko'),
    'decode_failed — 다시 재생하거나 버려 주세요.',
  );
  assert.equal(
    getOutputMessage('playback.failure.withAction', {}, 'ko'),
    '{{detail}} — 다시 재생하거나 버려 주세요.',
  );
});

test('every translated locale entry preserves Korean placeholder names', () => {
  for (const [locale, catalog] of Object.entries(outputMessageCatalog)) {
    if (locale === 'ko') continue;
    for (const [key, message] of Object.entries(catalog)) {
      assert.ok(Object.hasOwn(outputMessageCatalog.ko, key), `${locale} has orphan key ${key}`);
      assert.deepEqual(
        placeholders(message),
        placeholders(outputMessageCatalog.ko[key]),
        `${locale} placeholder mismatch for ${key}`,
      );
    }
  }
});

test('PlaybackPanel references only existing output catalog keys', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  const usedKeys = [...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(usedKeys.length >= 60, 'expected PlaybackPanel copy to use the translation facade');

  const missing = [...new Set(usedKeys)].filter((key) => !Object.hasOwn(outputMessageCatalog.ko, key));
  assert.deepEqual(missing, []);
});

test('PlaybackPanel keeps compact route controls in the header and diagnostics in settings', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  const headerStart = source.indexOf('className="playback-panel-header"');
  const playbackBodyStart = source.indexOf('{currentSong ? (', headerStart);
  const modalStart = source.indexOf('{isObsSetupOpen && (');
  const detailsStart = source.indexOf('className="output-route-details"');

  assert.ok(headerStart >= 0 && playbackBodyStart > headerStart, 'playback header must remain identifiable');
  const headerSource = source.slice(headerStart, playbackBodyStart);
  assert.match(headerSource, /className="playback-live-badges"/);
  assert.match(headerSource, /className="output-route-switch"/);
  assert.match(headerSource, /className="output-route-actions"/);
  assert.doesNotMatch(source, /className="output-selector"/);
  assert.ok(modalStart >= 0 && detailsStart > modalStart, 'route diagnostics must render inside the settings dialog');
  assert.match(source.slice(detailsStart), /onair\.output\.selector\.status\.selected/);
  assert.match(source.slice(detailsStart), /onair\.output\.selector\.status\.actual/);
});

test('compact output header and settings diagnostics have Korean and English copy', () => {
  const keys = [
    'onair.output.header.active.speaker',
    'onair.output.header.active.obs',
    'onair.output.header.standby.speaker',
    'onair.output.header.standby.obs',
    'onair.output.header.active.connecting',
    'onair.output.header.active.switching',
    'onair.output.header.active.attention',
    'onair.output.header.active.inactive',
    'onair.output.details.title',
    'onair.output.details.description',
    'obs.setup.openLabel',
    'obs.setup.openLabelAttention',
  ];

  for (const key of keys) {
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean copy for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English copy for ${key}`);
  }
});

test('the output selector state contract has Korean fallback copy for every public action and gate', () => {
  const camel = (value) => value.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
  const required = new Set([
    ...Object.values(ON_AIR_OUTPUT_ACTIONS)
      .map((action) => `onair.output.action.${action}.label`),
    ...Object.values(ON_AIR_OUTPUT_GATE_CODES)
      .map((code) => `onair.output.gate.${camel(code)}`),
    ...Object.values(ON_AIR_OUTPUT_LEASE_STATES)
      .map((state) => `onair.output.lease.${state}`),
    ...[...Object.values(ON_AIR_OUTPUT_MODES), 'unselected']
      .map((mode) => `onair.output.mode.${mode}`),
    ...['none', 'single', 'duplicate', 'unknown']
      .map((state) => `onair.output.candidate.${state}`),
    ...['matched', 'pending', 'conflict', 'unknown']
      .map((state) => `onair.output.playback.${state}`),
    ...['active', 'inactive', 'unknown']
      .map((state) => `onair.output.test.${state}`),
    ...['unavailable', 'invalid', 'unknown', 'localEventSent', 'localOnly', 'standby']
      .map((state) => `onair.output.adapter.${state}`),
    ...['speaker', 'obs', 'unselected'].flatMap((mode) => [
      `onair.output.status.${mode}.routeReady`,
      `onair.output.status.${mode}.playerPlaying`,
    ]),
    ...[
      'invalidInput',
      'stateUnknown',
      'activationFailed',
      'emergencyStopping',
      'deactivating',
      'activating',
      'candidateMissing',
      'candidateDuplicate',
      'inactive',
    ].map((status) => `onair.output.status.${status}`),
    'onair.output.verification.unknown',
    'onair.output.verification.stale',
    ...['speakerPlayback', 'obsMixer', 'obsRecording', 'obsStreamArtifact', 'karaokeSync']
      .flatMap((scope) => [
        `onair.output.verification.${scope}.passed`,
        `onair.output.verification.${scope}.stale`,
      ]),
  ]);

  const missing = [...required].filter((key) => !Object.hasOwn(outputMessageCatalog.ko, key));
  assert.deepEqual(missing, []);
});
