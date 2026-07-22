import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { outputMessageCatalog } from '../src/copy/outputMessages.js';

test('Speaker device UI is progressive, translated, and absent from OBS configuration', async () => {
  const panel = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  const prefix = 'settings.speakerDevice.';
  const koreanKeys = Object.keys(outputMessageCatalog.ko).filter((key) => key.startsWith(prefix)).sort();
  const englishKeys = Object.keys(outputMessageCatalog.en).filter((key) => key.startsWith(prefix)).sort();

  assert.deepEqual(englishKeys, koreanKeys);
  assert.ok(koreanKeys.length >= 10);
  assert.match(panel, /!isObsConfigurationVisible && speakerOutputDevice\?\.supported/);
  assert.match(panel, /speaker-device-current[^]*?role="status"[^]*?aria-live="polite"/);
  assert.match(panel, /speaker-device-failure[^]*?role="alert"/);
  assert.match(panel, /onChooseSpeakerOutputDevice/);
  assert.match(panel, /onResetSpeakerOutputDevice/);
});

test('Dashboard keeps Speaker sink selection outside OBS and playback command paths', async () => {
  const [dashboard, localSpeaker] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DashboardLocalSpeaker.jsx', import.meta.url), 'utf8'),
  ]);
  const chooseStart = dashboard.indexOf('const handleChooseSpeakerOutputDevice');
  const chooseEnd = dashboard.indexOf('const handleResetSpeakerOutputDevice', chooseStart);
  const resetEnd = dashboard.indexOf('const recordObsMixerVerification', chooseEnd);
  const deviceHandlers = dashboard.slice(chooseStart, resetEnd);

  assert.ok(chooseStart >= 0 && chooseEnd > chooseStart && resetEnd > chooseEnd);
  assert.doesNotMatch(
    deviceHandlers,
    /sendOnAirCommand|selectOnAirOutputMode|dispatchPlaybackCommand|updateOutputVolumeProfile/,
  );
  assert.match(dashboard, /speakerOutputDevice=\{speakerOutputDevice\}/);
  assert.match(dashboard, /sinkId=\{speakerOutputDevice\.deviceId\}/);
  assert.match(dashboard, /onSinkError=\{handleSpeakerSinkRestoreFailure\}/);
  assert.match(localSpeaker, /setSinkId\(deviceId\)[^]*?applySpeakerOutputDevice\(audioRef\.current, deviceId\)/);
});
