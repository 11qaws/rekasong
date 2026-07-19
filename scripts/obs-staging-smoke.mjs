import { chromium } from 'playwright-core';

const WORKER = process.env.REKASONG_WORKER || 'https://rekasong-session.11qaws-test.workers.dev';
const APP = process.env.REKASONG_APP || 'http://127.0.0.1:5100';
const READY_TRACKS = {
  cold: 'JGwWNGJdvx8',
  prefetched: 'kXYiU_JCYtU',
  fallback: 'OPf0YbXqDm0'
};

const messages = [];
const pageErrors = [];
let passed = 0;
let failed = 0;
let control;
let browser;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
};

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};

const mediaState = (page) => page.evaluate(() => {
  const media = document.querySelector('audio.on-air-player');
  if (!media) return { exists: false };
  return {
    exists: true,
    srcKind: media.currentSrc.startsWith('blob:') ? 'blob' : media.currentSrc.includes('/v1/audio/') ? 'worker' : 'other',
    currentTime: media.currentTime,
    duration: media.duration,
    paused: media.paused,
    ended: media.ended,
    error: media.error?.code ?? null,
    readyState: media.readyState,
    networkState: media.networkState,
    bufferedEnd: media.buffered.length ? media.buffered.end(media.buffered.length - 1) : 0
  };
});

try {
  const sessionResponse = await fetch(`${WORKER}/v1/sessions`, { method: 'POST' });
  const session = await sessionResponse.json();
  check('staging session created', sessionResponse.ok && Boolean(session.room && session.controlToken && session.playerToken));

  const websocketUrl = new URL(`/v1/sessions/${session.room}/ws`, WORKER);
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  websocketUrl.searchParams.set('role', 'control');
  websocketUrl.searchParams.set('token', session.controlToken);

  control = new WebSocket(websocketUrl);
  control.addEventListener('message', (event) => {
    try {
      messages.push(JSON.parse(event.data));
    } catch {
      // Ignore non-JSON diagnostic frames.
    }
  });
  await new Promise((resolve, reject) => {
    control.addEventListener('open', resolve, { once: true });
    control.addEventListener('error', reject, { once: true });
  });
  check('control WebSocket connected', control.readyState === WebSocket.OPEN);

  const sendCommand = async (command) => {
    const commandId = `codex-${command.type}-${crypto.randomUUID()}`;
    const messageOffset = messages.length;
    control.send(JSON.stringify({ type: 'command', command: { ...command, commandId } }));
    const outcome = await waitFor(
      () => messages.slice(messageOffset).find((message) => (
        (message.type === 'command_ack' || message.type === 'command_rejected')
          && message.commandId === commandId
      ) || (
        message.type === 'error'
          && (message.commandId === commandId || !message.commandId)
      )),
      5_000,
      `${command.type} command terminal result`
    );
    if (outcome.type !== 'command_ack') {
      throw new Error(`${command.type} command ${outcome.type}: ${JSON.stringify(outcome)}`);
    }
    return commandId;
  };

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const widgetUrl = new URL('/#/widget', APP);
  widgetUrl.searchParams.set('mode', 'player');
  widgetUrl.searchParams.set('session', session.room);
  widgetUrl.searchParams.set('token', session.playerToken);
  widgetUrl.searchParams.set('api', WORKER);
  await page.goto(widgetUrl.toString(), { waitUntil: 'networkidle' });

  await waitFor(
    () => messages.some((message) => message.type === 'presence' && message.role === 'player' && message.connected),
    8_000,
    'player presence'
  );
  check('player role presence reported', true, 'this proves a player client connection, not OBS audio capture');

  await sendCommand({
    type: 'load',
    sessionId: 'codex-cold-run',
    song: { type: 'youtube', src: READY_TRACKS.cold, title: 'Codex cold-path smoke' },
    position: 0,
    volume: 100
  });
  await waitFor(async () => {
    const state = await mediaState(page);
    return state.exists && state.currentTime > 1.5 && !state.paused && state.error === null;
  }, 25_000, 'cold-path playback');
  const coldState = await mediaState(page);
  check('cold ready track plays through Worker streaming URL', coldState.srcKind === 'worker', JSON.stringify(coldState));

  await sendCommand({ type: 'pause', sessionId: 'codex-cold-run' });
  await waitFor(async () => (await mediaState(page)).paused, 5_000, 'pause reflected by media element');
  check('pause command reaches the real media element', true);

  const prefetchResponsePromise = page.waitForResponse(
    (response) => response.url().includes(`/v1/audio/${READY_TRACKS.prefetched}`),
    { timeout: 30_000 }
  );
  await sendCommand({ type: 'prefetch', videoIds: [READY_TRACKS.prefetched] });
  const prefetchResponse = await prefetchResponsePromise;
  await prefetchResponse.finished();
  check('prefetch response completed', prefetchResponse.ok(), `HTTP ${prefetchResponse.status()}`);

  await sendCommand({
    type: 'load',
    sessionId: 'codex-prefetched-run',
    song: { type: 'youtube', src: READY_TRACKS.prefetched, title: 'Codex blob-path smoke' },
    position: 0,
    volume: 100
  });
  await waitFor(async () => {
    const state = await mediaState(page);
    return state.srcKind === 'blob' && state.currentTime > 1 && !state.paused && state.error === null;
  }, 15_000, 'prefetched blob playback');
  const blobState = await mediaState(page);
  check('prefetched track uses a blob URL and plays', blobState.srcKind === 'blob', JSON.stringify(blobState));

  const smoothness = await page.evaluate(async (durationMs) => {
    const media = document.querySelector('audio.on-air-player');
    const counts = { waiting: 0, stalled: 0, error: 0 };
    const listeners = Object.keys(counts).map((type) => {
      const listener = () => { counts[type] += 1; };
      media.addEventListener(type, listener);
      return [type, listener];
    });
    const wallStart = performance.now();
    const mediaStart = media.currentTime;
    let previous = media.currentTime;
    let backwards = 0;
    const timer = setInterval(() => {
      if (media.currentTime + 0.001 < previous) backwards += 1;
      previous = media.currentTime;
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    clearInterval(timer);
    listeners.forEach(([type, listener]) => media.removeEventListener(type, listener));
    const wallElapsed = (performance.now() - wallStart) / 1000;
    const mediaElapsed = media.currentTime - mediaStart;
    return {
      ...counts,
      backwards,
      wallElapsed,
      mediaElapsed,
      deltaMs: Math.round((mediaElapsed - wallElapsed) * 1000),
      paused: media.paused,
      mediaError: media.error?.code ?? null
    };
  }, 10_000);
  check(
    '10s browser media clock progresses without stall or jump',
    smoothness.waiting === 0 && smoothness.stalled === 0 && smoothness.error === 0 && smoothness.backwards === 0 &&
      !smoothness.paused && smoothness.mediaError === null && Math.abs(smoothness.deltaMs) <= 350,
    JSON.stringify(smoothness)
  );

  await sendCommand({
    type: 'load',
    sessionId: 'codex-fallback-run',
    song: { type: 'youtube', src: READY_TRACKS.fallback, title: 'Codex streaming fallback smoke' },
    position: 0,
    volume: 100
  });
  await waitFor(async () => {
    const state = await mediaState(page);
    return state.srcKind === 'worker' && state.currentTime > 1 && !state.paused && state.error === null;
  }, 20_000, 'non-prefetched streaming playback');
  const fallbackState = await mediaState(page);
  check('ready but non-prefetched track falls back to streaming', fallbackState.srcKind === 'worker', JSON.stringify(fallbackState));

  check(
    'actual player events return to control',
    messages.some((message) => message.type === 'player_event' && message.event?.type === 'playing') &&
      messages.some((message) => message.type === 'player_event' && Number(message.event?.position) > 0)
  );
  check('player page emitted no uncaught errors', pageErrors.length === 0, pageErrors.join(' | '));

  await sendCommand({ type: 'stop', sessionId: 'codex-fallback-run' });
  const stoppedState = await waitFor(async () => {
    const state = await mediaState(page);
    return state.exists && state.paused && state.currentTime <= 0.1 ? state : null;
  }, 5_000, 'final STOP reflected by media element');
  check('final STOP is physically reflected before session end', true, JSON.stringify(stoppedState));

  await sendCommand({ type: 'end_session' });
} catch (error) {
  failed += 1;
  console.error(`FAIL smoke runner crashed — ${error.stack || error.message}`);
} finally {
  if (control?.readyState === WebSocket.OPEN) control.close();
  await browser?.close();
}

console.log(`RESULT ${passed} passed / ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
