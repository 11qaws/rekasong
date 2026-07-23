import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { transformWithOxc } from 'vite';

test('production Speaker keeps local files page-owned until explicit OBS demand', async () => {
  const [dashboard, localSpeaker, staging] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DashboardLocalSpeaker.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/StagingPanel.jsx', import.meta.url), 'utf8'),
  ]);

  await Promise.all([
    transformWithOxc(dashboard, 'Dashboard.jsx', { lang: 'jsx' }),
    transformWithOxc(localSpeaker, 'DashboardLocalSpeaker.jsx', { lang: 'jsx' }),
    transformWithOxc(staging, 'StagingPanel.jsx', { lang: 'jsx' }),
  ]);

  assert.match(
    dashboard,
    /const shouldMountLocalSpeaker = useOnAirPlayer && Boolean\([\s\S]*?stagedItem\?\.type === 'local'[\s\S]*?isLocalBlobSong\(currentEntry\?\.song\)[\s\S]*?state\?\.queue[\s\S]*?\{shouldMountLocalSpeaker && \([\s\S]*?<DashboardLocalSpeaker[\s\S]*?ensureSession=\{ensureOnAirSession\}/,
    'local file demand mounts the page-owned Speaker without requiring a media session',
  );
  assert.doesNotMatch(
    dashboard,
    /useOnAirPlayer && onAirSession\?\.room && onAirSession\?\.playerToken/,
  );

  const dropStart = dashboard.indexOf('const handleLocalFileDrop =');
  const aliasStart = dashboard.indexOf('const handleAliasChange =', dropStart);
  const dropFlow = dashboard.slice(dropStart, aliasStart);
  assert.match(dropFlow, /assetStatus: 'local'/);
  assert.doesNotMatch(dropFlow, /uploadAsset|retryLocalSpeakerSession/);

  const commitStart = dashboard.indexOf('const commitStagedItem =');
  const goLiveStart = dashboard.indexOf('const handleGoLive =', commitStart);
  const commitFlow = dashboard.slice(commitStart, goLiveStart);
  assert.match(commitFlow, /outputModePreference === 'obs'[\s\S]*?sourceItem\.type === 'local' && !sourceItem\.assetId/);
  assert.match(commitFlow, /src: sourceItem\.src/);
  assert.match(commitFlow, /assetId: sourceItem\.type === 'local' \? sourceItem\.assetId : undefined/);
  assert.doesNotMatch(commitFlow, /revokePageBlobSrcs/);

  const restoreStart = dashboard.indexOf('const handleRestoreLocalFile =');
  const restoreEnd = dashboard.indexOf('togglePlaybackRef.current =', restoreStart);
  const restoreFlow = dashboard.slice(restoreStart, restoreEnd);
  assert.match(restoreFlow, /blobSrc = createPageBlobSrc\(file\)/);
  assert.match(restoreFlow, /restoreLocalBlobSong\(sourceEntry\.song/);
  assert.doesNotMatch(restoreFlow, /uploadAsset/);

  assert.match(localSpeaker, /createSpeakerSourcePipeline\(\{[\s\S]*?ensureSession/);
  assert.match(localSpeaker, /\[apiBaseUrl, ensureSession\]/);
  assert.doesNotMatch(localSpeaker, /\[apiBaseUrl, room, token\]/);
  assert.match(
    staging,
    /const needsBroadcastAsset = outputMode === 'obs'[\s\S]*?type === 'local'[\s\S]*?!stagedItem\.assetId/,
    'an OBS upload may disable only the OBS action, never Speaker playback',
  );
  assert.match(
    staging,
    /stagedItem\.assetStatus === 'error' && onRetryLocalObsAsset[\s\S]*?t\('staging\.asset\.retry'\)/,
    'a failed staged OBS upload must expose an explicit translated retry action',
  );
  assert.match(
    dashboard,
    /const retryStagedLocalObsAsset = useCallback[\s\S]*?assetStatus: 'local'[\s\S]*?onRetryLocalObsAsset: retryStagedLocalObsAsset/,
  );
  assert.match(
    dashboard,
    /dispatchDeferredTransportCommand\(\{[\s\S]*?transport: localSpeakerRef\.current[\s\S]*?queue: localSpeakerCommandQueueRef\.current/,
    'a temporarily missing Speaker ref must queue instead of failing a live OBS-to-Speaker switch',
  );
  assert.match(
    dashboard,
    /const handleLocalSpeakerStateChange = useCallback[\s\S]*?reconcileDeferredTransportState[\s\S]*?onStateChange=\{handleLocalSpeakerStateChange\}/,
    'every physical controller-ready notification must drain commands even across ready-to-ready remounts',
  );
});

test('Speaker lifecycle observers report physical state but never own playback authority', async () => {
  const [dashboard, localSpeaker, localController] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/DashboardLocalSpeaker.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/localSpeakerController.js', import.meta.url), 'utf8'),
  ]);

  assert.match(
    localSpeaker,
    /const observeAfterResume = \(\) => \{[\s\S]*?controller\.observePhysicalState\(\)/,
  );
  assert.match(
    localSpeaker,
    /addEventListener\('visibilitychange', observeAfterResume\)[\s\S]*?addEventListener\('resume', observeAfterResume\)[\s\S]*?addEventListener\('pageshow', observeAfterResume\)[\s\S]*?addEventListener\('focus', observeAfterResume\)/,
  );
  const observationStart = localController.indexOf('const observePhysicalState =');
  const observationEnd = localController.indexOf('return Object.freeze({', observationStart);
  const observationFlow = localController.slice(observationStart, observationEnd);
  assert.match(observationFlow, /engine\.snapshot\(\)/);
  assert.doesNotMatch(
    observationFlow,
    /engine\.(?:load|play|pause|seek|stop|detach)|resolveSource|prefetchSources|WebSocket|lease|heartbeat/,
    'returning to a page may observe the existing graph but cannot mutate or reconnect it',
  );
  assert.doesNotMatch(
    `${localSpeaker}\n${localController}`,
    /addEventListener\(['"]pagehide|new WebSocket|leaseTarget|heartbeatTimer|sendHeartbeat/,
  );
  assert.match(dashboard, /const outputRouteStable = speakerPlayerMode \? true : establishedObsRouteConnected/);
  assert.match(
    dashboard,
    /isSpeakerResumeRequiredEvidence\(evidence\)[\s\S]*?speakerResumeRequiredRunId === active\?\.runId/,
  );
  assert.match(
    dashboard,
    /if \(mode === 'speaker'\) \{[\s\S]*?setOutputModePreference\('speaker'\)[\s\S]*?return;/,
  );
});
