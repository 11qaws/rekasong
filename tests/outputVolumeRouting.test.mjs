import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Dashboard routes volume through the current run output profile', async () => {
  const source = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');

  assert.match(source, /loadOutputVolumeProfiles\(typeof window === 'undefined' \? null : window\.localStorage\)/);
  assert.match(
    source,
    /const volumeOutputMode = active\?\.outputMode === 'obs'[\s\S]*?active\?\.outputMode === 'speaker'[\s\S]*?selectedOutputMode === 'obs' \? 'obs' : 'speaker';/,
  );
  assert.match(
    source,
    /volume: outputVolumeForMode\(volumeProfilesRef\.current, runOutputMode\)/,
    'LOAD must use the profile owned by the new run, including OBS-to-Speaker migration',
  );
  assert.match(
    source,
    /const targetMode = activeRef\.current\?\.outputMode === 'obs'[\s\S]*?updateOutputVolumeProfile\(previous, targetMode, clamped\)/,
    'a live run must remain the authority for volume changes',
  );
  assert.match(
    source,
    /activeRun\?\.outputMode === targetMode[\s\S]*?dispatchPlaybackCommand\([\s\S]*?targetMode\)/,
    'an output profile may command only a current run owned by the same output',
  );
  assert.match(source, /outputVolumes=\{volumeProfiles\}/);
  assert.match(source, /onOutputVolumeChange=\{handleOutputVolumeChange\}/);
  assert.match(source, /volumeOutputMode=\{volumeOutputMode\}/);
  assert.doesNotMatch(source, /localStorage\.setItem\('rekasong_volume'/);
});

test('PlaybackPanel announces which output volume is being adjusted', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /volumeOutputMode = 'speaker'/);
  assert.match(
    source,
    /playback\.control\.volumeForOutput'[\s\S]*?mode: outputModeLabel\(volumeOutputMode\)/,
  );
  assert.match(source, /aria-valuetext=\{`\$\{Math\.round\(volumeDraft \?\? volume\)\}%`\}/);
  assert.match(source, /className="output-volume-profiles"/);
  assert.match(source, /onPointerUp=\{\(\) => commitOutputVolume\(mode\)\}/);
  assert.match(source, /onBlur=\{\(\) => commitOutputVolume\(mode\)\}/);
  assert.match(source, /aria-valuetext=\{`\$\{Math\.round\(displayedVolume\)\}%`\}/);
});
