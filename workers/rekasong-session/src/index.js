// A broadcast/browser-source restart can easily take longer than two minutes
// (OBS update, PC sleep, network handover). Keep the same URL recoverable for
// thirty minutes after the last dashboard/player leaves; explicit End Session
// remains the immediate cleanup path.
const SESSION_RECONNECT_GRACE_MS = 30 * 60 * 1000;
const SESSION_INITIAL_GRACE_MS = 30 * 60 * 1000;
const ASSET_DELETE_DELAY_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const PREPARE_LEASE_MS = 120 * 1000;
const PROTOCOL_V2 = 2;
// Heartbeats are observability, not an audio clock or a playback kill switch.
// Native WebSocket delivery remains the control and continuity signal. OBS
// active/visible callbacks describe scene state. A delayed heartbeat may
// exclude a standby source from a new activation, but it must never tear down
// an established route while its socket is still live.
const PLAYER_HEARTBEAT_WARNING_MS = 30 * 1000;
const PLAYER_HEARTBEAT_STALE_MS = 60 * 1000;
// The dashboard gives a route switch 12 seconds before surfacing a local
// timeout. Keep the same bounded window authoritative in the Durable Object so
// a missing terminal player event cannot leave the shared lease transitional
// forever, even after every browser that initiated the switch has gone away.
const V2_ROUTE_TRANSITION_TIMEOUT_MS = 12 * 1000;
const V2_ROUTE_TRANSITION_OPERATIONS = ['activate', 'deactivate'];
const V2_PLAYER_KINDS = ['dashboard-speaker', 'obs-browser-source', 'generic-browser'];
const V2_OUTPUT_MODES = ['speaker', 'obs'];
const V2_RUN_COMMANDS = ['load', 'play', 'pause', 'seek', 'volume', 'stop'];
const V2_ROUTE_COMMANDS = ['activate_output', 'deactivate_output'];
const V2_TEST_COMMANDS = ['start_test', 'stop_test'];
const V2_CONTROL_TAKEOVER_COMMAND = 'control_takeover';
const V2_CONTROL_AUX_COMMANDS = ['end_session', 'display_state', 'prefetch'];
const V2_PLAYBACK_EVENTS = [
  'command_received', 'command_applied', 'command_failed',
  'ready', 'playing', 'paused', 'buffering', 'position', 'ended', 'error', 'level'
];
const V2_ROUTE_EVENTS = [
  'output_deactivated',
  'output_ready',
  'output_activation_failed',
  'output_deactivation_failed'
];
const V2_TEST_EVENTS = ['test_started', 'test_marker', 'test_complete', 'test_failed'];
const V2_TEST_ACTIVE_MEDIA_STATUSES = new Set([
  'loading', 'ready', 'playing', 'paused', 'buffering'
]);
const V2_COMMAND_RESULT_CACHE_MAX_ENTRIES = 32;
const V2_COMMAND_RESULT_CACHE_MAX_BYTES = 12 * 1024;
const V2_EVENT_RESULT_CACHE_MAX_ENTRIES = 32;
const V2_SOCKET_ATTACHMENT_SAFE_MAX_BYTES = 15 * 1024;
const V2_EVENT_SEQUENCE_NAMESPACES = [
  'heartbeat', 'runTelemetry', 'runReceipt', 'runAuthoritative',
  'route', 'test', 'testTelemetry', 'emergency'
];
const V2_DURABLE_EVENT_NAMESPACES = ['runAuthoritative', 'route', 'test', 'emergency'];
const V2_DURABLE_EVENT_MAX_PLAYERS = 4;
const V2_DURABLE_EVENT_MAX_ENTRIES = 32;
const V2_DURABLE_EVENT_CHECKPOINT_MAX_BYTES = 64 * 1024;
const V2_FAILURE_DETAIL_MAX_BYTES = 2 * 1024;
const V2_TEST_MAX_MARKERS = 64;
const V2_DURABLE_MUTATION_QUEUE_KEY = Symbol('durable_mutation');
const V2_ACTIVE_OUTPUT_LIVENESS_REASONS = [
  'target_disconnected', 'target_heartbeat_stale', 'target_source_inactive'
];
const WEBSOCKET_MESSAGE_MAX_BYTES = 64 * 1024;
const LEGACY_WEBSOCKET_MESSAGE_MAX_BYTES = 1024 * 1024;
const WEBSOCKET_MESSAGE_MAX_DEPTH = 32;
const WEBSOCKET_MESSAGE_MAX_NODES = 4096;
// YouTube videoId는 정확히 11자다. 이 검증이 R2 키(audio/{videoId}) 오염과
// /v1/prepare/{stats|claim} 리터럴 라우트 충돌을 동시에 막는다.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const FAILURE_KINDS = ['botwall', 'unavailable', 'network', 'upload', 'unknown'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Rekasong-Name, X-Rekasong-Type, X-Rekasong-Size'
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
});

const randomToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const hashToken = async (token) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token || '')));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const parseBearer = (request) => request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';

const assetKey = (room, assetId) => `sessions/${room}/${assetId}`;

// 준비 캐시는 세션 자산(sessions/{room}/...)과 별개의 영구 네임스페이스다.
// deleteAssets()가 세션 종료 시 세션 경로를 지우므로, 여기에 섞이면 방송마다
// 캐시가 사라져 봇월 압력이 되돌아온다. (PREPARE_PIPELINE.md §1)
const audioKey = (videoId) => `audio/${videoId}`;

// Protocol v2 identity fields are deliberately bounded before they enter a
// WebSocket attachment or Durable Object storage. They are opaque IDs, not
// user-facing text; clients localize the stable status/error codes themselves.
const protocolId = (value, maxLength = 256) => {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  const hasControlCharacter = [...candidate]
    .some((character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127);
  if (!candidate || candidate !== value || candidate.length > maxLength || hasControlCharacter) return null;
  return candidate;
};

const finiteEpoch = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const boundedRecord = (value, allowedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(allowedKeys
    .filter((key) => ['string', 'number', 'boolean'].includes(typeof value[key]))
    .map((key) => [key, typeof value[key] === 'string' ? value[key].slice(0, 160) : value[key]]));
};

const boundedFailureDetail = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = structuredClone(value);
  const bytes = new TextEncoder().encode(JSON.stringify(detail)).byteLength;
  if (bytes <= V2_FAILURE_DETAIL_MAX_BYTES) return detail;
  return { truncated: true, originalBytes: bytes };
};

// JSON object key order is not an identity. Canonicalization lets retries use
// the same fingerprint even if a client reconstructs an equivalent object in
// a different insertion order. Incoming WebSocket messages are JSON, so the
// supported value set is deliberately the JSON value set.
const canonicalProtocolJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalProtocolJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalProtocolJson(value[key])}`)
    .join(',')}}`;
};

// JSON.parse itself is iterative/native, but the canonical fingerprint walk is
// recursive. Inspect every parsed frame (including unknown future extensions)
// before any type dispatch or canonicalization so a deeply nested or very wide
// value cannot turn into unbounded stack/CPU work.
const inspectProtocolJsonShape = (value) => {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > WEBSOCKET_MESSAGE_MAX_NODES) {
      return { ok: false, reason: 'message_too_complex', limit: WEBSOCKET_MESSAGE_MAX_NODES };
    }
    if (current.depth > WEBSOCKET_MESSAGE_MAX_DEPTH) {
      return { ok: false, reason: 'message_too_deep', limit: WEBSOCKET_MESSAGE_MAX_DEPTH };
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return { ok: true };
};

const decodeWebSocketPayload = (rawMessage, maxBytes) => {
  if (typeof rawMessage === 'string') {
    const bytes = new TextEncoder().encode(rawMessage).byteLength;
    if (bytes > maxBytes) return { ok: false, reason: 'message_too_large', bytes, limit: maxBytes };
    return { ok: true, text: rawMessage };
  }
  if (rawMessage instanceof ArrayBuffer || ArrayBuffer.isView(rawMessage)) {
    const bytes = rawMessage.byteLength;
    if (bytes > maxBytes) return { ok: false, reason: 'message_too_large', bytes, limit: maxBytes };
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(rawMessage) };
  }
  return { ok: false, reason: 'unsupported_message_encoding' };
};

// Keep this classification in lock-step with getOnAirSequenceNamespace() in
// src/lib/onAirProtocol.js. Samples and command receipt evidence must never
// consume authoritative playback/test lifecycle transition streams.
const v2EventSequenceNamespace = (message) => {
  if (message.type === 'player_heartbeat') return 'heartbeat';
  if (message.type === 'playback_event') {
    if (message.event === 'position' || message.event === 'level') return 'runTelemetry';
    if (message.event === 'command_received') return 'runReceipt';
    return 'runAuthoritative';
  }
  if (message.type === 'route_event') return 'route';
  if (message.type === 'test_event') {
    return message.event === 'test_marker' ? 'testTelemetry' : 'test';
  }
  if (message.type === 'emergency_stop_ack') return 'emergency';
  return null;
};

// connectionId is a transport fence, not semantic event content. Excluding it
// permits an already-applied event result to be recovered after a normal live
// reconnect while the new connection is still required to present its own ID.
const canonicalV2EventJson = (message) => {
  const semantic = { ...message };
  // Emergency postconditions prove that one exact transport stopped. Unlike
  // ordinary run/route/test retries, that proof must never migrate to a
  // replacement connection.
  if (message.type !== 'emergency_stop_ack') delete semantic.connectionId;
  return canonicalProtocolJson(semantic);
};

const isV2ControlCommandType = (type) => V2_RUN_COMMANDS.includes(type)
  || V2_ROUTE_COMMANDS.includes(type)
  || V2_TEST_COMMANDS.includes(type)
  || V2_CONTROL_AUX_COMMANDS.includes(type)
  || type === V2_CONTROL_TAKEOVER_COMMAND
  || type === 'emergency_stop';

// botwall은 재시도 자체가 압력이므로 일반 백오프보다 훨씬 길게(5분→30분).
const retryDelayMs = (failureKind, attempts) => {
  if (failureKind === 'botwall') return attempts <= 1 ? 5 * 60 * 1000 : 30 * 60 * 1000;
  return Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
};

const displaySong = (song) => {
  if (!song || typeof song !== 'object' || !song.id || !song.title) return null;
  const type = song.type === 'youtube' ? 'youtube' : 'local';
  return {
    id: String(song.id),
    title: String(song.title).slice(0, 240),
    type,
    src: type === 'youtube' && song.src ? String(song.src) : '',
    tags: Array.isArray(song.tags) ? song.tags.map((tag) => String(tag).slice(0, 48)).slice(0, 8) : []
  };
};

const displayState = (candidate) => {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  return {
    currentSong: displaySong(source.currentSong),
    history: Array.isArray(source.history) ? source.history.map(displaySong).filter(Boolean).slice(-100) : []
  };
};

const mediaResponse = (object) => {
  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', object.httpEtag);

  if (object.range) {
    const end = object.range.offset + object.range.length - 1;
    headers.set('Content-Range', `bytes ${object.range.offset}-${end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
};

// [/v1/audio · /v1/prepare(대시보드 구간) 공용 인증 설계]
// 캐시(audio/{videoId})는 전역이지만 세션·토큰은 방 단위라는 불일치를,
// "자격 = 활성 방송의 player 토큰 보유"로 조화시킨다. 요청자는
// ?room=...&token=... 으로 자기 방을 지목하고, 해당 SessionRoom이
// streamAsset과 동일한 player 검증을 대행한다. 어느 방의 토큰이든 다른 방이
// 준비한 캐시를 읽을 수 있는데, 이는 의도된 동작이다 — 캐시가 전역 공유인
// 것이 이 파이프라인의 존재 이유이고(§1), 토큰 검증의 목적은 방 간 격리가
// 아니라 오픈 프록시 차단이다(§3).
// 큐잉(POST /v1/prepare)도 같은 게이트를 쓴다: 재생할 수 없으면 큐잉도 할 수
// 없어야 한다. 무인증 큐잉은 VPS의 yt-dlp 요청량을 임의로 부풀려 "고유
// 영상당 평생 1회"라는 봇월 회피 전제(§0, §6) 자체를 무너뜨린다.
// 트레이드오프: 세션 없는 직접 재생(개발)은 지원하지 않는다. <audio src>는
// 헤더를 못 붙이므로 PREPARE_TOKEN 우회로를 열면 쿼리스트링으로 VPS 토큰이
// 새는 경로가 된다. 대시보드는 세션 생성 시 playerToken을 이미 받으므로
// (POST /v1/sessions 응답) 개발 재생도 세션만 있으면 이 경로로 충분하다.
const verifyRoomPlayerToken = async (request, env) => {
  const url = new URL(request.url);
  const room = url.searchParams.get('room') || '';
  const token = url.searchParams.get('token') || '';
  if (!/^[a-f0-9-]{8,64}$/i.test(room) || !token) return false;

  const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(room));
  const verified = await stub.fetch(new Request('https://session.internal/verify-media-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  }));
  return verified.ok;
};

const streamPreparedAudio = async (request, env, videoId) => {
  if (!(await verifyRoomPlayerToken(request, env))) return json({ error: 'Unauthorized' }, 401);

  const object = await env.MEDIA_BUCKET.get(audioKey(videoId), { range: request.headers });
  if (!object) return json({ error: 'Audio not prepared' }, 404);
  return mediaResponse(object);
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    const url = new URL(request.url);

    const audioMatch = url.pathname.match(/^\/v1\/audio\/([A-Za-z0-9_-]{11})$/);
    if (audioMatch && request.method === 'GET') return streamPreparedAudio(request, env, audioMatch[1]);

    if (url.pathname === '/v1/prepare' || url.pathname.startsWith('/v1/prepare/')) {
      // 대시보드 구간(큐잉·폴링)은 /v1/audio와 동일한 room+player 토큰 게이트.
      // claim/bytes/fail/heartbeat/stats는 DO 내부의 Bearer(PREPARE_TOKEN)가 담당.
      const dashboardRoute = (request.method === 'POST' && url.pathname === '/v1/prepare')
        || (request.method === 'GET' && /^\/v1\/prepare\/[A-Za-z0-9_-]{11}$/.test(url.pathname));
      if (dashboardRoute && !(await verifyRoomPlayerToken(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
      }
      // 준비 상태는 전역 싱글턴이 보유한다 — 캐시는 모든 방이 공유한다. (§2)
      const stub = env.PREPARE_QUEUE.get(env.PREPARE_QUEUE.idFromName('global'));
      return stub.fetch(request);
    }

    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      const room = crypto.randomUUID();
      const controlToken = randomToken();
      const playerToken = randomToken();
      const displayToken = randomToken();
      const id = env.SESSION_ROOM.idFromName(room);
      const stub = env.SESSION_ROOM.get(id);
      const initRequest = new Request('https://session.internal/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, controlToken, playerToken, displayToken })
      });
      const result = await stub.fetch(initRequest);
      if (!result.ok) return result;
      return json({ room, controlToken, playerToken, displayToken });
    }

    const routeMatch = url.pathname.match(/^\/v1\/sessions\/([a-f0-9-]+)\/(ws|assets|media|display-token|status)(?:\/([^/]+))?$/i);
    if (!routeMatch) return json({ error: 'Not found' }, 404);

    const [, room, route] = routeMatch;
    const id = env.SESSION_ROOM.idFromName(room);
    if (route === 'display-token') {
      const internalRequest = new Request('https://session.internal/display-token', {
        method: request.method,
        headers: request.headers
      });
      return env.SESSION_ROOM.get(id).fetch(internalRequest);
    }
    return env.SESSION_ROOM.get(id).fetch(request);
  }
};

export class SessionRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // 세션 인메모리 캐시(Gemini f461686). position 이벤트의 storage.put 을 건너뛰는
    // 최적화가 안전하려면, 미영속 변경(진행도)이 같은 인스턴스 내 후속 읽기에
    // 일관되게 보여야 한다 — DO 는 단일 스레드라 이 캐시가 경합 없이 성립한다.
    this.sessionState = null;
    // Same-live-connection commands can overlap while the first handler awaits
    // storage. The terminal cache lives in the socket attachment (hibernation
    // safe); this Map only coalesces that short in-flight window and is rebuilt
    // empty after a Durable Object restart.
    this.pendingV2Commands = new Map();
    // Player events are serialized per instance; authoritative commits also
    // take one shared queue key so different players cannot overwrite the same
    // bounded session checkpoint while a storage write is in flight.
    this.pendingV2EventQueues = new Map();
    // Hibernation recreates the object but preserves both socket attachments
    // and the durable alarm. The first heartbeat after a recreation verifies
    // that an alarm exists; later healthy heartbeats can stay storage-free.
    this.activeOutputHeartbeatAlarmKnown = false;
    // All events in a freshly created/rehydrated object share this bootstrap.
    // It is also the deployment migration gate for route transitions written
    // before durable transition identities existed.
    this.sessionBootstrapPromise = null;
    this.sessionBootstrapComplete = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/init') return this.initialize(request);
    if (request.method === 'POST' && url.pathname === '/verify-media-token') return this.verifyMediaToken(request);
    if (request.method === 'GET' && url.pathname.endsWith('/status')) return this.sessionStatus(request);
    if (url.pathname.endsWith('/ws')) return this.openSocket(request);
    if ((url.pathname === '/display-token' || url.pathname.endsWith('/display-token')) && request.method === 'POST') return this.issueDisplayToken(request);
    if (url.pathname.endsWith('/assets') && request.method === 'POST') return this.uploadAsset(request);
    if (/\/media\/[^/]+$/.test(url.pathname) && request.method === 'GET') return this.streamAsset(request);
    return json({ error: 'Not found' }, 404);
  }

  async initialize(request) {
    const existing = await this.ctx.storage.get('session');
    if (existing) return json({ error: 'Session already exists' }, 409);
    const { room, controlToken, playerToken, displayToken } = await request.json();
    if (!room || !controlToken || !playerToken || !displayToken) return json({ error: 'Invalid session setup' }, 400);

    const newSession = {
      room,
      status: 'active',
      controlHash: await hashToken(controlToken),
      playerHash: await hashToken(playerToken),
      displayHash: await hashToken(displayToken),
      assets: {},
      transport: { status: 'idle', song: null, sessionId: null, position: 0, volume: 100 },
      protocolV2: {
        controlEpoch: 0,
        writableControlInstanceId: null,
        leaseEpoch: 0,
        leaseTarget: null,
        leaseClientKind: null,
        leaseStatus: 'inactive',
        selectedOutputMode: null,
        switchId: null,
        routeTransitionDeadlineAt: null,
        routeTransitionIdentity: null,
        activeFamily: null,
        activeCheckId: null,
        activeCheckProgress: null,
        pendingEmergencyCommandId: null,
        pendingEmergencyControlInstanceId: null,
        pendingEmergencyRequiredPlayerInstanceId: null,
        pendingEmergencyRequiredTargetKnown: false,
        pendingEmergencyTargets: [],
        pendingEmergencyTargetInstances: {},
        emergencyAcknowledgedTargets: [],
        pendingEmergencyLegacyCount: 0,
        playerEventCheckpoints: [],
        desiredTransport: { status: 'idle', song: null, entryId: null, runId: null, position: 0, volume: 100 },
        confirmedPlayback: { status: 'unknown', reasonCode: 'not_confirmed' }
      },
      display: { currentSong: null, history: [] },
      endedAt: null,
      cleanupAt: null
    };
    await this.ctx.storage.put('session', newSession);
    this.sessionState = newSession;
    // A staging upload can create a session before OBS has opened its player.
    // Do not retain those files forever if the broadcast is never started.
    await this.ctx.storage.setAlarm(Date.now() + SESSION_INITIAL_GRACE_MS);
    return json({ ok: true });
  }

  async getSession() {
    if (this.sessionBootstrapComplete) return this.sessionState;
    if (!this.sessionBootstrapPromise) {
      this.sessionBootstrapPromise = (async () => {
        if (!this.sessionState) this.sessionState = await this.ctx.storage.get('session');
        const issue = this.invalidRouteTransitionMetadataIssue(this.sessionState);
        if (issue) await this.persistInvalidRouteTransitionUnknown(this.sessionState, issue);
        this.sessionBootstrapComplete = true;
        return this.sessionState;
      })();
    }
    try {
      return await this.sessionBootstrapPromise;
    } finally {
      this.sessionBootstrapPromise = null;
    }
  }

  async sessionStatus(request) {
    const session = await this.getSession();
    const token = parseBearer(request);
    if (!session || !(await this.authenticate(session, token, 'control'))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (session.status === 'ended') return json({ status: 'ended' }, 410);
    if (session.status !== 'active') return json({ error: 'Unauthorized' }, 401);
    return json({ status: 'active' });
  }

  async issueDisplayToken(request) {
    const session = await this.getSession();
    const token = parseBearer(request);
    if (!session || session.status !== 'active' || !(await this.authenticate(session, token, 'control'))) {
      return json({ error: 'Unauthorized or closed session' }, 401);
    }

    const displayToken = randomToken();
    session.displayHash = await hashToken(displayToken);
    session.display = session.display || { currentSong: null, history: [] };
    await this.ctx.storage.put('session', session);
    return json({ displayToken });
  }

  // streamPreparedAudio가 전역 캐시 접근 자격을 이 방에 위임할 때 쓰는 내부
  // 라우트. streamAsset과 동일한 player 검증만 통과시킨다 — control/display로
  // 넓히면 위젯 URL 유출만으로 오디오가 열리는 표면이 생긴다.
  async verifyMediaToken(request) {
    const session = await this.getSession();
    const { token } = await request.json().catch(() => ({}));
    if (!session || session.status !== 'active' || !(await this.authenticate(session, token, 'player'))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return json({ ok: true });
  }

  async authenticate(session, token, role) {
    if (!session || !token) return false;
    const expected = role === 'control'
      ? session.controlHash
      : role === 'player'
        ? session.playerHash
        : session.displayHash;
    return Boolean(expected) && expected === await hashToken(token);
  }

  async openSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426);
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') || '';
    const requestedProtocol = url.searchParams.get('protocol');
    if (!['control', 'player', 'display'].includes(role)) return json({ error: 'Invalid socket role' }, 400);
    if (requestedProtocol && requestedProtocol !== String(PROTOCOL_V2)) {
      return json({ error: 'unsupported_socket_protocol' }, 400);
    }
    if (requestedProtocol === String(PROTOCOL_V2) && role === 'display') {
      return json({ error: 'unsupported_socket_protocol_role' }, 400);
    }

    const session = await this.getSession();
    if (!session || session.status !== 'active' || !(await this.authenticate(session, token, role))) {
      return json({ error: 'Unauthorized or closed session' }, 401);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const protocolV2OptIn = requestedProtocol === String(PROTOCOL_V2);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      role,
      protocolVersion: protocolV2OptIn ? PROTOCOL_V2 : 1,
      negotiationState: protocolV2OptIn ? 'unnegotiated' : 'legacy',
      connectionId: crypto.randomUUID(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now()
    });
    // The OBS player being back is the only signal that broadcast output is
    // live again. A controller refresh must not keep abandoned media alive.
    if (role === 'player' && !protocolV2OptIn) {
      await this.reconcileConnectedPlayerAlarm(session);
    }
    if (!protocolV2OptIn) {
      this.send(server, {
        type: 'snapshot',
        transport: session.transport,
        display: session.display || { currentSong: null, history: [] },
        // 현재 위젯 연결 상태(런타임 소켓 집계 — 스토리지 스키마 불변).
        // control 이 언제 붙거나 재접속해도 이미 연결된 위젯을 즉시 안다.
        presence: this.connectedWidgetPresence(),
        protocolV2: this.protocolV2Snapshot(session),
        session: { room: session.room, status: session.status }
      });
    }
    // 위젯(player·display) 연결은 control 에, control 연결은 player 에 알린다.
    // display 도 대칭으로 브로드캐스트한다 — OBS 설정 흐름에서 화면 정보 위젯이
    // 실제로 들어왔는지 대시보드가 확인해야 하기 때문.
    if (!protocolV2OptIn && (role === 'player' || role === 'display')) {
      this.broadcastLegacyControls({ type: 'presence', role, connected: true });
    }
    if (!protocolV2OptIn && role === 'control') {
      this.broadcastLegacyPlayers({ type: 'presence', role, connected: true });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    const attachment = socket.deserializeAttachment() || {};
    const maxBytes = attachment.protocolVersion === PROTOCOL_V2
      ? WEBSOCKET_MESSAGE_MAX_BYTES
      : LEGACY_WEBSOCKET_MESSAGE_MAX_BYTES;
    let decoded;
    let message;
    try {
      decoded = decodeWebSocketPayload(rawMessage, maxBytes);
      if (!decoded.ok) return this.sendInvalidMessage(socket, decoded);
      message = JSON.parse(decoded.text);
    } catch {
      return this.sendInvalidMessage(socket, { reason: 'invalid_json' });
    }
    const shape = inspectProtocolJsonShape(message);
    if (!shape.ok || !message || typeof message !== 'object' || Array.isArray(message)) {
      return this.sendInvalidMessage(socket, shape.ok ? { reason: 'message_must_be_object' } : shape);
    }

    const role = attachment.role;
    const session = await this.getSession();
    if (!session || session.status !== 'active') {
      if (role === 'control' && attachment.protocolVersion === PROTOCOL_V2
        && attachment.negotiationState === 'negotiated') {
        if (isV2ControlCommandType(message.type)
          && await this.replayCachedV2Command(socket, message)) return;
        if (!isV2ControlCommandType(message.type)
          && this.rejectCachedV2CommandIdConflict(socket, message)) return;
      }
      return this.sendSessionEnded(socket, session, 'session_inactive');
    }

    if (role === 'control') {
      if (message.type === 'control_hello') {
        await this.handleControlHello(socket, session, message);
        return;
      }
      if (message.type === 'control_heartbeat') {
        this.handleV2ControlHeartbeat(socket, message);
        return;
      }

      const directV2Command = isV2ControlCommandType(message.type);
      if (directV2Command) {
        await this.handleV2Command(socket, session, message);
        return;
      }
      if (message.type === 'command' && attachment.protocolVersion === PROTOCOL_V2) {
        return this.sendProtocolError(socket, 'legacy_envelope_forbidden');
      }
      if (attachment.protocolVersion === PROTOCOL_V2
        && attachment.negotiationState === 'negotiated') {
        if (this.rejectCachedV2CommandIdConflict(socket, message)) return;
        return this.sendProtocolError(socket, 'unknown_message_type', { type: message.type });
      }
      if (message.type === 'command') await this.handleCommand(socket, session, message);
      return;
    }
    if (role !== 'player') return;

    if (message.type === 'player_hello') {
      await this.handlePlayerHello(socket, session, message);
      return;
    }
    if (attachment.protocolVersion === PROTOCOL_V2) {
      if (message.type === 'player_heartbeat') return this.handleV2Heartbeat(socket, session, message);
      if (message.type === 'playback_event') return this.handleV2PlaybackEvent(socket, session, message);
      if (message.type === 'route_event') return this.handleV2RouteEvent(socket, session, message);
      if (message.type === 'test_event') return this.handleV2TestEvent(socket, session, message);
      if (message.type === 'emergency_stop_ack') return this.handleV2EmergencyAck(socket, session, message);
      return this.sendProtocolError(socket, 'unknown_message_type', { type: message.type });
    }
    if (message.type === 'event') await this.handlePlayerEvent(session, message);
  }

  invalidRouteTransitionMetadataIssue(session) {
    if (!session || session.status !== 'active') return null;
    const prior = session.protocolV2;
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return null;
    const leaseStatus = protocolId(prior.leaseStatus);
    if (!['activating', 'deactivating'].includes(leaseStatus)) return null;

    const operation = leaseStatus === 'activating' ? 'activate' : 'deactivate';
    const leaseEpoch = finiteEpoch(prior.leaseEpoch);
    const switchId = protocolId(prior.switchId);
    const targetPlayerInstanceId = protocolId(prior.leaseTarget);
    const deadlineAt = finiteEpoch(prior.routeTransitionDeadlineAt);
    const identity = prior.routeTransitionIdentity;
    const validIdentity = Boolean(
      identity && typeof identity === 'object' && !Array.isArray(identity)
      && identity.operation === operation
      && finiteEpoch(identity.leaseEpoch) === leaseEpoch
      && protocolId(identity.switchId) === switchId
      && protocolId(identity.targetPlayerInstanceId) === targetPlayerInstanceId
      && leaseEpoch !== null
      && switchId
      && targetPlayerInstanceId
      && deadlineAt !== null
    );
    if (validIdentity) return null;
    return { operation, leaseEpoch, switchId, targetPlayerInstanceId };
  }

  async persistInvalidRouteTransitionUnknown(session, issue) {
    const candidate = structuredClone(session);
    const protocol = this.ensureProtocolV2(candidate);
    protocol.leaseStatus = 'unknown';
    protocol.confirmedPlayback = {
      status: 'unknown',
      reasonCode: 'route_transition_metadata_missing',
      operation: issue.operation,
      ...(issue.targetPlayerInstanceId
        ? { playerInstanceId: issue.targetPlayerInstanceId }
        : {}),
      ...(issue.leaseEpoch !== null ? { leaseEpoch: issue.leaseEpoch } : {}),
      ...(issue.switchId ? { switchId: issue.switchId } : {})
    };
    this.clearRouteTransition(protocol);
    candidate.transport = { ...(candidate.transport || {}), status: 'unknown' };
    await this.ctx.storage.put('session', candidate);
    this.adoptPersistedSession(session, candidate);
    this.publishActiveOutputUnknown(session);
    return session;
  }

  ensureProtocolV2(session) {
    const prior = session.protocolV2 || {};
    const transport = session.transport || {};
    const pendingEmergencyTargets = Array.isArray(prior.pendingEmergencyTargets)
      ? [...new Set(prior.pendingEmergencyTargets
        .map((value) => protocolId(value))
        .filter(Boolean))].slice(0, 32)
      : [];
    const pendingEmergencyTargetSet = new Set(pendingEmergencyTargets);
    const pendingEmergencyTargetInstances = prior.pendingEmergencyTargetInstances
      && typeof prior.pendingEmergencyTargetInstances === 'object'
      && !Array.isArray(prior.pendingEmergencyTargetInstances)
      ? Object.fromEntries(Object.entries(prior.pendingEmergencyTargetInstances)
        .map(([connectionId, playerInstanceId]) => [protocolId(connectionId), protocolId(playerInstanceId)])
        .filter(([connectionId, playerInstanceId]) => (
          connectionId && playerInstanceId && pendingEmergencyTargetSet.has(connectionId)
        ))
        .slice(0, 32))
      : {};
    const activeCheckId = protocolId(prior.activeCheckId);
    const priorCheckProgress = prior.activeCheckProgress
      && typeof prior.activeCheckProgress === 'object'
      && !Array.isArray(prior.activeCheckProgress)
      && protocolId(prior.activeCheckProgress.checkId) === activeCheckId
      ? prior.activeCheckProgress
      : null;
    const priorMarkerCount = finiteEpoch(priorCheckProgress?.markerCount);
    const checkStarted = priorCheckProgress?.started === true;
    const priorRouteTransitionIdentity = prior.routeTransitionIdentity
      && typeof prior.routeTransitionIdentity === 'object'
      && !Array.isArray(prior.routeTransitionIdentity)
      ? prior.routeTransitionIdentity
      : null;
    const routeTransitionDeadlineAt = finiteEpoch(prior.routeTransitionDeadlineAt);
    const routeTransitionIdentity = priorRouteTransitionIdentity
      && V2_ROUTE_TRANSITION_OPERATIONS.includes(priorRouteTransitionIdentity.operation)
      && finiteEpoch(priorRouteTransitionIdentity.leaseEpoch) !== null
      && protocolId(priorRouteTransitionIdentity.switchId)
      && protocolId(priorRouteTransitionIdentity.targetPlayerInstanceId)
      && routeTransitionDeadlineAt !== null
      ? {
          operation: priorRouteTransitionIdentity.operation,
          leaseEpoch: finiteEpoch(priorRouteTransitionIdentity.leaseEpoch),
          switchId: protocolId(priorRouteTransitionIdentity.switchId),
          targetPlayerInstanceId: protocolId(priorRouteTransitionIdentity.targetPlayerInstanceId)
        }
      : null;
    session.protocolV2 = {
      controlEpoch: finiteEpoch(prior.controlEpoch) ?? 0,
      writableControlInstanceId: protocolId(prior.writableControlInstanceId),
      leaseEpoch: finiteEpoch(prior.leaseEpoch) ?? 0,
      leaseTarget: protocolId(prior.leaseTarget),
      leaseClientKind: V2_PLAYER_KINDS.includes(prior.leaseClientKind) ? prior.leaseClientKind : null,
      leaseStatus: protocolId(prior.leaseStatus) || 'inactive',
      selectedOutputMode: V2_OUTPUT_MODES.includes(prior.selectedOutputMode) ? prior.selectedOutputMode : null,
      switchId: protocolId(prior.switchId),
      routeTransitionDeadlineAt: routeTransitionIdentity ? routeTransitionDeadlineAt : null,
      routeTransitionIdentity,
      activeFamily: prior.activeFamily && typeof prior.activeFamily === 'object'
        ? { entryId: protocolId(prior.activeFamily.entryId), runId: protocolId(prior.activeFamily.runId) }
        : null,
      activeCheckId,
      activeCheckProgress: activeCheckId
        ? {
            checkId: activeCheckId,
            started: checkStarted,
            markerCount: checkStarted && priorMarkerCount !== null
              && priorMarkerCount <= V2_TEST_MAX_MARKERS ? priorMarkerCount : 0
          }
        : null,
      pendingEmergencyCommandId: protocolId(prior.pendingEmergencyCommandId),
      pendingEmergencyControlInstanceId: protocolId(prior.pendingEmergencyControlInstanceId),
      pendingEmergencyRequiredPlayerInstanceId: protocolId(
        prior.pendingEmergencyRequiredPlayerInstanceId
      ),
      pendingEmergencyRequiredTargetKnown: prior.pendingEmergencyRequiredTargetKnown === true,
      pendingEmergencyTargets,
      pendingEmergencyTargetInstances,
      emergencyAcknowledgedTargets: Array.isArray(prior.emergencyAcknowledgedTargets)
        ? prior.emergencyAcknowledgedTargets.map((value) => protocolId(value)).filter(Boolean).slice(0, 32)
        : [],
      pendingEmergencyLegacyCount: finiteEpoch(prior.pendingEmergencyLegacyCount) ?? 0,
      playerEventCheckpoints: this.normalizedV2DurableEventCheckpoints(prior.playerEventCheckpoints),
      desiredTransport: prior.desiredTransport && typeof prior.desiredTransport === 'object'
        ? prior.desiredTransport
        : {
            status: transport.status || 'idle',
            song: transport.song || null,
            entryId: null,
            runId: null,
            position: Number(transport.position) || 0,
            volume: Number.isFinite(transport.volume) ? transport.volume : 100
          },
      confirmedPlayback: prior.confirmedPlayback && typeof prior.confirmedPlayback === 'object'
        ? prior.confirmedPlayback
        : { status: 'unknown', reasonCode: 'not_confirmed' }
    };
    if (!session.protocolV2.activeFamily?.entryId || !session.protocolV2.activeFamily?.runId) {
      session.protocolV2.activeFamily = null;
    }
    return session.protocolV2;
  }

  sessionEndBlockDetail(session) {
    const protocol = this.ensureProtocolV2(session);
    const activeTransportStates = new Set(['loading', 'playing', 'paused', 'buffering']);
    const leaseStatus = protocol.leaseStatus || 'inactive';
    const desiredStatus = protocol.desiredTransport?.status || null;
    const confirmedStatus = protocol.confirmedPlayback?.status || null;
    const transportStatus = session.transport?.status || null;
    const blocked = Boolean(
      protocol.activeFamily
      || protocol.activeCheckId
      || !['inactive', 'ready'].includes(leaseStatus)
      || activeTransportStates.has(desiredStatus)
      || activeTransportStates.has(confirmedStatus)
      || activeTransportStates.has(transportStatus)
    );
    if (!blocked) return null;
    return {
      leaseStatus,
      desiredStatus,
      confirmedStatus,
      transportStatus,
      activeFamily: Boolean(protocol.activeFamily),
      activeCheck: Boolean(protocol.activeCheckId)
    };
  }

  isV2StrongStoppedPlayback(confirmedPlayback) {
    return Boolean(
      confirmedPlayback
      && typeof confirmedPlayback === 'object'
      && !Array.isArray(confirmedPlayback)
      && confirmedPlayback.status === 'stopped'
      && confirmedPlayback.paused === true
      && confirmedPlayback.sourceDetached === true
      && confirmedPlayback.autoplayCancelled === true
      && confirmedPlayback.audible === false
    );
  }

  controlTakeoverBlockDetail(session) {
    const protocol = this.ensureProtocolV2(session);
    const desired = protocol.desiredTransport;
    const confirmed = protocol.confirmedPlayback;
    const leaseStatus = protocol.leaseStatus || null;
    const desiredStatus = desired?.status || null;
    const confirmedStatus = confirmed?.status || null;
    const transportStatus = session.transport?.status || null;
    const exactIdleDesired = Boolean(
      desired
      && typeof desired === 'object'
      && !Array.isArray(desired)
      && desiredStatus === 'idle'
      && desired.song === null
      && desired.entryId === null
      && desired.runId === null
    );
    const coldIdleConfirmation = confirmedStatus === 'unknown'
      && ['not_confirmed', 'output_inactive'].includes(confirmed?.reasonCode);
    const inactiveRouteConfirmation = confirmedStatus === 'unknown'
      && confirmed?.reasonCode === 'output_inactive';
    const strongStopped = this.isV2StrongStoppedPlayback(confirmed);
    const exactStrongStopped = desiredStatus === 'stopped'
      && transportStatus === 'stopped'
      && strongStopped;
    const stoppedAfterInactiveRoute = desiredStatus === 'stopped'
      && transportStatus === 'stopped'
      && inactiveRouteConfirmation;
    const confirmedAudible = confirmed?.audible === true || confirmedStatus === 'playing';
    const pendingEmergency = Boolean(
      protocol.pendingEmergencyCommandId
      || protocol.pendingEmergencyControlInstanceId
      || protocol.pendingEmergencyRequiredPlayerInstanceId
      || protocol.pendingEmergencyRequiredTargetKnown
      || protocol.pendingEmergencyTargets.length > 0
      || Object.keys(protocol.pendingEmergencyTargetInstances).length > 0
      || protocol.emergencyAcknowledgedTargets.length > 0
      || protocol.pendingEmergencyLegacyCount !== 0
    );
    const safe = leaseStatus === 'inactive'
      && protocol.leaseTarget === null
      && protocol.leaseClientKind === null
      && protocol.switchId === null
      && protocol.activeFamily === null
      && protocol.activeCheckId === null
      && protocol.activeCheckProgress === null
      && !pendingEmergency
      && !confirmedAudible
      && (
        (exactIdleDesired && coldIdleConfirmation && transportStatus === 'idle')
        || exactStrongStopped
        || stoppedAfterInactiveRoute
      );
    if (safe) return null;
    return {
      leaseStatus,
      leaseTarget: protocol.leaseTarget,
      switchId: protocol.switchId,
      activeFamily: Boolean(protocol.activeFamily),
      activeCheck: Boolean(protocol.activeCheckId || protocol.activeCheckProgress),
      pendingEmergency,
      desiredStatus,
      confirmedStatus,
      confirmedReasonCode: confirmed?.reasonCode || null,
      confirmedAudible,
      strongStopped,
      transportStatus
    };
  }

  livePlayerRecords(excluded) {
    const records = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excluded) continue;
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.role !== 'player' || attachment.protocolVersion !== PROTOCOL_V2
        || attachment.negotiationState !== 'negotiated' || !attachment.playerInstanceId) continue;
      records.push({ socket, attachment });
    }
    return records;
  }

  playerHeartbeatHealth(attachment, now = Date.now()) {
    const observedAt = Number.isFinite(attachment?.lastSeenAt)
      ? attachment.lastSeenAt
      : Number.isFinite(attachment?.connectedAt) ? attachment.connectedAt : now;
    const heartbeatAgeMs = Math.max(0, now - observedAt);
    return {
      lastSeenAt: observedAt,
      heartbeatAgeMs,
      heartbeatWarning: heartbeatAgeMs >= PLAYER_HEARTBEAT_WARNING_MS,
      heartbeatStale: heartbeatAgeMs >= PLAYER_HEARTBEAT_STALE_MS
    };
  }

  activeOutputHeartbeatDeadline(session, { overrideAttachment = null, now = Date.now() } = {}) {
    const protocol = this.ensureProtocolV2(session);
    if (!protocol.leaseTarget || !['activating', 'ready', 'audible'].includes(protocol.leaseStatus)) {
      return null;
    }
    const attachments = this.livePlayerRecords()
      .filter(({ attachment }) => attachment.playerInstanceId === protocol.leaseTarget)
      .map(({ attachment }) => attachment);
    if (overrideAttachment?.playerInstanceId === protocol.leaseTarget) {
      attachments.push(overrideAttachment);
    }
    if (attachments.length === 0) return now;
    const freshestSeenAt = Math.max(...attachments
      .map((attachment) => this.playerHeartbeatHealth(attachment, now).lastSeenAt));
    return freshestSeenAt + PLAYER_HEARTBEAT_STALE_MS;
  }

  routeTransitionIdentityMatches(left, right) {
    return Boolean(
      left && right
      && left.operation === right.operation
      && left.leaseEpoch === right.leaseEpoch
      && left.switchId === right.switchId
      && left.targetPlayerInstanceId === right.targetPlayerInstanceId
    );
  }

  currentRouteTransitionForProtocol(protocol) {
    const identity = protocol.routeTransitionIdentity;
    const deadlineAt = finiteEpoch(protocol.routeTransitionDeadlineAt);
    if (!identity || deadlineAt === null) return null;
    const expectedStatus = identity.operation === 'activate' ? 'activating' : 'deactivating';
    if (protocol.leaseStatus !== expectedStatus
      || protocol.leaseEpoch !== identity.leaseEpoch
      || protocol.switchId !== identity.switchId
      || protocol.leaseTarget !== identity.targetPlayerInstanceId) {
      return null;
    }
    return { deadlineAt, identity: { ...identity } };
  }

  currentRouteTransition(session) {
    return this.currentRouteTransitionForProtocol(this.ensureProtocolV2(session));
  }

  beginRouteTransition(protocol, operation, now = Date.now()) {
    const identity = {
      operation,
      leaseEpoch: protocol.leaseEpoch,
      switchId: protocol.switchId,
      targetPlayerInstanceId: protocol.leaseTarget
    };
    protocol.routeTransitionDeadlineAt = now + V2_ROUTE_TRANSITION_TIMEOUT_MS;
    protocol.routeTransitionIdentity = identity;
    return { deadlineAt: protocol.routeTransitionDeadlineAt, identity: { ...identity } };
  }

  clearRouteTransition(protocol, expectedIdentity = null) {
    if (expectedIdentity
      && !this.routeTransitionIdentityMatches(protocol.routeTransitionIdentity, expectedIdentity)) {
      return false;
    }
    protocol.routeTransitionDeadlineAt = null;
    protocol.routeTransitionIdentity = null;
    return true;
  }

  routeTransitionDeadline(session) {
    return this.currentRouteTransition(session)?.deadlineAt ?? null;
  }

  outputSafetyAlarmDeadline(session) {
    const deadlines = [
      this.routeTransitionDeadline(session)
    ].filter((deadline) => deadline !== null);
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }

  async ensureActiveOutputHeartbeatAlarm(session, options = {}) {
    const deadline = this.outputSafetyAlarmDeadline(session, options);
    if (deadline === null) {
      this.activeOutputHeartbeatAlarmKnown = false;
      return null;
    }
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || deadline < currentAlarm) {
      await this.ctx.storage.setAlarm(deadline);
      this.activeOutputHeartbeatAlarmKnown = true;
      return deadline;
    }
    // An earlier initial-grace, reconnect-grace, cleanup, or route transition
    // alarm must never be postponed by safety maintenance. Heartbeat age is
    // deliberately absent: it is displayed as health telemetry and does not
    // own a destructive deadline for an already-established OBS route.
    this.activeOutputHeartbeatAlarmKnown = true;
    return currentAlarm;
  }

  async reconcileConnectedPlayerAlarm(session, options = {}) {
    if (this.outputSafetyAlarmDeadline(session, options) !== null) {
      return this.ensureActiveOutputHeartbeatAlarm(session, options);
    }
    await this.ctx.storage.deleteAlarm();
    this.activeOutputHeartbeatAlarmKnown = false;
    return null;
  }

  eligiblePlayerRecords(mode, excluded) {
    const now = Date.now();
    return this.livePlayerRecords(excluded).filter(({ attachment }) => {
      if (mode === 'speaker') {
        // Speaker playback is a normal browser media route. Mobile background
        // tabs, PiP and BFCache can pause/throttle its low-rate heartbeat while the
        // WebSocket and audio element remain alive. Candidate eligibility is
        // therefore based on the live socket for speakers; OBS keeps the
        // strict heartbeat gate below because its browser-source attestation
        // is part of the broadcast safety contract.
        return attachment.clientKind === 'dashboard-speaker'
          && attachment.runtime?.sourceActive !== false;
      }
      if (mode === 'obs') {
        if (this.playerHeartbeatHealth(attachment, now).heartbeatStale) return false;
        return attachment.clientKind === 'obs-browser-source'
          // obs-browser only publishes active/visible *changes*. A source that
          // loads while already active has no initial value to report. Accept
          // that unobserved state, but keep an explicit inactive callback as a
          // strict gate for a new route.
          && attachment.runtime?.sourceActive !== false
          && (attachment.capabilities?.obsRuntime === true || attachment.capabilities?.obsStudioBinding === true);
      }
      return false;
    });
  }

  protocolV2Snapshot(session, excluded) {
    const protocol = this.ensureProtocolV2(session);
    const now = Date.now();
    const players = this.livePlayerRecords(excluded).map(({ attachment }) => {
      const health = this.playerHeartbeatHealth(attachment, now);
      return {
        playerInstanceId: attachment.playerInstanceId,
        connectionId: attachment.connectionId,
        clientKind: attachment.clientKind,
        state: attachment.state || 'standby',
        lastSeenAt: health.lastSeenAt,
        heartbeatAgeMs: health.heartbeatAgeMs,
        heartbeatWarning: health.heartbeatWarning,
        heartbeatStale: health.heartbeatStale,
        buildId: attachment.buildId,
        capabilities: attachment.capabilities || {},
        runtime: attachment.runtime || {}
      };
    });
    const idsForMode = (mode) => [...new Set(this.eligiblePlayerRecords(mode, excluded)
      .map(({ attachment }) => attachment.playerInstanceId))];
    const writableConnected = this.ctx.getWebSockets().some((candidate) => {
      if (candidate === excluded) return false;
      const attachment = candidate.deserializeAttachment() || {};
      return attachment.role === 'control'
        && attachment.protocolVersion === PROTOCOL_V2
        && attachment.negotiationState === 'negotiated'
        && attachment.controlInstanceId === protocol.writableControlInstanceId;
    });
    return {
      protocolVersion: PROTOCOL_V2,
      selectedOutputMode: protocol.selectedOutputMode,
      players,
      eligibleCandidates: {
        speaker: idsForMode('speaker'),
        obs: idsForMode('obs')
      },
      lease: {
        epoch: protocol.leaseEpoch,
        leaseTarget: protocol.leaseTarget,
        clientKind: protocol.leaseClientKind,
        status: protocol.leaseStatus,
        switchId: protocol.switchId
      },
      controlLease: {
        controlEpoch: protocol.controlEpoch,
        writableControlInstanceId: protocol.writableControlInstanceId,
        writableConnected
      },
      activeFamily: protocol.activeFamily,
      activeCheckId: protocol.activeCheckId,
      desiredTransport: protocol.desiredTransport,
      confirmedPlayback: protocol.confirmedPlayback
    };
  }

  broadcastProtocolV2Snapshot(session, excluded) {
    const snapshot = this.protocolV2Snapshot(session, excluded);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excluded) continue;
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.role === 'control' && attachment.protocolVersion === PROTOCOL_V2
        && attachment.negotiationState === 'negotiated') {
        this.send(socket, { type: 'player_snapshot', ...snapshot });
      }
    }
  }

  activeOutputLivenessIssue(session, targetPlayerInstanceId, {
    now = Date.now(),
    overrideAttachment = null
  } = {}) {
    const protocol = this.ensureProtocolV2(session);
    if (!targetPlayerInstanceId || protocol.leaseTarget !== targetPlayerInstanceId) return null;
    const retainedUnknown = protocol.leaseStatus === 'unknown'
      && V2_ACTIVE_OUTPUT_LIVENESS_REASONS.includes(protocol.confirmedPlayback?.reasonCode);
    if (!retainedUnknown && !['activating', 'ready', 'audible'].includes(protocol.leaseStatus)) return null;

    const records = this.livePlayerRecords()
      .filter(({ attachment }) => attachment.playerInstanceId === targetPlayerInstanceId)
      .map((record) => (overrideAttachment
        && record.attachment.connectionId === overrideAttachment.connectionId
        ? { ...record, attachment: overrideAttachment }
        : record));
    if (records.length === 0) {
      return {
        reasonCode: 'target_disconnected',
        targetPlayerInstanceId,
        connected: false,
        heartbeatAgeMs: null,
        heartbeatWarning: true,
        heartbeatStale: true,
        sourceActive: null
      };
    }

    const selected = records.map((record) => ({
      ...record,
      health: this.playerHeartbeatHealth(record.attachment, now)
    })).sort((left, right) => left.health.heartbeatAgeMs - right.health.heartbeatAgeMs)[0];
    const detail = {
      targetPlayerInstanceId,
      connected: true,
      heartbeatAgeMs: selected.health.heartbeatAgeMs,
      heartbeatWarning: selected.health.heartbeatWarning,
      heartbeatStale: selected.health.heartbeatStale,
      sourceActive: selected.attachment.runtime?.sourceActive ?? null
    };
    // A delayed heartbeat or OBS scene visibility change is not proof that the
    // media graph stopped. When the negotiated socket is still present, keep
    // the established route commandable. Standby activation remains strict in
    // eligiblePlayerRecords(); an actual send failure or socket close is the
    // hard continuity boundary.
    if (retainedUnknown) {
      return { reasonCode: protocol.confirmedPlayback.reasonCode, ...detail };
    }
    return null;
  }

  async persistActiveOutputUnknown(session, issue, { mutationLockHeld = false } = {}) {
    const release = mutationLockHeld
      ? null
      : await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
    try {
      const protocol = this.ensureProtocolV2(session);
      if (!issue || protocol.leaseTarget !== issue.targetPlayerInstanceId
        || ['deactivating', 'inactive', 'emergency_stopping'].includes(protocol.leaseStatus)) {
        return false;
      }
      const alreadyPersisted = protocol.leaseStatus === 'unknown'
        && protocol.confirmedPlayback?.status === 'unknown'
        && protocol.confirmedPlayback?.reasonCode === issue.reasonCode
        && session.transport?.status === 'unknown';
      if (alreadyPersisted) return false;

      const candidate = structuredClone(session);
      const candidateProtocol = this.ensureProtocolV2(candidate);
      const currentTransition = this.currentRouteTransitionForProtocol(candidateProtocol);
      candidateProtocol.leaseStatus = 'unknown';
      candidateProtocol.confirmedPlayback = {
        status: 'unknown',
        reasonCode: issue.reasonCode,
        playerInstanceId: issue.targetPlayerInstanceId,
        leaseEpoch: candidateProtocol.leaseEpoch
      };
      if (currentTransition) {
        this.clearRouteTransition(candidateProtocol, currentTransition.identity);
      }
      candidate.transport = { ...(candidate.transport || {}), status: 'unknown' };
      await this.ctx.storage.put('session', candidate);
      this.adoptPersistedSession(session, candidate);
      return true;
    } finally {
      if (release) release();
    }
  }

  async restoreObsOutputAfterReconnect(session, attachment, { mutationLockHeld = false } = {}) {
    const release = mutationLockHeld
      ? null
      : await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
    try {
      const protocol = this.ensureProtocolV2(session);
      const reasonCode = protocol.confirmedPlayback?.reasonCode;
      const recoverableReason = reasonCode === 'target_disconnected'
        || reasonCode === 'target_heartbeat_stale'
        || reasonCode === 'target_source_inactive';
      const obsCapable = attachment?.capabilities?.obsRuntime === true
        || attachment?.capabilities?.obsStudioBinding === true;
      if (protocol.leaseStatus !== 'unknown'
        || protocol.leaseClientKind !== 'obs-browser-source'
        || attachment?.clientKind !== 'obs-browser-source'
        || protocol.leaseTarget !== attachment?.playerInstanceId
        || !recoverableReason || !obsCapable) return false;

      const candidate = structuredClone(session);
      const candidateProtocol = this.ensureProtocolV2(candidate);
      candidateProtocol.leaseStatus = 'ready';
      candidateProtocol.confirmedPlayback = {
        status: 'unknown',
        reasonCode: 'output_reconnected',
        playerInstanceId: attachment.playerInstanceId,
        leaseEpoch: candidateProtocol.leaseEpoch,
        lastSeenAt: Date.now(),
      };
      if (candidate.transport?.status === 'unknown') {
        candidate.transport = { ...candidate.transport, status: 'ready' };
      }
      await this.ctx.storage.put('session', candidate);
      this.adoptPersistedSession(session, candidate);
      return true;
    } finally {
      if (release) release();
    }
  }

  async persistRouteTransitionTimeout(session, expiredTransition, { mutationLockHeld = false } = {}) {
    const release = mutationLockHeld
      ? null
      : await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
    try {
      const current = this.currentRouteTransition(session);
      if (!current
        || current.deadlineAt !== expiredTransition?.deadlineAt
        || !this.routeTransitionIdentityMatches(current.identity, expiredTransition?.identity)
        || Date.now() < current.deadlineAt) {
        return false;
      }

      const candidate = structuredClone(session);
      const candidateProtocol = this.ensureProtocolV2(candidate);
      const candidateTransition = this.currentRouteTransitionForProtocol(candidateProtocol);
      if (!candidateTransition
        || candidateTransition.deadlineAt !== current.deadlineAt
        || !this.routeTransitionIdentityMatches(candidateTransition.identity, current.identity)) {
        return false;
      }
      candidateProtocol.leaseStatus = 'unknown';
      candidateProtocol.confirmedPlayback = {
        status: 'unknown',
        reasonCode: 'route_transition_timeout',
        operation: current.identity.operation,
        playerInstanceId: current.identity.targetPlayerInstanceId,
        leaseEpoch: current.identity.leaseEpoch,
        switchId: current.identity.switchId
      };
      candidate.transport = { ...(candidate.transport || {}), status: 'unknown' };
      this.clearRouteTransition(candidateProtocol, current.identity);
      await this.ctx.storage.put('session', candidate);
      this.adoptPersistedSession(session, candidate);
      return true;
    } finally {
      if (release) release();
    }
  }

  publishActiveOutputUnknown(session) {
    this.broadcastLegacyControls({ type: 'transport', transport: session.transport });
    this.broadcastProtocolV2Snapshot(session);
  }

  async guardActiveOutputLiveness(session, targetPlayerInstanceId, { mutationLockHeld = false } = {}) {
    const issue = this.activeOutputLivenessIssue(session, targetPlayerInstanceId);
    if (!issue) return { ok: true };
    const transitioned = await this.persistActiveOutputUnknown(session, issue, { mutationLockHeld });
    if (transitioned) this.publishActiveOutputUnknown(session);
    return {
      ok: false,
      code: 'active_output_unavailable',
      detail: {
        ...issue,
        leaseEpoch: this.ensureProtocolV2(session).leaseEpoch
      }
    };
  }

  sendProtocolError(socket, code, detail = {}) {
    this.send(socket, { type: 'protocol_error', protocolVersion: PROTOCOL_V2, code, detail });
  }

  sendInvalidMessage(socket, detail = {}) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.protocolVersion === PROTOCOL_V2) {
      return this.sendProtocolError(socket, 'invalid_message', detail);
    }
    return this.send(socket, { type: 'error', code: 'invalid_message' });
  }

  v2CommandCacheEntries(socket) {
    const attachment = socket.deserializeAttachment() || {};
    return Array.isArray(attachment.commandResultCache)
      ? attachment.commandResultCache.filter((entry) => entry && typeof entry === 'object'
        && protocolId(entry.i) && protocolId(entry.f) && entry.r && typeof entry.r === 'object')
      : [];
  }

  // Terminal results cover only the recent window of one live connection and
  // survive DO hibernation through serializeAttachment. They intentionally
  // disappear when that WebSocket closes; a replacement connection must
  // reconcile from the authoritative snapshot rather than inheriting an old
  // connection's command namespace. Cache hits move to the tail, so count/byte
  // eviction is bounded LRU.
  // TODO(protocol-v2-durable-command-ledger): cross-connection exactly-once and
  // player-side command dedupe require a durable ledger/resume contract and are
  // deliberately outside this live-connection cache.
  writeV2CommandCache(socket, entries) {
    const attachment = socket.deserializeAttachment() || {};
    const bounded = entries.slice(-V2_COMMAND_RESULT_CACHE_MAX_ENTRIES);
    const encoder = new TextEncoder();
    const attachmentBytes = () => encoder.encode(JSON.stringify({
      ...attachment,
      commandResultCache: bounded
    })).byteLength;
    while (bounded.length > 0 && (
      encoder.encode(JSON.stringify(bounded)).byteLength > V2_COMMAND_RESULT_CACHE_MAX_BYTES
      || attachmentBytes() > V2_SOCKET_ATTACHMENT_SAFE_MAX_BYTES
    )) {
      bounded.shift();
    }
    socket.serializeAttachment({ ...attachment, commandResultCache: bounded });
  }

  v2CommandPendingKey(socket, commandId) {
    const connectionId = socket.deserializeAttachment()?.connectionId || 'unknown_connection';
    return `${connectionId}\u0000${commandId}`;
  }

  commandIdConflictResult(command, cachedType) {
    return {
      type: 'command_rejected',
      protocolVersion: PROTOCOL_V2,
      commandId: command.commandId,
      code: 'command_id_conflict',
      detail: { cachedType: cachedType || null, receivedType: command.type }
    };
  }

  hashV2CommandFingerprint(canonical) {
    return hashToken(canonical);
  }

  rejectCachedV2CommandIdConflict(socket, command) {
    const commandId = protocolId(command?.commandId);
    const commandType = protocolId(command?.type);
    if (!commandId || !commandType) return false;
    const cached = this.v2CommandCacheEntries(socket).find((entry) => entry.i === commandId);
    const pending = this.pendingV2Commands.get(this.v2CommandPendingKey(socket, commandId));
    const previousType = cached?.t || pending?.commandType;
    if (!previousType) return false;
    this.send(socket, this.commandIdConflictResult(command, previousType));
    return true;
  }

  async replayCachedV2Command(socket, command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)
      || !protocolId(command.commandId) || !protocolId(command.type)) return false;
    const fingerprint = await this.hashV2CommandFingerprint(canonicalProtocolJson(command));
    const entries = this.v2CommandCacheEntries(socket);
    const cachedIndex = entries.findIndex((entry) => entry.i === command.commandId);
    if (cachedIndex < 0) return false;
    const cached = entries[cachedIndex];
    const result = cached.f === fingerprint
      ? cached.r
      : this.commandIdConflictResult(command, cached.t);
    if (cached.f === fingerprint) {
      entries.splice(cachedIndex, 1);
      entries.push(cached);
      this.writeV2CommandCache(socket, entries);
    }
    this.send(socket, result);
    return true;
  }

  async beginV2Command(socket, command) {
    const canonical = canonicalProtocolJson(command);
    const pendingKey = this.v2CommandPendingKey(socket, command.commandId);
    const existingPending = this.pendingV2Commands.get(pendingKey);
    if (existingPending) {
      if (existingPending.canonical !== canonical) {
        this.send(socket, this.commandIdConflictResult(command, existingPending.commandType));
        return { handled: true };
      }
      const result = await existingPending.promise;
      if (!result) return this.beginV2Command(socket, command);
      this.send(socket, result);
      return { handled: true };
    }

    let resolvePending;
    const promise = new Promise((resolve) => { resolvePending = resolve; });
    const pending = {
      canonical,
      commandType: command.type,
      fingerprint: null,
      promise,
      resolve: resolvePending
    };
    this.pendingV2Commands.set(pendingKey, pending);
    try {
      pending.fingerprint = await this.hashV2CommandFingerprint(canonical);

      const entries = this.v2CommandCacheEntries(socket);
      const cachedIndex = entries.findIndex((entry) => entry.i === command.commandId);
      if (cachedIndex >= 0) {
        const cached = entries[cachedIndex];
        const result = cached.f === pending.fingerprint
          ? cached.r
          : this.commandIdConflictResult(command, cached.t);
        if (cached.f === pending.fingerprint) {
          entries.splice(cachedIndex, 1);
          entries.push(cached);
          this.writeV2CommandCache(socket, entries);
        }
        this.send(socket, result);
        pending.resolve(result);
        this.pendingV2Commands.delete(pendingKey);
        return { handled: true };
      }
      return { handled: false, pending };
    } catch (error) {
      pending.resolve(null);
      if (this.pendingV2Commands.get(pendingKey) === pending) {
        this.pendingV2Commands.delete(pendingKey);
      }
      throw error;
    }
  }

  completeV2Command(socket, command, result) {
    const pendingKey = this.v2CommandPendingKey(socket, command.commandId);
    const pending = this.pendingV2Commands.get(pendingKey);
    const wireResult = JSON.parse(JSON.stringify(result));
    try {
      if (pending?.fingerprint) {
        const entries = this.v2CommandCacheEntries(socket)
          .filter((entry) => entry.i !== command.commandId);
        entries.push({
          i: command.commandId,
          f: pending.fingerprint,
          t: command.type,
          r: wireResult
        });
        this.writeV2CommandCache(socket, entries);
      }
    } catch (error) {
      pending?.resolve(null);
      if (this.pendingV2Commands.get(pendingKey) === pending) {
        this.pendingV2Commands.delete(pendingKey);
      }
      throw error;
    }
    this.send(socket, wireResult);
    pending?.resolve(wireResult);
    this.pendingV2Commands.delete(pendingKey);
  }

  abandonV2Command(socket, command, expectedPending = null) {
    const pendingKey = this.v2CommandPendingKey(socket, command.commandId);
    const pending = this.pendingV2Commands.get(pendingKey);
    if (expectedPending && pending !== expectedPending) return;
    pending?.resolve(null);
    if (pending) this.pendingV2Commands.delete(pendingKey);
  }

  v2EventCacheEntriesFromAttachment(attachment) {
    return Array.isArray(attachment?.eventResultCache)
      ? attachment.eventResultCache.filter((entry) => entry && typeof entry === 'object'
        && protocolId(entry.i) && protocolId(entry.f) && protocolId(entry.n))
      : [];
  }

  v2EventCacheEntries(socket) {
    return this.v2EventCacheEntriesFromAttachment(socket.deserializeAttachment() || {});
  }

  normalizedV2SequenceHighWater(attachment) {
    const source = attachment?.sequenceHighWater;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    return Object.fromEntries(V2_EVENT_SEQUENCE_NAMESPACES
      .filter((namespace) => finiteEpoch(source[namespace]) !== null)
      .map((namespace) => [namespace, source[namespace]]));
  }

  isV2DurableEventNamespace(namespace) {
    return V2_DURABLE_EVENT_NAMESPACES.includes(namespace);
  }

  normalizedV2DurableEventHighWater(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    return Object.fromEntries(V2_DURABLE_EVENT_NAMESPACES
      .filter((namespace) => finiteEpoch(source[namespace]) !== null)
      .map((namespace) => [namespace, source[namespace]]));
  }

  boundedV2DurableEventCheckpoints(checkpoints) {
    const bounded = checkpoints.slice(-V2_DURABLE_EVENT_MAX_PLAYERS).map((checkpoint) => ({
      p: checkpoint.p,
      h: { ...checkpoint.h },
      e: checkpoint.e.slice(-V2_DURABLE_EVENT_MAX_ENTRIES).map((entry) => ({
        i: entry.i,
        f: entry.f,
        n: entry.n,
        r: { s: entry.r.s, q: entry.r.q }
      }))
    }));
    const encoder = new TextEncoder();
    const serializedBytes = () => encoder.encode(JSON.stringify({
      playerEventCheckpoints: bounded
    })).byteLength;
    while (bounded.length > 0
      && serializedBytes() > V2_DURABLE_EVENT_CHECKPOINT_MAX_BYTES) {
      const oldestWithResult = bounded.find((checkpoint) => checkpoint.e.length > 0);
      if (oldestWithResult) {
        oldestWithResult.e.shift();
      } else {
        bounded.shift();
      }
    }
    return bounded;
  }

  normalizedV2DurableEventCheckpoints(source) {
    if (!Array.isArray(source)) return [];
    const checkpoints = [];
    for (const rawCheckpoint of source.slice(-V2_DURABLE_EVENT_MAX_PLAYERS)) {
      if (!rawCheckpoint || typeof rawCheckpoint !== 'object' || Array.isArray(rawCheckpoint)) continue;
      const playerInstanceId = protocolId(rawCheckpoint.p);
      if (!playerInstanceId) continue;
      const priorIndex = checkpoints.findIndex((checkpoint) => checkpoint.p === playerInstanceId);
      const checkpoint = priorIndex >= 0
        ? checkpoints.splice(priorIndex, 1)[0]
        : { p: playerInstanceId, h: {}, e: [] };
      const highWater = this.normalizedV2DurableEventHighWater(rawCheckpoint.h);
      for (const [namespace, sequence] of Object.entries(highWater)) {
        checkpoint.h[namespace] = Math.max(finiteEpoch(checkpoint.h[namespace]) ?? -1, sequence);
      }
      const rawEntries = Array.isArray(rawCheckpoint.e)
        ? rawCheckpoint.e.slice(-V2_DURABLE_EVENT_MAX_ENTRIES)
        : [];
      for (const rawEntry of rawEntries) {
        const eventId = protocolId(rawEntry?.i);
        const fingerprint = protocolId(rawEntry?.f, 128);
        const namespace = protocolId(rawEntry?.n);
        const status = protocolId(rawEntry?.r?.s, 64);
        const sequence = finiteEpoch(rawEntry?.r?.q);
        if (!eventId || !fingerprint || !this.isV2DurableEventNamespace(namespace)
          || !status || sequence === null) continue;
        const priorEventIndex = checkpoint.e.findIndex((entry) => entry.i === eventId);
        if (priorEventIndex >= 0) checkpoint.e.splice(priorEventIndex, 1);
        checkpoint.e.push({
          i: eventId,
          f: fingerprint,
          n: namespace,
          r: { s: status, q: sequence }
        });
        checkpoint.h[namespace] = Math.max(
          finiteEpoch(checkpoint.h[namespace]) ?? -1,
          sequence
        );
      }
      checkpoints.push(checkpoint);
    }
    return this.boundedV2DurableEventCheckpoints(checkpoints);
  }

  v2DurableEventCheckpoint(session, playerInstanceId) {
    if (!playerInstanceId) return null;
    return this.ensureProtocolV2(session).playerEventCheckpoints
      .find((checkpoint) => checkpoint.p === playerInstanceId) || null;
  }

  appendV2DurableEventCheckpoint(session, message, namespace, fingerprint, status) {
    const protocol = this.ensureProtocolV2(session);
    const checkpoints = protocol.playerEventCheckpoints;
    const playerInstanceId = protocolId(message.playerInstanceId);
    const priorIndex = checkpoints.findIndex((checkpoint) => checkpoint.p === playerInstanceId);
    const checkpoint = priorIndex >= 0
      ? checkpoints.splice(priorIndex, 1)[0]
      : { p: playerInstanceId, h: {}, e: [] };
    const priorEventIndex = checkpoint.e.findIndex((entry) => entry.i === message.eventId);
    if (priorEventIndex >= 0) checkpoint.e.splice(priorEventIndex, 1);
    checkpoint.h[namespace] = Math.max(
      finiteEpoch(checkpoint.h[namespace]) ?? -1,
      message.sequence
    );
    checkpoint.e.push({
      i: message.eventId,
      f: fingerprint,
      n: namespace,
      r: { s: status, q: message.sequence }
    });
    checkpoints.push(checkpoint);
    protocol.playerEventCheckpoints = this.boundedV2DurableEventCheckpoints(checkpoints);
    return protocol.playerEventCheckpoints;
  }

  hydrateV2EventAttachmentFromCheckpoint(socket, session, checkpoint, cached) {
    try {
      const attachment = socket.deserializeAttachment() || {};
      let baseAttachment = attachment;
      if (cached.n === 'route') {
        const protocol = this.ensureProtocolV2(session);
        const state = protocol.leaseTarget === attachment.playerInstanceId
          ? protocol.leaseStatus
          : 'standby';
        baseAttachment = { ...attachment, state, lastSeenAt: Date.now() };
      }
      const sequences = this.normalizedV2SequenceHighWater(attachment);
      for (const [namespace, sequence] of Object.entries(checkpoint.h)) {
        sequences[namespace] = Math.max(finiteEpoch(sequences[namespace]) ?? -1, sequence);
      }
      const entries = this.v2EventCacheEntriesFromAttachment(attachment)
        .filter((entry) => entry.i !== cached.i);
      entries.push({ i: cached.i, f: cached.f, n: cached.n });
      this.writeV2EventState(socket, entries, sequences, baseAttachment);
    } catch {
      // Durable state is the recovery source. Attachment hydration is only the
      // fast path for subsequent events and must not suppress a duplicate ACK.
    }
  }

  boundedV2EventAttachment(attachment, entries, sequenceHighWater) {
    const bounded = entries.slice(-V2_EVENT_RESULT_CACHE_MAX_ENTRIES);
    const encoder = new TextEncoder();
    const build = () => ({
      ...attachment,
      sequenceHighWater: { ...sequenceHighWater },
      eventResultCache: bounded
    });
    while (bounded.length > 0
      && encoder.encode(JSON.stringify(build())).byteLength > V2_SOCKET_ATTACHMENT_SAFE_MAX_BYTES) {
      bounded.shift();
    }
    return build();
  }

  writeV2EventState(socket, entries, sequenceHighWater, baseAttachment = null) {
    const attachment = baseAttachment || socket.deserializeAttachment() || {};
    const nextAttachment = this.boundedV2EventAttachment(
      attachment,
      entries,
      sequenceHighWater
    );
    socket.serializeAttachment(nextAttachment);
    return nextAttachment;
  }

  sendV2EventAck(socket, message, status) {
    this.send(socket, {
      type: 'event_ack',
      protocolVersion: PROTOCOL_V2,
      eventId: message.eventId,
      playerInstanceId: message.playerInstanceId,
      sequence: message.sequence,
      status
    });
  }

  eventIdConflict(socket, message, cachedNamespace) {
    this.sendProtocolError(socket, 'event_id_conflict', {
      eventId: message.eventId,
      cachedNamespace: cachedNamespace || null,
      receivedNamespace: v2EventSequenceNamespace(message)
    });
  }

  previewV2EventSequence(attachment, namespace, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      return { ok: false, code: 'invalid_sequence' };
    }
    const sequences = this.normalizedV2SequenceHighWater(attachment);
    const previous = finiteEpoch(sequences[namespace]);
    if (previous !== null && sequence <= previous) {
      return {
        ok: false,
        code: sequence === previous ? 'duplicate_sequence' : 'out_of_order_sequence',
        detail: { family: namespace, previous, actual: sequence }
      };
    }
    return { ok: true, sequences, previous };
  }

  async beginV2Event(socket, session, message, namespace) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.protocolVersion !== PROTOCOL_V2
      || attachment.negotiationState !== 'negotiated'
      || attachment.playerInstanceId !== protocolId(message.playerInstanceId)
      || attachment.connectionId !== protocolId(message.connectionId)) {
      this.sendProtocolError(socket, 'foreign_connection', {
        expected: attachment.connectionId || null,
        actual: protocolId(message.connectionId)
      });
      return { handled: true };
    }

    const fingerprint = await hashToken(canonicalV2EventJson(message));
    const entries = this.v2EventCacheEntries(socket);
    const cachedIndex = entries.findIndex((entry) => entry.i === message.eventId);
    if (cachedIndex >= 0) {
      const cached = entries[cachedIndex];
      if (cached.f !== fingerprint) {
        this.eventIdConflict(socket, message, cached.n);
        return { handled: true };
      }
      entries.splice(cachedIndex, 1);
      entries.push(cached);
      try {
        this.writeV2EventState(
          socket,
          entries,
          this.normalizedV2SequenceHighWater(socket.deserializeAttachment() || {})
        );
      } catch {
        // The cache entry already proves this event. LRU maintenance is a
        // best-effort optimization and must not turn a duplicate into a retry.
      }
      this.sendV2EventAck(socket, message, 'duplicate');
      return { handled: true };
    }

    const durableCheckpoint = this.isV2DurableEventNamespace(namespace)
      ? this.v2DurableEventCheckpoint(session, attachment.playerInstanceId)
      : null;
    const durableCached = durableCheckpoint?.e
      .find((entry) => entry.i === message.eventId);
    if (durableCached) {
      if (durableCached.f !== fingerprint) {
        this.eventIdConflict(socket, message, durableCached.n);
        return { handled: true };
      }
      this.hydrateV2EventAttachmentFromCheckpoint(socket, session, durableCheckpoint, durableCached);
      this.sendV2EventAck(socket, message, 'duplicate');
      return { handled: true };
    }

    const sequence = this.previewV2EventSequence(attachment, namespace, message.sequence);
    if (!sequence.ok) {
      this.sendProtocolError(socket, sequence.code, sequence.detail);
      return { handled: true };
    }
    const durableHighWater = finiteEpoch(durableCheckpoint?.h?.[namespace]);
    if (durableHighWater !== null && message.sequence <= durableHighWater) {
      this.sendProtocolError(socket, 'event_before_checkpoint', {
        family: namespace,
        checkpoint: durableHighWater,
        actual: message.sequence
      });
      return { handled: true };
    }
    return { handled: false, fingerprint };
  }

  commitV2Event(socket, message, namespace, fingerprint) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.protocolVersion !== PROTOCOL_V2
      || attachment.negotiationState !== 'negotiated'
      || attachment.playerInstanceId !== message.playerInstanceId
      || attachment.connectionId !== message.connectionId) return false;
    const sequences = this.normalizedV2SequenceHighWater(attachment);
    sequences[namespace] = Math.max(finiteEpoch(sequences[namespace]) ?? -1, message.sequence);
    const entries = this.v2EventCacheEntriesFromAttachment(attachment)
      .filter((entry) => entry.i !== message.eventId);
    entries.push({ i: message.eventId, f: fingerprint, n: namespace });
    this.writeV2EventState(socket, entries, sequences, attachment);
    return true;
  }

  async acquireV2PlayerQueue(playerInstanceId) {
    const previous = this.pendingV2EventQueues.get(playerInstanceId) || Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => { releaseCurrent = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.pendingV2EventQueues.set(playerInstanceId, tail);
    await previous.catch(() => {});
    return () => {
      releaseCurrent();
      if (this.pendingV2EventQueues.get(playerInstanceId) === tail) {
        this.pendingV2EventQueues.delete(playerInstanceId);
      }
    };
  }

  async runV2EventGuard(socket, session, message, namespace, applyEvent) {
    const playerInstanceId = protocolId(message.playerInstanceId) || 'unknown_player';
    const releasePlayer = await this.acquireV2PlayerQueue(playerInstanceId);
    const durable = this.isV2DurableEventNamespace(namespace);
    let releaseDurable = null;
    try {
      if (durable) releaseDurable = await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
      const gate = await this.beginV2Event(socket, session, message, namespace);
      if (gate.handled) return;
      const targetSession = durable ? structuredClone(session) : session;
      const outcome = await applyEvent(targetSession);
      if (!outcome) return;
      if (durable) {
        this.appendV2DurableEventCheckpoint(
          targetSession,
          message,
          namespace,
          gate.fingerprint,
          outcome.status
        );
        await this.ctx.storage.put('session', targetSession);
        this.adoptPersistedSession(session, targetSession);
        if (typeof outcome.afterCommit === 'function') outcome.afterCommit();
      }
      if (!this.commitV2Event(socket, message, namespace, gate.fingerprint)) {
        this.sendProtocolError(socket, 'foreign_connection', {
          expected: socket.deserializeAttachment()?.connectionId || null,
          actual: protocolId(message.connectionId)
        });
        return;
      }
      if (!durable && typeof outcome.afterCommit === 'function') outcome.afterCommit();
      this.sendV2EventAck(socket, message, outcome.status);
    } finally {
      if (releaseDurable) releaseDurable();
      releasePlayer();
    }
  }

  adoptPersistedSession(session, candidate) {
    for (const key of Object.keys(session)) {
      if (!hasOwn(candidate, key)) delete session[key];
    }
    Object.assign(session, candidate);
    this.sessionState = session;
    return session;
  }

  rejectProtocolNegotiation(socket, code, detail = {}) {
    this.sendProtocolError(socket, code, detail);
    try {
      socket.close(4002, 'protocol_negotiation_rejected');
    } catch {
      // The runtime may already be closing a rejected socket.
    }
  }

  rejectV2Command(socket, command, code, detail = {}) {
    const commandId = protocolId(command?.commandId);
    if (!commandId) return this.sendProtocolError(socket, code, detail);
    this.completeV2Command(socket, command, {
      type: 'command_rejected',
      protocolVersion: PROTOCOL_V2,
      commandId,
      code,
      detail
    });
  }

  matchingSocketsWithIdentity(socket, identityField, identityValue) {
    const currentAttachment = socket.deserializeAttachment() || {};
    return this.ctx.getWebSockets().flatMap((other) => {
      if (other === socket) return [];
      const attachment = other.deserializeAttachment() || {};
      if (attachment.role !== currentAttachment.role || attachment[identityField] !== identityValue) return [];
      return [{ socket: other, attachment }];
    });
  }

  replaceSocketWithLatestInstance(socket, identityField, identityValue, matchingSockets = null) {
    const currentAttachment = socket.deserializeAttachment() || {};
    const inheritedPlayerAttachments = [];
    const matches = matchingSockets || this.matchingSocketsWithIdentity(socket, identityField, identityValue);
    for (const { socket: other, attachment } of matches) {
      // Fence the old transport before copying any of its retry state. A late
      // frame therefore fails negotiation/connection checks even if close is
      // delayed by the runtime.
      other.serializeAttachment({ ...attachment, negotiationState: 'superseded' });
      if (currentAttachment.role === 'player' && attachment.protocolVersion === PROTOCOL_V2) {
        inheritedPlayerAttachments.push(attachment);
      }
      this.send(other, {
        type: 'connection_superseded',
        protocolVersion: PROTOCOL_V2,
        code: 'newer_connection_registered'
      });
      try {
        other.close(4001, 'connection_superseded');
      } catch {
        // The close callback will remove a socket that is already closing.
      }
    }

    if (currentAttachment.role === 'player' && inheritedPlayerAttachments.length > 0) {
      const sequenceHighWater = this.normalizedV2SequenceHighWater(currentAttachment);
      const eventEntries = new Map();
      for (const inherited of [...inheritedPlayerAttachments, currentAttachment]) {
        for (const [namespace, value] of Object.entries(this.normalizedV2SequenceHighWater(inherited))) {
          sequenceHighWater[namespace] = Math.max(sequenceHighWater[namespace] ?? -1, value);
        }
        for (const entry of this.v2EventCacheEntriesFromAttachment(inherited)) {
          eventEntries.delete(entry.i);
          eventEntries.set(entry.i, entry);
        }
      }
      this.writeV2EventState(socket, [...eventEntries.values()], sequenceHighWater, currentAttachment);
    }
    // Overlapping sockets still inherit the full attachment as the fastest
    // path. A fully closed socket can recover exact authoritative results and
    // sequence floors from the bounded session checkpoint; resume tokens and
    // gap reconciliation remain a separate wire-protocol concern.
  }

  pendingEmergencyReconnect(session, playerInstanceId, connectionId, matchingSockets) {
    const protocol = this.ensureProtocolV2(session);
    if (protocol.leaseStatus !== 'emergency_stopping'
      || !protocol.pendingEmergencyCommandId
      || !protocol.pendingEmergencyControlInstanceId) {
      return { candidate: null, shouldDispatch: false };
    }

    const targetInstances = protocol.pendingEmergencyTargetInstances || {};
    const priorConnectionIds = new Set(Object.entries(targetInstances)
      .filter(([, instanceId]) => instanceId === playerInstanceId)
      .map(([targetConnectionId]) => targetConnectionId));
    for (const { attachment } of matchingSockets) {
      if (attachment.protocolVersion === PROTOCOL_V2 && attachment.connectionId) {
        priorConnectionIds.add(attachment.connectionId);
      }
    }

    const alreadyPending = protocol.pendingEmergencyTargets.includes(connectionId);
    const alreadyAcknowledged = protocol.emergencyAcknowledgedTargets.includes(connectionId);
    const sameConnectionRetry = priorConnectionIds.size === 1
      && priorConnectionIds.has(connectionId)
      && matchingSockets.length === 0;
    if (sameConnectionRetry) {
      return { candidate: null, shouldDispatch: alreadyPending && !alreadyAcknowledged };
    }

    const candidate = structuredClone(session);
    const candidateProtocol = this.ensureProtocolV2(candidate);
    candidateProtocol.pendingEmergencyTargets = [
      ...candidateProtocol.pendingEmergencyTargets.filter((target) => (
        target !== connectionId && !priorConnectionIds.has(target)
      )),
      connectionId
    ].slice(-32);
    candidateProtocol.emergencyAcknowledgedTargets = candidateProtocol.emergencyAcknowledgedTargets
      .filter((target) => target !== connectionId && !priorConnectionIds.has(target));
    candidateProtocol.pendingEmergencyTargetInstances = Object.fromEntries([
      ...Object.entries(candidateProtocol.pendingEmergencyTargetInstances || {})
        .filter(([target]) => target !== connectionId && !priorConnectionIds.has(target)),
      [connectionId, playerInstanceId]
    ].slice(-32));
    return { candidate, shouldDispatch: true };
  }

  sendPendingV2EmergencyStop(socket, session) {
    const protocol = this.ensureProtocolV2(session);
    const attachment = socket.deserializeAttachment() || {};
    const targetInstances = protocol.pendingEmergencyTargetInstances || {};
    if (protocol.leaseStatus !== 'emergency_stopping'
      || !protocol.pendingEmergencyCommandId
      || !protocol.pendingEmergencyControlInstanceId
      || attachment.protocolVersion !== PROTOCOL_V2
      || attachment.negotiationState !== 'negotiated'
      || !protocol.pendingEmergencyTargets.includes(attachment.connectionId)
      || targetInstances[attachment.connectionId] !== attachment.playerInstanceId) return false;
    return this.send(socket, {
      type: 'emergency_stop',
      protocolVersion: PROTOCOL_V2,
      commandId: protocol.pendingEmergencyCommandId,
      sessionId: session.room,
      authenticatedControlInstanceId: protocol.pendingEmergencyControlInstanceId,
      targetConnectionId: attachment.connectionId
    });
  }

  async handlePlayerHello(socket, session, message) {
    const prior = socket.deserializeAttachment() || {};
    const playerInstanceId = protocolId(message.playerInstanceId);
    const buildId = protocolId(message.buildId);
    if (prior.protocolVersion !== PROTOCOL_V2
      || !['unnegotiated', 'negotiated'].includes(prior.negotiationState)) {
      return this.rejectProtocolNegotiation(socket, 'protocol_opt_in_required');
    }
    if (message.protocolVersion !== PROTOCOL_V2) {
      return this.rejectProtocolNegotiation(socket, 'unsupported_protocol_version', { supported: [PROTOCOL_V2] });
    }
    const capabilityKeys = ['audioWorklet', 'analyser', 'sinkSelection', 'obsRuntime', 'obsStudioBinding'];
    const invalidCapability = message.capabilities && typeof message.capabilities === 'object'
      && capabilityKeys.some((key) => hasOwn(message.capabilities, key) && typeof message.capabilities[key] !== 'boolean');
    if (!playerInstanceId || !buildId || !V2_PLAYER_KINDS.includes(message.clientKind)
      || !message.capabilities || typeof message.capabilities !== 'object' || Array.isArray(message.capabilities)
      || invalidCapability) {
      return this.rejectProtocolNegotiation(socket, 'invalid_player_hello');
    }

    if (prior.protocolVersion === PROTOCOL_V2
      && prior.playerInstanceId
      && prior.playerInstanceId !== playerInstanceId) {
      return this.rejectProtocolNegotiation(socket, 'identity_rebind_forbidden', {
        identity: 'playerInstanceId'
      });
    }
    const releasePlayerQueue = await this.acquireV2PlayerQueue(playerInstanceId);
    let releaseDurableQueue = null;
    try {
      // Match durable player-event lock order: instance queue first, then the
      // shared session mutation queue. Re-enrolling an emergency target must
      // not overwrite an ACK/checkpoint committed by another player.
      releaseDurableQueue = await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
      const currentPrior = socket.deserializeAttachment() || {};
      if (currentPrior.connectionId !== prior.connectionId
        || !['unnegotiated', 'negotiated'].includes(currentPrior.negotiationState)) {
        return this.rejectProtocolNegotiation(socket, 'connection_state_changed');
      }
      let protocol = this.ensureProtocolV2(session);
      const capabilities = boundedRecord(message.capabilities, [
        'audioWorklet', 'analyser', 'sinkSelection', 'obsRuntime', 'obsStudioBinding'
      ]);
      const runtime = boundedRecord(message.runtime, [
        'obsPluginVersion', 'obsControlLevel', 'sourceActive', 'sourceVisible', 'streaming', 'streamingStatusObserved', 'recording'
      ]);
      const matchingSockets = this.matchingSocketsWithIdentity(socket, 'playerInstanceId', playerInstanceId);
      const finalAttachment = {
        ...currentPrior,
        protocolVersion: PROTOCOL_V2,
        negotiationState: 'reconnecting',
        playerInstanceId,
        clientKind: message.clientKind,
        buildId,
        capabilities,
        runtime,
        state: protocol.leaseStatus === 'emergency_stopping'
          ? 'emergency_stopping'
          : protocol.leaseTarget === playerInstanceId ? protocol.leaseStatus : 'standby',
        lastSeenAt: Date.now()
      };
      const emergencyReconnect = this.pendingEmergencyReconnect(
        session,
        playerInstanceId,
        currentPrior.connectionId,
        matchingSockets
      );
      socket.serializeAttachment(finalAttachment);
      try {
        await this.reconcileConnectedPlayerAlarm(session, { overrideAttachment: finalAttachment });
        if (emergencyReconnect.candidate) {
          await this.ctx.storage.put('session', emergencyReconnect.candidate);
          this.adoptPersistedSession(session, emergencyReconnect.candidate);
          protocol = this.ensureProtocolV2(session);
        }
        const reconnected = await this.restoreObsOutputAfterReconnect(session, finalAttachment, {
          mutationLockHeld: true,
        });
        if (reconnected) protocol = this.ensureProtocolV2(session);
      } catch (error) {
        socket.serializeAttachment(currentPrior);
        throw error;
      }
      socket.serializeAttachment({
        ...finalAttachment,
        negotiationState: 'negotiated',
        state: protocol.leaseStatus === 'emergency_stopping'
          ? 'emergency_stopping'
          : protocol.leaseTarget === playerInstanceId ? protocol.leaseStatus : 'standby',
      });
      this.replaceSocketWithLatestInstance(
        socket,
        'playerInstanceId',
        playerInstanceId,
        matchingSockets
      );
      this.send(socket, {
        type: 'player_welcome',
        protocolVersion: PROTOCOL_V2,
        connectionId: currentPrior.connectionId,
        playerInstanceId,
        leaseEpoch: protocol.leaseEpoch,
        leaseTarget: protocol.leaseTarget,
        leaseStatus: protocol.leaseStatus
      });
      if (emergencyReconnect.shouldDispatch) this.sendPendingV2EmergencyStop(socket, session);
      this.broadcastV2Controls({
        type: 'presence',
        role: 'player',
        connected: true,
        protocolVersion: PROTOCOL_V2,
        playerInstanceId,
        clientKind: message.clientKind
      });
      this.broadcastProtocolV2Snapshot(session);
    } finally {
      if (releaseDurableQueue) releaseDurableQueue();
      releasePlayerQueue();
    }
  }

  async handleControlHello(socket, session, message) {
    const prior = socket.deserializeAttachment() || {};
    const controlInstanceId = protocolId(message.controlInstanceId);
    const buildId = protocolId(message.buildId);
    if (prior.protocolVersion !== PROTOCOL_V2
      || !['unnegotiated', 'negotiated'].includes(prior.negotiationState)) {
      return this.rejectProtocolNegotiation(socket, 'protocol_opt_in_required');
    }
    if (message.protocolVersion !== PROTOCOL_V2) {
      return this.rejectProtocolNegotiation(socket, 'unsupported_protocol_version', { supported: [PROTOCOL_V2] });
    }
    const invalidCapabilities = hasOwn(message, 'capabilities')
      && (!message.capabilities || typeof message.capabilities !== 'object' || Array.isArray(message.capabilities));
    const containsTakeoverRequest = ['takeover', 'requestTakeover', 'expectedControlEpoch', 'controlEpoch', 'commandId']
      .some((field) => hasOwn(message, field));
    if (!controlInstanceId || !buildId || invalidCapabilities || containsTakeoverRequest) {
      return this.rejectProtocolNegotiation(socket, 'invalid_control_hello');
    }

    if (prior.protocolVersion === PROTOCOL_V2
      && prior.controlInstanceId
      && prior.controlInstanceId !== controlInstanceId) {
      return this.rejectProtocolNegotiation(socket, 'identity_rebind_forbidden', {
        identity: 'controlInstanceId'
      });
    }
    const releaseDurableQueue = await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
    try {
      const candidate = structuredClone(session);
      let protocol = this.ensureProtocolV2(candidate);
      const previousOwner = protocol.writableControlInstanceId;
      // A hello never steals a lease. A different instance must send the
      // explicit, CAS-guarded control_takeover command while that owner is live.
      // A persisted owner without a live negotiated socket is an expired lease,
      // so a new instance can recover it with a new epoch during hello.
      const previousOwnerConnected = this.ctx.getWebSockets().some((candidateSocket) => {
        if (candidateSocket === socket) return false;
        const attachment = candidateSocket.deserializeAttachment() || {};
        return attachment.role === 'control'
          && attachment.protocolVersion === PROTOCOL_V2
          && attachment.negotiationState === 'negotiated'
          && attachment.controlInstanceId === previousOwner;
      });
      const mayClaim = !previousOwner || previousOwner === controlInstanceId || !previousOwnerConnected;
      const granted = mayClaim;
      if (mayClaim && previousOwner !== controlInstanceId) {
        protocol.controlEpoch += 1;
        protocol.writableControlInstanceId = controlInstanceId;
        await this.ctx.storage.put('session', candidate);
        this.adoptPersistedSession(session, candidate);
        protocol = this.ensureProtocolV2(session);
      }
      socket.serializeAttachment({
        ...prior,
        protocolVersion: PROTOCOL_V2,
        negotiationState: 'negotiated',
        controlInstanceId,
        buildId,
        capabilities: boundedRecord(message.capabilities, ['outputRouting', 'verificationUi']),
        lastSeenAt: Date.now()
      });
      // A live dashboard is an active session participant even when it is in
      // browser-local Speaker mode and no OBS player exists. Cancel an initial
      // or reconnect grace alarm unless a real route transition still owns it.
      await this.reconcileConnectedPlayerAlarm(session);
      this.replaceSocketWithLatestInstance(socket, 'controlInstanceId', controlInstanceId);
      this.send(socket, {
        type: 'control_welcome',
        protocolVersion: PROTOCOL_V2,
        connectionId: prior.connectionId,
        controlInstanceId,
        writable: granted,
        controlEpoch: protocol.controlEpoch,
        writableControlInstanceId: protocol.writableControlInstanceId,
        code: granted ? 'control_lease_granted' : 'control_lease_read_only'
      });
      this.send(socket, { type: 'player_snapshot', ...this.protocolV2Snapshot(session) });
      this.broadcastProtocolV2Snapshot(session);
    } finally {
      releaseDurableQueue();
    }
  }

  validateWritableControl(socket, protocol, command) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.protocolVersion !== PROTOCOL_V2 || attachment.negotiationState !== 'negotiated'
      || !attachment.controlInstanceId) {
      return { ok: false, code: 'control_hello_required' };
    }
    if (attachment.controlInstanceId !== protocol.writableControlInstanceId) {
      return {
        ok: false,
        code: 'control_lease_read_only',
        detail: { writableControlInstanceId: protocol.writableControlInstanceId }
      };
    }
    const commandEpoch = finiteEpoch(command.controlEpoch);
    if (commandEpoch === null || commandEpoch !== protocol.controlEpoch) {
      return {
        ok: false,
        code: 'stale_control_epoch',
        detail: { expected: protocol.controlEpoch, actual: commandEpoch }
      };
    }
    return { ok: true, attachment };
  }

  sendV2CommandAck(socket, command, detail = {}) {
    this.completeV2Command(socket, command, {
      type: 'command_ack',
      protocolVersion: PROTOCOL_V2,
      commandId: command.commandId,
      ...detail
    });
  }

  sendToPlayerInstance(playerInstanceId, message) {
    let delivered = 0;
    for (const { socket, attachment } of this.livePlayerRecords()) {
      if (attachment.playerInstanceId !== playerInstanceId) continue;
      if (this.send(socket, { ...message, targetConnectionId: attachment.connectionId })) delivered += 1;
    }
    return delivered;
  }

  setPlayerInstanceState(playerInstanceId, state) {
    for (const { socket, attachment } of this.livePlayerRecords()) {
      if (attachment.playerInstanceId !== playerInstanceId) continue;
      socket.serializeAttachment({ ...attachment, state, lastSeenAt: Date.now() });
    }
  }

  async handleV2Command(socket, session, command) {
    let protocol = this.ensureProtocolV2(session);
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return this.rejectV2Command(socket, command, 'invalid_command');
    }
    if (!protocolId(command.commandId) || !protocolId(command.type)) {
      return this.rejectV2Command(socket, command, 'invalid_command');
    }
    let gate;
    let releaseStatefulCommand = null;
    try {
      gate = await this.beginV2Command(socket, command);
      if (gate.handled) return;
      if (V2_ROUTE_COMMANDS.includes(command.type)
        || V2_RUN_COMMANDS.includes(command.type)
        || V2_TEST_COMMANDS.includes(command.type)
        || command.type === V2_CONTROL_TAKEOVER_COMMAND
        || command.type === 'display_state'
        || command.type === 'end_session'
        || command.type === 'emergency_stop') {
        releaseStatefulCommand = await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
      }
      if (session.status !== 'active') {
        return this.rejectV2Command(socket, command, 'session_inactive');
      }
      protocol = this.ensureProtocolV2(session);

      if (command.type === 'emergency_stop') return await this.handleV2EmergencyStop(socket, session, command);
      if (command.type === V2_CONTROL_TAKEOVER_COMMAND) {
        return await this.handleV2ControlTakeover(socket, session, command);
      }

      const control = this.validateWritableControl(socket, protocol, command);
      if (!control.ok) return this.rejectV2Command(socket, command, control.code, control.detail);
      if (V2_CONTROL_AUX_COMMANDS.includes(command.type)
        && [
          'entryId', 'runId', 'switchId', 'checkId', 'leaseEpoch', 'targetPlayerInstanceId',
          'targetConnectionId', 'controlInstanceId', 'expectedControlEpoch'
        ]
          .some((field) => hasOwn(command, field))) {
        return this.rejectV2Command(socket, command, 'invalid_aux_identity');
      }

      if (command.type === 'end_session') {
        const invalidPayload = hasOwn(command, 'payload')
          && (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)
            || Object.keys(command.payload).length > 0);
        if (invalidPayload) return this.rejectV2Command(socket, command, 'invalid_aux_payload');
        const blocked = this.sessionEndBlockDetail(session);
        if (blocked) return this.rejectV2Command(socket, command, 'session_end_requires_idle', blocked);
        await this.endSessionWhileDurableQueueHeld(session, 'explicit');
        return this.sendV2CommandAck(socket, command, { controlEpoch: protocol.controlEpoch });
      }
      if (command.type === 'display_state') {
        if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)
          || !command.payload.display || typeof command.payload.display !== 'object'
          || Array.isArray(command.payload.display)) {
          return this.rejectV2Command(socket, command, 'invalid_aux_payload');
        }
        const candidate = structuredClone(session);
        candidate.display = displayState(command.payload.display);
        await this.ctx.storage.put('session', candidate);
        this.adoptPersistedSession(session, candidate);
        protocol = this.ensureProtocolV2(session);
        this.broadcast({ type: 'display_state', display: session.display }, 'display');
        return this.sendV2CommandAck(socket, command, { controlEpoch: protocol.controlEpoch });
      }
      if (command.type === 'prefetch') {
        const videoIds = command.payload?.videoIds;
        if (!Array.isArray(videoIds) || videoIds.length > 2
          || videoIds.some((id) => typeof id !== 'string' || !VIDEO_ID_PATTERN.test(id))) {
          return this.rejectV2Command(socket, command, 'invalid_aux_payload');
        }
        for (const playerSocket of this.ctx.getWebSockets()) {
          const attachment = playerSocket.deserializeAttachment() || {};
          if (attachment.role !== 'player') continue;
          if (attachment.protocolVersion === PROTOCOL_V2 && attachment.negotiationState === 'negotiated') {
            this.send(playerSocket, { ...command, protocolVersion: PROTOCOL_V2, payload: { videoIds } });
          } else if (attachment.protocolVersion !== PROTOCOL_V2) {
            this.send(playerSocket, {
              type: 'command',
              command: { type: 'prefetch', commandId: command.commandId, videoIds }
            });
          }
        }
        return this.sendV2CommandAck(socket, command, { controlEpoch: protocol.controlEpoch });
      }
      if (V2_ROUTE_COMMANDS.includes(command.type)) return await this.handleV2RouteCommand(socket, session, command);
      if (V2_RUN_COMMANDS.includes(command.type)) return await this.handleV2RunCommand(socket, session, command);
      if (V2_TEST_COMMANDS.includes(command.type)) return await this.handleV2TestCommand(socket, session, command);
      return this.rejectV2Command(socket, command, 'unsupported_command', { type: command.type });
    } catch (error) {
      if (gate?.pending) this.abandonV2Command(socket, command, gate.pending);
      throw error;
    } finally {
      if (releaseStatefulCommand) releaseStatefulCommand();
    }
  }

  async handleV2ControlTakeover(socket, session, command) {
    const attachment = socket.deserializeAttachment() || {};
    const controlInstanceId = protocolId(command.controlInstanceId);
    const expectedControlEpoch = finiteEpoch(command.expectedControlEpoch);
    let protocol = this.ensureProtocolV2(session);
    const hasForeignIdentity = [
      'entryId', 'runId', 'switchId', 'checkId', 'leaseEpoch', 'controlEpoch',
      'targetPlayerInstanceId', 'targetConnectionId'
    ].some((field) => hasOwn(command, field));
    const invalidPayload = hasOwn(command, 'payload')
      && (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload));
    if (attachment.protocolVersion !== PROTOCOL_V2 || attachment.negotiationState !== 'negotiated'
      || !attachment.controlInstanceId) {
      return this.rejectV2Command(socket, command, 'control_hello_required');
    }
    if (!controlInstanceId || hasForeignIdentity || invalidPayload || controlInstanceId !== attachment.controlInstanceId) {
      return this.rejectV2Command(socket, command, 'foreign_control_instance', {
        expected: attachment.controlInstanceId,
        actual: controlInstanceId
      });
    }
    if (expectedControlEpoch === null || expectedControlEpoch !== protocol.controlEpoch) {
      return this.rejectV2Command(socket, command, 'stale_control_epoch', {
        expected: protocol.controlEpoch,
        actual: expectedControlEpoch
      });
    }
    const blocked = this.controlTakeoverBlockDetail(session);
    if (blocked) {
      return this.rejectV2Command(socket, command, 'control_takeover_requires_idle', blocked);
    }
    if (protocol.writableControlInstanceId !== controlInstanceId) {
      const candidate = structuredClone(session);
      const candidateProtocol = this.ensureProtocolV2(candidate);
      candidateProtocol.controlEpoch += 1;
      candidateProtocol.writableControlInstanceId = controlInstanceId;
      await this.ctx.storage.put('session', candidate);
      this.adoptPersistedSession(session, candidate);
      protocol = this.ensureProtocolV2(session);
    }
    this.sendV2CommandAck(socket, command, {
      code: 'control_lease_granted',
      controlEpoch: protocol.controlEpoch,
      writableControlInstanceId: protocol.writableControlInstanceId
    });
    this.broadcastProtocolV2Snapshot(session);
  }

  async handleV2RouteCommand(socket, session, command) {
    let protocol = this.ensureProtocolV2(session);
    const targetPlayerInstanceId = protocolId(command.targetPlayerInstanceId);
    const switchId = protocolId(command.switchId);
    const expectedLeaseEpoch = finiteEpoch(command.leaseEpoch);
    const hasForeignIdentity = ['entryId', 'runId', 'checkId', 'targetConnectionId']
      .some((field) => hasOwn(command, field));
    const invalidPayload = hasOwn(command, 'payload')
      && (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload));
    if (!targetPlayerInstanceId || !switchId || expectedLeaseEpoch === null || hasForeignIdentity || invalidPayload) {
      return this.rejectV2Command(socket, command, 'invalid_route_identity');
    }
    if (expectedLeaseEpoch !== protocol.leaseEpoch) {
      return this.rejectV2Command(socket, command, 'stale_lease_epoch', {
        expected: protocol.leaseEpoch,
        actual: expectedLeaseEpoch
      });
    }

    if (command.type === 'activate_output') {
      const outputMode = command.payload?.outputMode;
      if (!command.payload || !V2_OUTPUT_MODES.includes(outputMode)) {
        return this.rejectV2Command(socket, command, 'invalid_output_mode', { outputMode });
      }
      if (protocol.leaseStatus === 'emergency_stopping') {
        return this.rejectV2Command(socket, command, 'emergency_stop_confirmation_required', {
          pendingEmergencyCommandId: protocol.pendingEmergencyCommandId
        });
      }
      if (protocol.leaseTarget) {
        if (protocol.leaseTarget === targetPlayerInstanceId
          && protocol.switchId === switchId
          && ['activating', 'ready', 'audible'].includes(protocol.leaseStatus)) {
          return this.sendV2CommandAck(socket, command, {
            controlEpoch: protocol.controlEpoch,
            leaseEpoch: protocol.leaseEpoch,
            targetPlayerInstanceId,
            status: protocol.leaseStatus,
            duplicate: true
          });
        }
        return this.rejectV2Command(socket, command, 'output_deactivation_required', {
          leaseTarget: protocol.leaseTarget,
          leaseEpoch: protocol.leaseEpoch,
          status: protocol.leaseStatus
        });
      }

      const legacyPlayerCount = this.ctx.getWebSockets()
        .filter((candidate) => {
          const attachment = candidate.deserializeAttachment() || {};
          return attachment.role === 'player' && attachment.protocolVersion !== PROTOCOL_V2;
        }).length;
      if (legacyPlayerCount > 0) {
        return this.rejectV2Command(socket, command, 'legacy_player_present', {
          count: legacyPlayerCount
        });
      }

      const candidates = [...new Set(this.eligiblePlayerRecords(outputMode)
        .map(({ attachment }) => attachment.playerInstanceId))];
      if (candidates.length === 0 || (outputMode !== 'speaker' && candidates.length !== 1)) {
        return this.rejectV2Command(socket, command, 'output_candidate_count', {
          outputMode,
          count: candidates.length,
          candidates: candidates.slice(0, 16)
        });
      }
      if (!candidates.includes(targetPlayerInstanceId)) {
        return this.rejectV2Command(socket, command, 'target_not_eligible', {
          outputMode,
          targetPlayerInstanceId,
          eligibleTarget: outputMode === 'speaker' ? candidates : candidates[0]
        });
      }

      const target = this.livePlayerRecords()
        .find(({ attachment }) => attachment.playerInstanceId === targetPlayerInstanceId);
      if (!target) return this.rejectV2Command(socket, command, 'target_not_connected');

      const candidate = structuredClone(session);
      const candidateProtocol = this.ensureProtocolV2(candidate);
      candidateProtocol.leaseEpoch += 1;
      candidateProtocol.leaseTarget = targetPlayerInstanceId;
      candidateProtocol.leaseClientKind = target.attachment.clientKind;
      candidateProtocol.leaseStatus = 'activating';
      candidateProtocol.selectedOutputMode = outputMode;
      candidateProtocol.switchId = switchId;
      candidateProtocol.activeFamily = null;
      candidateProtocol.activeCheckId = null;
      candidateProtocol.activeCheckProgress = null;
      candidateProtocol.pendingEmergencyCommandId = null;
      candidateProtocol.pendingEmergencyControlInstanceId = null;
      candidateProtocol.pendingEmergencyRequiredPlayerInstanceId = null;
      candidateProtocol.pendingEmergencyRequiredTargetKnown = false;
      candidateProtocol.pendingEmergencyTargets = [];
      candidateProtocol.pendingEmergencyTargetInstances = {};
      candidateProtocol.emergencyAcknowledgedTargets = [];
      candidateProtocol.pendingEmergencyLegacyCount = 0;
      candidateProtocol.confirmedPlayback = { status: 'unknown', reasonCode: 'output_activating' };
      this.beginRouteTransition(candidateProtocol, 'activate');
      // Arm before committing the active lease. If alarm storage fails, the
      // route remains inactive and the command can be retried cleanly.
      await this.ensureActiveOutputHeartbeatAlarm(candidate, {
        overrideAttachment: target.attachment
      });
      await this.ctx.storage.put('session', candidate);
      this.adoptPersistedSession(session, candidate);
      protocol = this.ensureProtocolV2(session);

      const forwarded = {
        ...command,
        protocolVersion: PROTOCOL_V2,
        outputMode,
        leaseEpoch: protocol.leaseEpoch,
        targetPlayerInstanceId
      };
      const delivered = this.sendToPlayerInstance(targetPlayerInstanceId, forwarded);
      if (!delivered) {
        const failedCandidate = structuredClone(session);
        const failedProtocol = this.ensureProtocolV2(failedCandidate);
        const failedTransition = this.currentRouteTransitionForProtocol(failedProtocol);
        failedProtocol.leaseStatus = 'unknown';
        failedProtocol.confirmedPlayback = { status: 'unknown', reasonCode: 'target_disconnected' };
        if (failedTransition) this.clearRouteTransition(failedProtocol, failedTransition.identity);
        await this.ctx.storage.put('session', failedCandidate);
        this.adoptPersistedSession(session, failedCandidate);
        this.broadcastProtocolV2Snapshot(session);
        return this.rejectV2Command(socket, command, 'target_not_connected');
      }
      this.setPlayerInstanceState(targetPlayerInstanceId, 'activation');
      this.sendV2CommandAck(socket, command, {
        controlEpoch: protocol.controlEpoch,
        leaseEpoch: protocol.leaseEpoch,
        targetPlayerInstanceId,
        status: protocol.leaseStatus
      });
      this.broadcastProtocolV2Snapshot(session);
      return;
    }

    if (!protocol.leaseTarget || protocol.leaseTarget !== targetPlayerInstanceId) {
      return this.rejectV2Command(socket, command, 'foreign_target_player', {
        expected: protocol.leaseTarget,
        actual: targetPlayerInstanceId
      });
    }
    if (protocol.switchId === switchId && protocol.leaseStatus === 'deactivating') {
      return this.sendV2CommandAck(socket, command, {
        controlEpoch: protocol.controlEpoch,
        leaseEpoch: protocol.leaseEpoch,
        targetPlayerInstanceId,
        status: protocol.leaseStatus,
        duplicate: true
      });
    }

    const candidate = structuredClone(session);
    const candidateProtocol = this.ensureProtocolV2(candidate);
    candidateProtocol.switchId = switchId;
    candidateProtocol.leaseStatus = 'deactivating';
    candidateProtocol.confirmedPlayback = { status: 'unknown', reasonCode: 'output_deactivating' };
    this.beginRouteTransition(candidateProtocol, 'deactivate');
    // A recovery deactivation can begin from an unknown route that no longer
    // has a heartbeat alarm. Arm its durable terminal deadline before exposing
    // the deactivating state.
    await this.ensureActiveOutputHeartbeatAlarm(candidate);
    await this.ctx.storage.put('session', candidate);
    this.adoptPersistedSession(session, candidate);
    protocol = this.ensureProtocolV2(session);
    const delivered = this.sendToPlayerInstance(targetPlayerInstanceId, {
      ...command,
      protocolVersion: PROTOCOL_V2,
      leaseEpoch: protocol.leaseEpoch,
      targetPlayerInstanceId
    });
    if (!delivered) {
      const failedCandidate = structuredClone(session);
      const failedProtocol = this.ensureProtocolV2(failedCandidate);
      const failedTransition = this.currentRouteTransitionForProtocol(failedProtocol);
      failedProtocol.leaseStatus = 'unknown';
      failedProtocol.confirmedPlayback = { status: 'unknown', reasonCode: 'target_disconnected' };
      if (failedTransition) this.clearRouteTransition(failedProtocol, failedTransition.identity);
      await this.ctx.storage.put('session', failedCandidate);
      this.adoptPersistedSession(session, failedCandidate);
      this.broadcastProtocolV2Snapshot(session);
      return this.rejectV2Command(socket, command, 'target_not_connected');
    }
    this.setPlayerInstanceState(targetPlayerInstanceId, 'deactivating');
    this.sendV2CommandAck(socket, command, {
      controlEpoch: protocol.controlEpoch,
      leaseEpoch: protocol.leaseEpoch,
      targetPlayerInstanceId,
      status: protocol.leaseStatus
    });
    this.broadcastProtocolV2Snapshot(session);
  }

  async handleV2RunCommand(socket, session, command) {
    let protocol = this.ensureProtocolV2(session);
    const targetPlayerInstanceId = protocolId(command.targetPlayerInstanceId);
    const entryId = protocolId(command.entryId);
    const runId = protocolId(command.runId);
    const leaseEpoch = finiteEpoch(command.leaseEpoch);
    const hasForeignIdentity = ['switchId', 'checkId', 'targetConnectionId']
      .some((field) => hasOwn(command, field));
    const payloadIsRecord = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload);
    const invalidLoadPayload = command.type === 'load'
      && (!payloadIsRecord || !command.payload.song || typeof command.payload.song !== 'object' || Array.isArray(command.payload.song)
        || (hasOwn(command.payload, 'position') && (!Number.isFinite(command.payload.position) || command.payload.position < 0))
        || (hasOwn(command.payload, 'volume')
          && (!Number.isFinite(command.payload.volume) || command.payload.volume < 0 || command.payload.volume > 100)));
    const invalidSeekPayload = command.type === 'seek'
      && (!payloadIsRecord || !Number.isFinite(command.payload.position) || command.payload.position < 0);
    const invalidVolumePayload = command.type === 'volume'
      && (!payloadIsRecord || !Number.isFinite(command.payload.volume)
        || command.payload.volume < 0 || command.payload.volume > 100);
    const invalidOptionalPayload = !['load', 'seek', 'volume'].includes(command.type)
      && hasOwn(command, 'payload') && !payloadIsRecord;
    if (!targetPlayerInstanceId || !entryId || !runId || leaseEpoch === null || hasForeignIdentity
      || invalidLoadPayload || invalidSeekPayload || invalidVolumePayload || invalidOptionalPayload) {
      return this.rejectV2Command(socket, command, 'invalid_run_identity');
    }
    if (leaseEpoch !== protocol.leaseEpoch) {
      return this.rejectV2Command(socket, command, 'stale_lease_epoch', {
        expected: protocol.leaseEpoch,
        actual: leaseEpoch
      });
    }
    if (targetPlayerInstanceId !== protocol.leaseTarget) {
      return this.rejectV2Command(socket, command, 'foreign_target_player', {
        expected: protocol.leaseTarget,
        actual: targetPlayerInstanceId
      });
    }
    if (protocol.activeCheckId) {
      return this.rejectV2Command(socket, command, 'test_active', {
        activeCheckId: protocol.activeCheckId
      });
    }
    const liveness = await this.guardActiveOutputLiveness(
      session,
      targetPlayerInstanceId,
      { mutationLockHeld: true }
    );
    if (!liveness.ok) {
      return this.rejectV2Command(socket, command, liveness.code, liveness.detail);
    }
    protocol = this.ensureProtocolV2(session);
    if (!['ready', 'audible'].includes(protocol.leaseStatus)) {
      return this.rejectV2Command(socket, command, 'output_not_ready', { status: protocol.leaseStatus });
    }
    if (command.type !== 'load'
      && (protocol.activeFamily?.entryId !== entryId || protocol.activeFamily?.runId !== runId)) {
      return this.rejectV2Command(socket, command, 'stale_run_identity', {
        expected: protocol.activeFamily,
        actual: { entryId, runId }
      });
    }

    const playerConnected = this.livePlayerRecords()
      .some(({ attachment }) => attachment.playerInstanceId === targetPlayerInstanceId);
    if (!playerConnected) return this.rejectV2Command(socket, command, 'target_not_connected');

    const priorRunState = {
      activeFamily: structuredClone(protocol.activeFamily),
      desiredTransport: structuredClone(protocol.desiredTransport),
      confirmedPlayback: structuredClone(protocol.confirmedPlayback)
    };
    const candidate = structuredClone(session);
    const candidateProtocol = this.ensureProtocolV2(candidate);
    const payload = payloadIsRecord ? command.payload : {};
    const desired = { ...(candidateProtocol.desiredTransport || {}) };
    if (command.type === 'load') {
      candidateProtocol.activeFamily = { entryId, runId };
      desired.status = 'loading';
      desired.song = payload.song || null;
      desired.entryId = entryId;
      desired.runId = runId;
      desired.position = Math.max(0, Number(payload.position) || 0);
      if (Number.isFinite(payload.volume)) desired.volume = Math.max(0, Math.min(100, payload.volume));
      candidateProtocol.confirmedPlayback = {
        status: 'unknown',
        reasonCode: 'load_not_confirmed',
        entryId,
        runId,
        playerInstanceId: targetPlayerInstanceId,
        leaseEpoch
      };
    } else if (command.type === 'play') {
      desired.status = 'playing';
    } else if (command.type === 'pause') {
      desired.status = 'paused';
    } else if (command.type === 'seek') {
      desired.position = Math.max(0, Number(payload.position) || 0);
    } else if (command.type === 'volume') {
      desired.volume = Math.max(0, Math.min(100, Number(payload.volume) || 0));
    } else if (command.type === 'stop') {
      desired.status = 'stopped';
      desired.position = 0;
    }
    candidateProtocol.desiredTransport = desired;

    const persistent = !['seek', 'volume'].includes(command.type);
    if (persistent) {
      await this.ctx.storage.put('session', candidate);
      this.adoptPersistedSession(session, candidate);
      protocol = this.ensureProtocolV2(session);
    }

    const delivered = this.sendToPlayerInstance(targetPlayerInstanceId, {
      ...command,
      protocolVersion: PROTOCOL_V2,
      leaseEpoch,
      targetPlayerInstanceId,
      entryId,
      runId
    });
    if (!delivered) {
      if (persistent) {
        const failedCandidate = structuredClone(session);
        const failedProtocol = this.ensureProtocolV2(failedCandidate);
        failedProtocol.activeFamily = priorRunState.activeFamily;
        failedProtocol.desiredTransport = priorRunState.desiredTransport;
        failedProtocol.confirmedPlayback = priorRunState.confirmedPlayback;
        await this.ctx.storage.put('session', failedCandidate);
        this.adoptPersistedSession(session, failedCandidate);
      }
      return this.rejectV2Command(socket, command, 'target_not_connected');
    }
    if (!persistent) {
      this.adoptPersistedSession(session, candidate);
      protocol = this.ensureProtocolV2(session);
    }
    this.sendV2CommandAck(socket, command, {
      controlEpoch: protocol.controlEpoch,
      leaseEpoch,
      targetPlayerInstanceId,
      entryId,
      runId
    });
    this.broadcastV2Controls({
      type: 'desired_transport',
      protocolVersion: PROTOCOL_V2,
      desiredTransport: protocol.desiredTransport
    });
  }

  async handleV2TestCommand(socket, session, command) {
    let protocol = this.ensureProtocolV2(session);
    const targetPlayerInstanceId = protocolId(command.targetPlayerInstanceId);
    const checkId = protocolId(command.checkId);
    const leaseEpoch = finiteEpoch(command.leaseEpoch);
    const hasForeignIdentity = ['entryId', 'runId', 'switchId', 'targetConnectionId']
      .some((field) => hasOwn(command, field));
    const payloadIsRecord = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload);
    const invalidStartPayload = command.type === 'start_test'
      && (!payloadIsRecord || !protocolId(command.payload.fixtureId)
        || !Number.isSafeInteger(command.payload.durationMs)
        || command.payload.durationMs < 1_000
        || command.payload.durationMs > 10_000);
    const invalidStopPayload = command.type === 'stop_test' && hasOwn(command, 'payload') && !payloadIsRecord;
    if (!targetPlayerInstanceId || !checkId || leaseEpoch === null || hasForeignIdentity
      || invalidStartPayload || invalidStopPayload) {
      return this.rejectV2Command(socket, command, 'invalid_test_identity');
    }
    if (leaseEpoch !== protocol.leaseEpoch) {
      return this.rejectV2Command(socket, command, 'stale_lease_epoch', {
        expected: protocol.leaseEpoch,
        actual: leaseEpoch
      });
    }
    if (targetPlayerInstanceId !== protocol.leaseTarget) {
      return this.rejectV2Command(socket, command, 'foreign_target_player', {
        expected: protocol.leaseTarget,
        actual: targetPlayerInstanceId
      });
    }
    if (command.type === 'start_test' && protocol.activeCheckId) {
      return this.rejectV2Command(socket, command, 'test_already_active', {
        activeCheckId: protocol.activeCheckId
      });
    }
    if (command.type === 'start_test') {
      const desiredStatus = protocol.desiredTransport?.status ?? null;
      const confirmedStatus = protocol.confirmedPlayback?.status ?? null;
      const transportStatus = session.transport?.status ?? null;
      const hasActiveMediaState = [desiredStatus, confirmedStatus, transportStatus]
        .some((status) => V2_TEST_ACTIVE_MEDIA_STATUSES.has(status));
      const requiresIdle = hasActiveMediaState || Boolean(protocol.activeFamily);
      if (requiresIdle) {
        return this.rejectV2Command(socket, command, 'test_requires_idle', {
          desiredStatus,
          confirmedStatus,
          transportStatus,
          activeFamilyPresent: Boolean(protocol.activeFamily)
        });
      }
    }
    const liveness = await this.guardActiveOutputLiveness(
      session,
      targetPlayerInstanceId,
      { mutationLockHeld: true }
    );
    if (!liveness.ok) {
      return this.rejectV2Command(socket, command, liveness.code, liveness.detail);
    }
    protocol = this.ensureProtocolV2(session);
    if (!['ready', 'audible'].includes(protocol.leaseStatus)) {
      return this.rejectV2Command(socket, command, 'output_not_ready', { status: protocol.leaseStatus });
    }
    if (command.type === 'start_test') {
      const targetRecords = this.livePlayerRecords().filter(({ attachment }) => (
        attachment.playerInstanceId === targetPlayerInstanceId
        && attachment.clientKind === 'obs-browser-source'
      ));
      const targetRuntime = targetRecords.length === 1
        ? targetRecords[0].attachment.runtime || {}
        : null;
      if (targetRuntime?.streaming === true) {
        return this.rejectV2Command(socket, command, 'test_blocked_while_streaming');
      }
      if (targetRuntime?.streamingStatusObserved !== true) {
        return this.rejectV2Command(socket, command, 'test_streaming_status_unknown');
      }
    }
    if (command.type === 'stop_test' && protocol.activeCheckId !== checkId) {
      return this.rejectV2Command(socket, command, 'stale_check_identity', {
        expected: protocol.activeCheckId,
        actual: checkId
      });
    }

    const priorActiveCheckId = protocol.activeCheckId;
    const priorActiveCheckProgress = structuredClone(protocol.activeCheckProgress);
    const candidate = structuredClone(session);
    const candidateProtocol = this.ensureProtocolV2(candidate);
    if (command.type === 'start_test') {
      candidateProtocol.activeCheckId = checkId;
      candidateProtocol.activeCheckProgress = { checkId, started: false, markerCount: 0 };
    }
    await this.ctx.storage.put('session', candidate);
    this.adoptPersistedSession(session, candidate);
    protocol = this.ensureProtocolV2(session);

    const delivered = this.sendToPlayerInstance(targetPlayerInstanceId, {
      ...command,
      protocolVersion: PROTOCOL_V2,
      leaseEpoch,
      targetPlayerInstanceId,
      checkId
    });
    if (!delivered) {
      const failedCandidate = structuredClone(session);
      const failedProtocol = this.ensureProtocolV2(failedCandidate);
      failedProtocol.activeCheckId = priorActiveCheckId;
      failedProtocol.activeCheckProgress = priorActiveCheckProgress;
      await this.ctx.storage.put('session', failedCandidate);
      this.adoptPersistedSession(session, failedCandidate);
      return this.rejectV2Command(socket, command, 'target_not_connected');
    }
    this.sendV2CommandAck(socket, command, {
      controlEpoch: protocol.controlEpoch,
      leaseEpoch,
      targetPlayerInstanceId,
      checkId
    });
  }

  finalizeV2EmergencyStopState(candidate) {
    const protocol = this.ensureProtocolV2(candidate);
    const forceResetRequested = protocol.confirmedPlayback?.forceResetRequested === true;
    const recoveryOverride = protocol.confirmedPlayback?.recoveryOverride === true;
    const missingTargetUnverified = protocol.confirmedPlayback?.missingTargetUnverified === true;
    const liveTargetLossUnverified = protocol.confirmedPlayback?.liveTargetLossUnverified === true;
    const legacyTargetsUnverified = finiteEpoch(
      protocol.confirmedPlayback?.legacyTargetsUnverified
    ) ?? 0;
    this.clearRouteTransition(protocol);
    protocol.leaseStatus = 'inactive';
    protocol.pendingEmergencyCommandId = null;
    protocol.pendingEmergencyControlInstanceId = null;
    protocol.pendingEmergencyRequiredPlayerInstanceId = null;
    protocol.pendingEmergencyRequiredTargetKnown = false;
    protocol.pendingEmergencyTargets = [];
    protocol.pendingEmergencyTargetInstances = {};
    protocol.emergencyAcknowledgedTargets = [];
    protocol.pendingEmergencyLegacyCount = 0;
    if (forceResetRequested) protocol.selectedOutputMode = null;
    protocol.confirmedPlayback = recoveryOverride
      ? {
          status: 'unknown',
          reasonCode: 'output_inactive',
          recoveryOverride: true,
          missingTargetUnverified,
          liveTargetLossUnverified,
          legacyTargetsUnverified,
          lastSeenAt: Date.now()
        }
      : {
          status: 'stopped',
          reasonCode: 'emergency_stop_acknowledged',
          position: 0,
          paused: true,
          sourceDetached: true,
          autoplayCancelled: true,
          audible: false,
          lastSeenAt: Date.now()
        };
    candidate.transport = { ...(candidate.transport || {}), status: 'stopped', position: 0 };
  }

  async handleV2EmergencyStop(socket, session, command) {
    const attachment = socket.deserializeAttachment() || {};
    const commandId = protocolId(command.commandId);
    const sessionId = protocolId(command.sessionId);
    const authenticatedControlInstanceId = protocolId(command.authenticatedControlInstanceId);
    if (attachment.protocolVersion !== PROTOCOL_V2 || attachment.negotiationState !== 'negotiated'
      || !attachment.controlInstanceId) {
      return this.rejectV2Command(socket, command, 'control_hello_required');
    }
    const hasForeignIdentity = [
      'entryId', 'runId', 'switchId', 'checkId', 'leaseEpoch', 'controlEpoch',
      'targetPlayerInstanceId', 'targetConnectionId'
    ].some((field) => hasOwn(command, field));
    const invalidPayload = hasOwn(command, 'payload')
      && (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)
        || Object.keys(command.payload).some((field) => field !== 'forceReset')
        || (hasOwn(command.payload, 'forceReset') && typeof command.payload.forceReset !== 'boolean'));
    if (!commandId || hasForeignIdentity || invalidPayload || sessionId !== session.room
      || authenticatedControlInstanceId !== attachment.controlInstanceId) {
      return this.rejectV2Command(socket, command, 'invalid_emergency_identity', {
        expectedSessionId: session.room,
        authenticatedControlInstanceId: attachment.controlInstanceId
      });
    }

    let protocol = this.ensureProtocolV2(session);
    const forceReset = command.payload?.forceReset === true;
    const v2Targets = [];
    const legacyTargets = [];
    const emergencyTargets = [];
    const emergencyTargetInstances = {};
    for (const playerSocket of this.ctx.getWebSockets()) {
      const playerAttachment = playerSocket.deserializeAttachment() || {};
      if (playerAttachment.role !== 'player') continue;
      if (playerAttachment.protocolVersion === PROTOCOL_V2
        && playerAttachment.negotiationState === 'negotiated') {
        v2Targets.push({ socket: playerSocket, attachment: playerAttachment });
        if (playerAttachment.connectionId && playerAttachment.playerInstanceId) {
          emergencyTargets.push(playerAttachment.connectionId);
          emergencyTargetInstances[playerAttachment.connectionId] = playerAttachment.playerInstanceId;
        }
      } else if (playerAttachment.protocolVersion !== PROTOCOL_V2) {
        legacyTargets.push(playerSocket);
      }
    }

    const requiredPlayerInstanceId = protocol.leaseTarget;
    const requiredTargetConnected = requiredPlayerInstanceId === null
      || v2Targets.some(({ attachment: target }) => (
        target.playerInstanceId === requiredPlayerInstanceId
      ));
    const missingTargetUnverified = forceReset
      && requiredPlayerInstanceId !== null
      && !requiredTargetConnected;
    const legacyTargetsUnverified = forceReset ? legacyTargets.length : 0;
    const recoveryOverride = missingTargetUnverified || legacyTargetsUnverified > 0;

    const candidate = structuredClone(session);
    const candidateProtocol = this.ensureProtocolV2(candidate);
    candidateProtocol.leaseEpoch += 1;
    candidateProtocol.leaseTarget = null;
    candidateProtocol.leaseClientKind = null;
    candidateProtocol.leaseStatus = 'emergency_stopping';
    candidateProtocol.switchId = null;
    candidateProtocol.activeFamily = null;
    candidateProtocol.activeCheckId = null;
    candidateProtocol.activeCheckProgress = null;
    candidateProtocol.pendingEmergencyCommandId = commandId;
    candidateProtocol.pendingEmergencyControlInstanceId = authenticatedControlInstanceId;
    candidateProtocol.pendingEmergencyRequiredPlayerInstanceId = missingTargetUnverified
      ? null
      : requiredPlayerInstanceId;
    candidateProtocol.pendingEmergencyRequiredTargetKnown = missingTargetUnverified
      ? true
      : requiredTargetConnected;
    candidateProtocol.pendingEmergencyTargets = [...new Set(emergencyTargets)];
    candidateProtocol.pendingEmergencyTargetInstances = emergencyTargetInstances;
    candidateProtocol.emergencyAcknowledgedTargets = [];
    candidateProtocol.pendingEmergencyLegacyCount = forceReset ? 0 : legacyTargets.length;
    candidateProtocol.desiredTransport = {
      ...(candidateProtocol.desiredTransport || {}),
      status: 'stopped',
      position: 0,
      entryId: null,
      runId: null
    };
    candidateProtocol.confirmedPlayback = {
      status: 'unknown',
      reasonCode: 'emergency_stop_unconfirmed',
      ...(forceReset ? { forceResetRequested: true } : {}),
      ...(recoveryOverride ? {
        recoveryOverride: true,
        missingTargetUnverified,
        legacyTargetsUnverified
      } : {})
    };
    candidate.transport = { ...candidate.transport, status: 'unknown' };
    const canCompleteWithoutPlayerEvent = emergencyTargets.length === 0
      && candidateProtocol.pendingEmergencyLegacyCount === 0
      && candidateProtocol.pendingEmergencyRequiredTargetKnown === true
      && candidateProtocol.pendingEmergencyRequiredPlayerInstanceId === null;
    if (canCompleteWithoutPlayerEvent) this.finalizeV2EmergencyStopState(candidate);
    await this.ctx.storage.put('session', candidate);
    this.adoptPersistedSession(session, candidate);
    protocol = this.ensureProtocolV2(session);

    let deliveredV2 = 0;
    let deliveredV1 = 0;
    for (const { socket: playerSocket } of v2Targets) {
      if (this.sendPendingV2EmergencyStop(playerSocket, session)) deliveredV2 += 1;
    }
    for (const playerSocket of legacyTargets) {
      if (this.send(playerSocket, { type: 'command', command: { type: 'stop', commandId } })) {
        deliveredV1 += 1;
      }
    }

    this.broadcastLegacyControls({ type: 'transport', transport: session.transport });
    this.sendV2CommandAck(socket, command, {
      code: 'emergency_stop_dispatched',
      delivered: { protocolV2: deliveredV2, legacy: deliveredV1 },
      leaseEpoch: protocol.leaseEpoch
    });
    this.broadcastProtocolV2Snapshot(session);
  }

  validateV2PlayerConnectionIdentity(socket, message) {
    const attachment = socket.deserializeAttachment() || {};
    const playerInstanceId = protocolId(message.playerInstanceId);
    if (attachment.protocolVersion !== PROTOCOL_V2 || attachment.negotiationState !== 'negotiated'
      || !attachment.playerInstanceId) {
      return { ok: false, code: 'player_hello_required' };
    }
    if (!playerInstanceId || playerInstanceId !== attachment.playerInstanceId) {
      return {
        ok: false,
        code: 'foreign_player_instance',
        detail: { expected: attachment.playerInstanceId, actual: playerInstanceId }
      };
    }
    const connectionId = protocolId(message.connectionId);
    if (!connectionId || connectionId !== attachment.connectionId) {
      return {
        ok: false,
        code: 'foreign_connection',
        detail: { expected: attachment.connectionId, actual: connectionId }
      };
    }
    return { ok: true, attachment, playerInstanceId, connectionId };
  }

  validateV2PlayerIdentity(socket, protocol, message, family) {
    const connection = this.validateV2PlayerConnectionIdentity(socket, message);
    if (!connection.ok) return connection;
    const { playerInstanceId } = connection;
    const leaseEpoch = finiteEpoch(message.leaseEpoch);
    const isHeartbeat = family === 'heartbeat';
    const isActiveLeaseTarget = protocol.leaseTarget === playerInstanceId;
    const invalidHeartbeatEpoch = isHeartbeat && (
      leaseEpoch === null
      || (isActiveLeaseTarget
        ? leaseEpoch !== protocol.leaseEpoch
        : leaseEpoch > protocol.leaseEpoch)
    );
    if (invalidHeartbeatEpoch || (!isHeartbeat
      && (leaseEpoch === null || leaseEpoch !== protocol.leaseEpoch))) {
      return {
        ok: false,
        code: leaseEpoch !== null && leaseEpoch > protocol.leaseEpoch
          ? 'future_lease_epoch'
          : 'stale_lease_epoch',
        detail: { expected: protocol.leaseEpoch, actual: leaseEpoch }
      };
    }
    if (family !== 'heartbeat' && protocol.leaseTarget !== playerInstanceId) {
      return {
        ok: false,
        code: 'foreign_lease_target',
        detail: { expected: protocol.leaseTarget, actual: playerInstanceId }
      };
    }
    if (family !== 'heartbeat' && (!Number.isFinite(message.monotonicTimeMs) || message.monotonicTimeMs < 0)) {
      return { ok: false, code: 'invalid_monotonic_time' };
    }
    if (family === 'heartbeat' && hasOwn(message, 'monotonicTimeMs')
      && (!Number.isFinite(message.monotonicTimeMs) || message.monotonicTimeMs < 0)) {
      return { ok: false, code: 'invalid_monotonic_time' };
    }
    return { ...connection, leaseEpoch };
  }

  stageV2Sequence(attachment, family, sequence, observedAt = Date.now()) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return { ok: false, code: 'invalid_sequence' };
    const sequences = attachment.sequenceHighWater && typeof attachment.sequenceHighWater === 'object'
      ? { ...attachment.sequenceHighWater }
      : {};
    const previous = finiteEpoch(sequences[family]);
    if (previous !== null && sequence <= previous) {
      return {
        ok: false,
        code: sequence === previous ? 'duplicate_sequence' : 'out_of_order_sequence',
        detail: { family, previous, actual: sequence }
      };
    }
    sequences[family] = sequence;
    const nextAttachment = { ...attachment, sequenceHighWater: sequences, lastSeenAt: observedAt };
    return { ok: true, attachment: nextAttachment };
  }

  async handleV2Heartbeat(socket, session, message) {
    const playerInstanceId = protocolId(message.playerInstanceId) || 'unknown_player';
    const release = await this.acquireV2PlayerQueue(playerInstanceId);
    try {
      let protocol = this.ensureProtocolV2(session);
      const hasForeignIdentity = [
        'entryId', 'runId', 'switchId', 'checkId', 'controlEpoch', 'targetPlayerInstanceId',
        'targetConnectionId'
      ].some((field) => hasOwn(message, field));
      if (hasForeignIdentity) return this.sendProtocolError(socket, 'invalid_heartbeat_identity');
      const identity = this.validateV2PlayerIdentity(socket, protocol, message, 'heartbeat');
      if (!identity.ok) return this.sendProtocolError(socket, identity.code, identity.detail);
      if (protocolId(message.connectionId) !== identity.attachment.connectionId) {
        return this.sendProtocolError(socket, 'foreign_connection', {
          expected: identity.attachment.connectionId,
          actual: protocolId(message.connectionId)
        });
      }

      const observedAt = Date.now();
      const sequence = this.stageV2Sequence(
        identity.attachment,
        v2EventSequenceNamespace(message),
        message.sequence,
        observedAt
      );
      if (!sequence.ok) return this.sendProtocolError(socket, sequence.code, sequence.detail);
      let nextAttachment = sequence.attachment;
      let runtimeChanged = false;
      if (message.runtime && typeof message.runtime === 'object' && !Array.isArray(message.runtime)) {
        const runtimePatch = boundedRecord(message.runtime, [
          'obsPluginVersion', 'obsControlLevel', 'sourceActive', 'sourceVisible', 'streaming', 'streamingStatusObserved', 'recording'
        ]);
        runtimeChanged = Object.entries(runtimePatch).some(
          ([field, value]) => nextAttachment.runtime?.[field] !== value
        );
        nextAttachment = {
          ...nextAttachment,
          runtime: {
            ...(nextAttachment.runtime || {}),
            ...runtimePatch
          }
        };
      }

      const reconnected = await this.restoreObsOutputAfterReconnect(session, nextAttachment, {
        mutationLockHeld: true,
      });
      if (reconnected) protocol = this.ensureProtocolV2(session);

      const issue = this.activeOutputLivenessIssue(session, identity.playerInstanceId, {
        now: observedAt,
        overrideAttachment: nextAttachment
      });
      if (!issue && !this.activeOutputHeartbeatAlarmKnown) {
        await this.ensureActiveOutputHeartbeatAlarm(session, {
          now: observedAt,
          overrideAttachment: nextAttachment
        });
      }
      const transitioned = issue
        ? await this.persistActiveOutputUnknown(session, issue)
        : false;
      socket.serializeAttachment(nextAttachment);
      if (transitioned) this.publishActiveOutputUnknown(session);
      else if (runtimeChanged || reconnected) this.broadcastProtocolV2Snapshot(session);

      for (const controlSocket of this.ctx.getWebSockets()) {
        const controlAttachment = controlSocket.deserializeAttachment() || {};
        if (controlAttachment.role === 'control' && controlAttachment.protocolVersion === PROTOCOL_V2
          && controlAttachment.negotiationState === 'negotiated') {
          this.send(controlSocket, message);
        }
      }
      this.send(socket, {
        type: 'heartbeat_ack',
        protocolVersion: PROTOCOL_V2,
        playerInstanceId: identity.playerInstanceId,
        connectionId: identity.connectionId,
        leaseEpoch: this.ensureProtocolV2(session).leaseEpoch,
        sequence: message.sequence
      });
    } finally {
      release();
    }
  }

  isExactV2StrongStopPostcondition(postcondition) {
    if (!postcondition || typeof postcondition !== 'object' || Array.isArray(postcondition)) return false;
    const expectedFields = [
      'audible',
      'autoplayCancelled',
      'mediaPaused',
      'sourceDetached',
      'status'
    ];
    const actualFields = Object.keys(postcondition).sort();
    return actualFields.length === expectedFields.length
      && actualFields.every((field, index) => field === expectedFields[index])
      && postcondition.status === 'stopped'
      && postcondition.mediaPaused === true
      && postcondition.sourceDetached === true
      && postcondition.autoplayCancelled === true
      && postcondition.audible === false;
  }

  isExactV2AppliedSeekPostcondition(postcondition) {
    if (!postcondition || typeof postcondition !== 'object' || Array.isArray(postcondition)) return false;
    const actualFields = Object.keys(postcondition).sort();
    return actualFields.length === 2
      && actualFields[0] === 'position'
      && actualFields[1] === 'status'
      && Boolean(protocolId(postcondition.status))
      && Number.isFinite(postcondition.position)
      && postcondition.position >= 0;
  }

  isExactV2AppliedVolumePostcondition(postcondition) {
    if (!postcondition || typeof postcondition !== 'object' || Array.isArray(postcondition)) return false;
    const actualFields = Object.keys(postcondition).sort();
    return actualFields.length === 2
      && actualFields[0] === 'status'
      && actualFields[1] === 'volume'
      && Boolean(protocolId(postcondition.status))
      && Number.isFinite(postcondition.volume)
      && postcondition.volume >= 0
      && postcondition.volume <= 100;
  }

  validV2PlaybackPostcondition(message, eventType) {
    const nonNegative = (value) => Number.isFinite(value) && value >= 0;
    const validReadyState = Number.isInteger(message.readyState) && message.readyState >= 0 && message.readyState <= 4;
    if (hasOwn(message, 'commandType') && eventType !== 'command_applied') return false;
    if (hasOwn(message, 'safetyPostcondition') && eventType !== 'command_failed') return false;
    if (hasOwn(message, 'readyState') && !validReadyState) return false;
    for (const field of ['mediaTime', 'duration', 'bufferedEnd', 'rmsDbfs', 'peakDbfs']) {
      if (hasOwn(message, field) && !Number.isFinite(message[field])) return false;
    }
    if (hasOwn(message, 'commandId') && !protocolId(message.commandId)) return false;
    for (const field of ['paused', 'seeking']) {
      if (hasOwn(message, field) && typeof message[field] !== 'boolean') return false;
    }

    if (eventType === 'command_received') return Boolean(protocolId(message.commandId));
    if (eventType === 'command_applied') {
      const baseValid = Boolean(protocolId(message.commandId)
        && message.postcondition && typeof message.postcondition === 'object'
        && !Array.isArray(message.postcondition) && protocolId(message.postcondition.status));
      if (!baseValid) return false;
      if (message.postcondition.status === 'stopped') {
        return message.commandType === 'STOP'
          && this.isExactV2StrongStopPostcondition(message.postcondition);
      }
      if (hasOwn(message, 'commandType')) {
        if (message.commandType === 'SEEK') {
          return this.isExactV2AppliedSeekPostcondition(message.postcondition);
        }
        if (message.commandType === 'VOLUME') {
          return this.isExactV2AppliedVolumePostcondition(message.postcondition);
        }
        if (message.commandType === 'STOP') {
          return this.isExactV2StrongStopPostcondition(message.postcondition);
        }
        return false;
      }
      return !hasOwn(message.postcondition, 'position')
        && !hasOwn(message.postcondition, 'volume');
    }
    if (eventType === 'command_failed') {
      const baseValid = Boolean(protocolId(message.commandId) && protocolId(message.code)
        && (!hasOwn(message, 'detail') || (message.detail && typeof message.detail === 'object' && !Array.isArray(message.detail))));
      if (!baseValid) return false;
      return !hasOwn(message, 'safetyPostcondition')
        || this.isExactV2StrongStopPostcondition(message.safetyPostcondition);
    }
    if (eventType === 'ready') {
      return nonNegative(message.mediaTime) && nonNegative(message.duration)
        && Number.isInteger(message.readyState) && message.readyState >= 2 && message.readyState <= 4
        && message.paused === true;
    }
    if (eventType === 'playing') return nonNegative(message.mediaTime) && message.paused === false;
    if (eventType === 'paused') return nonNegative(message.mediaTime) && message.paused === true;
    if (eventType === 'buffering') {
      return nonNegative(message.mediaTime) && Number.isInteger(message.readyState)
        && message.readyState >= 0 && message.readyState <= 3;
    }
    if (eventType === 'position') {
      return nonNegative(message.mediaTime) && nonNegative(message.duration) && validReadyState
        && typeof message.paused === 'boolean' && typeof message.seeking === 'boolean';
    }
    if (eventType === 'ended') {
      return nonNegative(message.mediaTime) && nonNegative(message.duration) && message.paused === true;
    }
    if (eventType === 'error') {
      return Boolean(protocolId(message.code)
        && (!hasOwn(message, 'detail') || (message.detail && typeof message.detail === 'object' && !Array.isArray(message.detail))));
    }
    if (eventType === 'level') {
      return Number.isFinite(message.rmsDbfs) && Number.isFinite(message.peakDbfs)
        && message.peakDbfs >= message.rmsDbfs;
    }
    return false;
  }

  async handleV2PlaybackEvent(socket, session, message) {
    const eventType = protocolId(message.event);
    const hasForeignIdentity = ['switchId', 'checkId', 'controlEpoch', 'targetPlayerInstanceId', 'targetConnectionId']
      .some((field) => hasOwn(message, field));
    if (!protocolId(message.eventId) || !V2_PLAYBACK_EVENTS.includes(eventType)
      || !protocolId(message.connectionId) || hasForeignIdentity
      || !this.validV2PlaybackPostcondition(message, eventType)) {
      return this.sendProtocolError(socket, 'invalid_playback_event');
    }
    const connection = this.validateV2PlayerConnectionIdentity(socket, message);
    if (!connection.ok) return this.sendProtocolError(socket, connection.code, connection.detail);
    const namespace = v2EventSequenceNamespace(message);
    return this.runV2EventGuard(socket, session, message, namespace, async (targetSession) => {
      const currentProtocol = this.ensureProtocolV2(targetSession);
      const identity = this.validateV2PlayerIdentity(socket, currentProtocol, message, 'run_event');
      if (!identity.ok) {
        this.sendProtocolError(socket, identity.code, identity.detail);
        return null;
      }
      const entryId = protocolId(message.entryId);
      const runId = protocolId(message.runId);
      if (!entryId || !runId
        || currentProtocol.activeFamily?.entryId !== entryId
        || currentProtocol.activeFamily?.runId !== runId) {
        this.sendProtocolError(socket, 'stale_run_identity', {
          expected: currentProtocol.activeFamily,
          actual: { entryId, runId }
        });
        return null;
      }

      const persistent = namespace === 'runAuthoritative';
      const previous = currentProtocol.confirmedPlayback || {};
      const appliedStop = eventType === 'command_applied'
        && message.commandType === 'STOP'
        && this.isExactV2StrongStopPostcondition(message.postcondition);
      const safetyStoppedAfterFailure = eventType === 'command_failed'
        && this.isExactV2StrongStopPostcondition(message.safetyPostcondition);
      const strongStopped = appliedStop || safetyStoppedAfterFailure;
      const appliedSeek = eventType === 'command_applied'
        && message.commandType === 'SEEK'
        && this.isExactV2AppliedSeekPostcondition(message.postcondition);
      const appliedVolume = eventType === 'command_applied'
        && message.commandType === 'VOLUME'
        && this.isExactV2AppliedVolumePostcondition(message.postcondition);
      const confirmed = strongStopped
        ? {
            status: 'stopped',
            reasonCode: eventType === 'command_applied'
              ? 'stop_command_applied'
              : 'command_failed_after_safety_stop',
            playerInstanceId: identity.playerInstanceId,
            leaseEpoch: identity.leaseEpoch,
            entryId,
            runId,
            event: eventType,
            commandId: message.commandId,
            ...(eventType === 'command_failed' ? { failureCode: message.code } : {}),
            position: 0,
            paused: true,
            sourceDetached: true,
            autoplayCancelled: true,
            audible: false,
            lastSeenAt: Date.now()
          }
        : {
            ...previous,
            playerInstanceId: identity.playerInstanceId,
            leaseEpoch: identity.leaseEpoch,
            entryId,
            runId,
            event: eventType,
            lastSeenAt: Date.now()
          };
      const mediaTime = Number.isFinite(message.mediaTime)
        ? Math.max(0, message.mediaTime)
        : Number.isFinite(message.position) ? Math.max(0, message.position) : null;
      if (mediaTime !== null) confirmed.position = mediaTime;
      if (Number.isFinite(message.duration)) confirmed.duration = Math.max(0, message.duration);
      if (Number.isFinite(message.bufferedEnd)) confirmed.bufferedEnd = Math.max(0, message.bufferedEnd);
      if (Number.isFinite(message.readyState)) confirmed.readyState = Math.max(0, Math.min(4, Math.trunc(message.readyState)));
      if (typeof message.paused === 'boolean') confirmed.paused = message.paused;
      if (typeof message.seeking === 'boolean') confirmed.seeking = message.seeking;
      if (Number.isFinite(message.rmsDbfs)) confirmed.rmsDbfs = message.rmsDbfs;
      if (Number.isFinite(message.peakDbfs)) confirmed.peakDbfs = message.peakDbfs;
      // Preserve the exact player-applied command identity in the authoritative
      // snapshot. The Dashboard can then distinguish its own latest request
      // from stale or foreign evidence without any extra message or storage
      // write. Older players remain valid because these fields are derived only
      // when their existing event already carries them.
      if (['command_applied', 'command_failed'].includes(eventType)
        && protocolId(message.commandId)) {
        confirmed.commandId = message.commandId;
        confirmed.commandType = appliedSeek
          ? 'SEEK'
          : appliedVolume ? 'VOLUME'
            : appliedStop ? 'STOP' : null;
      }
      if (appliedSeek) confirmed.position = message.postcondition.position;
      if (appliedVolume) confirmed.volume = message.postcondition.volume;
      if (['ready', 'playing', 'paused', 'buffering', 'ended', 'error'].includes(eventType)) {
        confirmed.status = eventType;
      }
      currentProtocol.confirmedPlayback = confirmed;
      if (strongStopped) currentProtocol.activeFamily = null;

      // Route readiness and confirmed media activity are separate truths. Only
      // an authoritative HTMLMediaElement `playing` event proves the active
      // player is presently audible; command receipt/application and telemetry
      // do not. A route already made unknown/deactivating by stronger safety
      // evidence is never resurrected by a late playback event.
      if (safetyStoppedAfterFailure && ['ready', 'audible'].includes(currentProtocol.leaseStatus)) {
        currentProtocol.leaseStatus = 'unknown';
      } else if (['ready', 'audible'].includes(currentProtocol.leaseStatus)) {
        if (appliedStop) currentProtocol.leaseStatus = 'ready';
        else if (eventType === 'playing') currentProtocol.leaseStatus = 'audible';
        else if (['ready', 'paused', 'buffering', 'ended', 'error'].includes(eventType)) {
          currentProtocol.leaseStatus = 'ready';
        }
      }

      const nextTransport = { ...targetSession.transport };
      if (strongStopped) {
        nextTransport.status = 'stopped';
        nextTransport.position = 0;
      } else if (mediaTime !== null) nextTransport.position = mediaTime;
      if (Number.isFinite(message.duration)) nextTransport.duration = Math.max(0, message.duration);
      if (appliedSeek) nextTransport.position = message.postcondition.position;
      if (appliedVolume) nextTransport.volume = message.postcondition.volume;
      if (!strongStopped
        && ['ready', 'playing', 'paused', 'buffering', 'ended', 'error'].includes(eventType)) {
        nextTransport.status = eventType;
      }
      targetSession.transport = nextTransport;

      return {
        status: persistent ? 'applied' : 'relayed',
        afterCommit: () => {
          this.broadcastV2Controls(message);
          if (persistent) this.broadcastProtocolV2Snapshot(session);
          this.broadcastLegacyControls({
            type: 'player_event',
            event: {
              type: eventType,
              sessionId: runId,
              position: confirmed.position,
              duration: confirmed.duration
            },
            transport: nextTransport,
            protocolVersion: PROTOCOL_V2
          });
        }
      };
    });
  }

  async handleV2RouteEvent(socket, session, message) {
    const eventType = protocolId(message.event);
    const postcondition = message.postcondition;
    const validFailureDetail = !hasOwn(message, 'detail')
      || (message.detail && typeof message.detail === 'object' && !Array.isArray(message.detail));
    const failurePostconditionFields = ['mediaPaused', 'sourceDetached', 'autoplayCancelled', 'audible'];
    const validFailurePostcondition = !hasOwn(message, 'postcondition')
      || (postcondition && typeof postcondition === 'object' && !Array.isArray(postcondition)
        && Object.keys(postcondition).every((field) => failurePostconditionFields.includes(field))
        && Object.values(postcondition).every((value) => typeof value === 'boolean')
        && !(postcondition.mediaPaused === true
          && postcondition.sourceDetached === true
          && postcondition.autoplayCancelled === true
          && postcondition.audible === false));
    const readyPostconditionFields = [
      'mediaPaused', 'sourceDetached', 'autoplayCancelled', 'outputPathReady', 'audible'
    ];
    const validPostcondition = eventType === 'output_deactivated'
      ? postcondition && typeof postcondition === 'object' && !Array.isArray(postcondition)
        && postcondition.mediaPaused === true && postcondition.sourceDetached === true
        && postcondition.autoplayCancelled === true
      : eventType === 'output_ready'
        ? postcondition && typeof postcondition === 'object' && !Array.isArray(postcondition)
          && Object.keys(postcondition).length === readyPostconditionFields.length
          && Object.keys(postcondition).every((field) => readyPostconditionFields.includes(field))
          && postcondition.mediaPaused === true && postcondition.sourceDetached === true
          && postcondition.autoplayCancelled === true && postcondition.outputPathReady === true
          && postcondition.audible === false
        : eventType === 'output_activation_failed'
          ? Boolean(protocolId(message.code) && validFailureDetail)
          : eventType === 'output_deactivation_failed'
            ? Boolean(protocolId(message.code) && validFailureDetail && validFailurePostcondition)
          : false;
    const hasForeignIdentity = [
      'entryId', 'runId', 'checkId', 'controlEpoch', 'targetPlayerInstanceId', 'targetConnectionId'
    ]
      .some((field) => hasOwn(message, field));
    if (!protocolId(message.eventId) || !protocolId(message.connectionId)
      || !V2_ROUTE_EVENTS.includes(eventType)
      || hasForeignIdentity || !validPostcondition) {
      return this.sendProtocolError(socket, 'invalid_route_event');
    }
    const connection = this.validateV2PlayerConnectionIdentity(socket, message);
    if (!connection.ok) return this.sendProtocolError(socket, connection.code, connection.detail);
    const namespace = v2EventSequenceNamespace(message);
    return this.runV2EventGuard(socket, session, message, namespace, async (candidate) => {
      const currentProtocol = this.ensureProtocolV2(candidate);
      const identity = this.validateV2PlayerIdentity(socket, currentProtocol, message, 'route_event');
      if (!identity.ok) {
        this.sendProtocolError(socket, identity.code, identity.detail);
        return null;
      }
      const switchId = protocolId(message.switchId);
      if (!switchId || switchId !== currentProtocol.switchId) {
        this.sendProtocolError(socket, 'stale_switch_identity', {
          expected: currentProtocol.switchId,
          actual: switchId
        });
        return null;
      }
      const protocol = currentProtocol;
      const terminalTransition = this.currentRouteTransitionForProtocol(protocol);
      let playerState;
      if (eventType === 'output_ready') {
        if (protocol.leaseStatus !== 'activating') {
          this.sendProtocolError(socket, 'invalid_route_transition', {
            expected: 'activating',
            actual: protocol.leaseStatus
          });
          return null;
        }
        if (terminalTransition?.identity.operation === 'activate') {
          this.clearRouteTransition(protocol, terminalTransition.identity);
        }
        protocol.leaseStatus = 'ready';
        protocol.confirmedPlayback = { status: 'unknown', reasonCode: 'output_ready_no_playback' };
        playerState = 'ready';
      } else if (eventType === 'output_activation_failed') {
        if (protocol.leaseStatus !== 'activating') {
          this.sendProtocolError(socket, 'invalid_route_transition', {
            expected: 'activating',
            actual: protocol.leaseStatus
          });
          return null;
        }
        if (terminalTransition?.identity.operation === 'activate') {
          this.clearRouteTransition(protocol, terminalTransition.identity);
        }
        protocol.leaseStatus = 'failed';
        protocol.confirmedPlayback = { status: 'unknown', reasonCode: 'output_activation_failed' };
        playerState = 'failed';
      } else if (eventType === 'output_deactivation_failed') {
        if (protocol.leaseStatus !== 'deactivating') {
          this.sendProtocolError(socket, 'invalid_route_transition', {
            expected: 'deactivating',
            actual: protocol.leaseStatus
          });
          return null;
        }
        const detail = boundedFailureDetail(message.detail);
        if (terminalTransition?.identity.operation === 'deactivate') {
          this.clearRouteTransition(protocol, terminalTransition.identity);
        }
        protocol.leaseStatus = 'unknown';
        protocol.confirmedPlayback = {
          status: 'unknown',
          reasonCode: 'output_deactivation_failed',
          code: protocolId(message.code),
          ...(detail ? { detail } : {})
        };
        candidate.transport = { ...(candidate.transport || {}), status: 'unknown' };
        playerState = 'unknown';
      } else {
        if (protocol.leaseStatus !== 'deactivating') {
          this.sendProtocolError(socket, 'invalid_route_transition', {
            expected: 'deactivating',
            actual: protocol.leaseStatus
          });
          return null;
        }
        if (terminalTransition?.identity.operation === 'deactivate') {
          this.clearRouteTransition(protocol, terminalTransition.identity);
        }
        playerState = 'standby';
        protocol.leaseTarget = null;
        protocol.leaseClientKind = null;
        protocol.leaseStatus = 'inactive';
        protocol.switchId = null;
        protocol.activeFamily = null;
        protocol.activeCheckId = null;
        protocol.activeCheckProgress = null;
        protocol.confirmedPlayback = { status: 'unknown', reasonCode: 'output_inactive' };
      }
      return {
        status: 'applied',
        afterCommit: () => {
          this.broadcastV2Controls(message);
          this.broadcastProtocolV2Snapshot(session);
          this.setPlayerInstanceState(identity.playerInstanceId, playerState);
        }
      };
    });
  }

  async handleV2TestEvent(socket, session, message) {
    const eventType = protocolId(message.event);
    const postcondition = message.postcondition;
    const validSafetyPostcondition = eventType === 'test_failed'
      ? !hasOwn(message, 'safetyPostcondition')
        || this.isExactV2StrongStopPostcondition(message.safetyPostcondition)
      : !hasOwn(message, 'safetyPostcondition');
    const validPostcondition = eventType === 'test_marker'
      ? Number.isSafeInteger(message.markerIndex) && message.markerIndex >= 0
        && Number.isFinite(message.markerTimeMs) && message.markerTimeMs >= 0
      : eventType === 'test_complete'
        ? Number.isSafeInteger(message.markerCount) && message.markerCount >= 0
          && postcondition && typeof postcondition === 'object' && !Array.isArray(postcondition)
          && postcondition.stopped === true
        : eventType === 'test_failed'
          ? Boolean(protocolId(message.code)
            && (!hasOwn(message, 'detail')
              || (message.detail && typeof message.detail === 'object' && !Array.isArray(message.detail))))
          : eventType === 'test_started';
    const invalidTelemetry = ['markerTimeMs', 'rmsDbfs', 'peakDbfs']
      .some((field) => hasOwn(message, field) && !Number.isFinite(message[field]));
    const hasForeignIdentity = [
      'entryId', 'runId', 'switchId', 'controlEpoch', 'targetPlayerInstanceId', 'targetConnectionId'
    ]
      .some((field) => hasOwn(message, field));
    if (!protocolId(message.eventId) || !protocolId(message.connectionId)
      || !V2_TEST_EVENTS.includes(eventType)
      || invalidTelemetry || hasForeignIdentity || !validPostcondition
      || !validSafetyPostcondition) {
      return this.sendProtocolError(socket, 'invalid_test_event');
    }
    const connection = this.validateV2PlayerConnectionIdentity(socket, message);
    if (!connection.ok) return this.sendProtocolError(socket, connection.code, connection.detail);
    const namespace = v2EventSequenceNamespace(message);
    return this.runV2EventGuard(socket, session, message, namespace, async (candidate) => {
      const currentProtocol = this.ensureProtocolV2(candidate);
      const identity = this.validateV2PlayerIdentity(socket, currentProtocol, message, 'test_event');
      if (!identity.ok) {
        this.sendProtocolError(socket, identity.code, identity.detail);
        return null;
      }
      const checkId = protocolId(message.checkId);
      if (!checkId || checkId !== currentProtocol.activeCheckId) {
        this.sendProtocolError(socket, 'stale_check_identity', {
          expected: currentProtocol.activeCheckId,
          actual: checkId
        });
        return null;
      }
      const progress = currentProtocol.activeCheckProgress;
      if (!progress || progress.checkId !== checkId) {
        this.sendProtocolError(socket, 'invalid_test_progress', {
          event: eventType,
          checkId,
          reason: 'missing_check_progress'
        });
        return null;
      }
      if (eventType === 'test_started') {
        if (progress.started) {
          this.sendProtocolError(socket, 'invalid_test_progress', {
            event: eventType,
            checkId,
            reason: 'test_already_started'
          });
          return null;
        }
        progress.started = true;
        progress.markerCount = 0;
      } else if (eventType === 'test_marker') {
        if (!progress.started) {
          this.sendProtocolError(socket, 'invalid_test_progress', {
            event: eventType,
            checkId,
            reason: 'test_not_started'
          });
          return null;
        }
        if (progress.markerCount >= V2_TEST_MAX_MARKERS) {
          this.sendProtocolError(socket, 'invalid_test_progress', {
            event: eventType,
            checkId,
            reason: 'marker_limit_exceeded',
            limit: V2_TEST_MAX_MARKERS
          });
          return null;
        }
        if (message.markerIndex !== progress.markerCount) {
          this.sendProtocolError(socket, 'invalid_test_progress', {
            event: eventType,
            checkId,
            reason: 'marker_index_mismatch',
            expectedMarkerIndex: progress.markerCount,
            actualMarkerIndex: message.markerIndex
          });
          return null;
        }
      } else if (eventType === 'test_complete') {
        if (!progress.started) {
          this.sendProtocolError(socket, 'invalid_test_progress', {
            event: eventType,
            checkId,
            reason: 'test_not_started'
          });
          return null;
        }
        if (progress.markerCount < 1 || message.markerCount !== progress.markerCount) {
          this.sendProtocolError(socket, 'invalid_test_progress', {
            event: eventType,
            checkId,
            reason: progress.markerCount < 1 ? 'markers_required' : 'marker_count_mismatch',
            expectedMarkerCount: progress.markerCount,
            actualMarkerCount: message.markerCount
          });
          return null;
        }
      }
      const terminal = ['test_complete', 'test_failed'].includes(eventType);
      const safetyStopUnproven = eventType === 'test_failed'
        && !this.isExactV2StrongStopPostcondition(message.safetyPostcondition);
      if (terminal) {
        const protocol = this.ensureProtocolV2(candidate);
        protocol.activeCheckId = null;
        protocol.activeCheckProgress = null;
        if (safetyStopUnproven) {
          const detail = boundedFailureDetail(message.detail);
          protocol.leaseStatus = 'unknown';
          protocol.confirmedPlayback = {
            status: 'unknown',
            reasonCode: 'test_safety_stop_failed',
            code: protocolId(message.code),
            ...(detail ? { detail } : {})
          };
          candidate.transport = { ...(candidate.transport || {}), status: 'unknown' };
        }
      }
      return {
        status: terminal ? 'applied' : 'relayed',
        afterCommit: () => {
          if (eventType === 'test_marker') {
            const committedProgress = this.ensureProtocolV2(session).activeCheckProgress;
            if (committedProgress?.checkId === checkId
              && committedProgress.started
              && committedProgress.markerCount === message.markerIndex) {
              committedProgress.markerCount += 1;
            }
          }
          if (safetyStopUnproven) this.setPlayerInstanceState(identity.playerInstanceId, 'unknown');
          this.broadcastV2Controls(message);
          if (terminal) this.broadcastProtocolV2Snapshot(session);
        }
      };
    });
  }

  async handleV2EmergencyAck(socket, session, message) {
    const attachment = socket.deserializeAttachment() || {};
    const playerInstanceId = protocolId(message.playerInstanceId);
    const commandId = protocolId(message.commandId);
    const hasForeignIdentity = [
      'entryId', 'runId', 'switchId', 'checkId', 'leaseEpoch', 'controlEpoch', 'targetPlayerInstanceId',
      'targetConnectionId'
    ].some((field) => hasOwn(message, field));
    const invalidMonotonicTime = !Number.isFinite(message.monotonicTimeMs) || message.monotonicTimeMs < 0;
    const invalidPostcondition = !message.postcondition || typeof message.postcondition !== 'object'
      || Array.isArray(message.postcondition)
      || message.postcondition.mediaPaused !== true
      || message.postcondition.sourceDetached !== true
      || message.postcondition.autoplayCancelled !== true;
    if (!protocolId(message.eventId)
      || attachment.protocolVersion !== PROTOCOL_V2
      || attachment.negotiationState !== 'negotiated'
      || hasForeignIdentity
      || invalidMonotonicTime
      || invalidPostcondition
      || playerInstanceId !== attachment.playerInstanceId
      || protocolId(message.connectionId) !== attachment.connectionId
      || protocolId(message.sessionId) !== session.room) {
      return this.sendProtocolError(socket, 'invalid_emergency_ack_identity');
    }
    const namespace = v2EventSequenceNamespace(message);
    return this.runV2EventGuard(socket, session, message, namespace, async (candidate) => {
      const currentAttachment = socket.deserializeAttachment() || {};
      const currentProtocol = this.ensureProtocolV2(candidate);
      if (!(currentProtocol.pendingEmergencyTargets || []).includes(currentAttachment.connectionId)
        || commandId !== currentProtocol.pendingEmergencyCommandId) {
        this.sendProtocolError(socket, 'invalid_emergency_ack_identity');
        return null;
      }
      const protocol = currentProtocol;
      protocol.emergencyAcknowledgedTargets = [...new Set([
        ...(protocol.emergencyAcknowledgedTargets || []),
        currentAttachment.connectionId
      ])];
      const allV2TargetsAcknowledged = (protocol.pendingEmergencyTargets || [])
        .every((target) => protocol.emergencyAcknowledgedTargets.includes(target));
      const requiredPlayerInstanceId = protocol.pendingEmergencyRequiredPlayerInstanceId;
      const requiredTargetAcknowledged = protocol.pendingEmergencyRequiredTargetKnown === true
        && (
          requiredPlayerInstanceId === null
          || (protocol.pendingEmergencyTargets || []).some((target) => (
            protocol.pendingEmergencyTargetInstances?.[target] === requiredPlayerInstanceId
            && protocol.emergencyAcknowledgedTargets.includes(target)
          ))
        );
      if (allV2TargetsAcknowledged
        && protocol.pendingEmergencyLegacyCount === 0
        && requiredTargetAcknowledged) {
        // A normal emergency stop remains exact-proof only. A user-confirmed
        // full reset may release a vanished target after every currently live
        // v2 player has detached; the snapshot keeps that missing target
        // explicitly unverified instead of manufacturing physical proof.
        this.finalizeV2EmergencyStopState(candidate);
      }
      return {
        status: 'applied',
        afterCommit: () => {
          this.broadcastV2Controls(message);
          this.broadcastProtocolV2Snapshot(session);
        }
      };
    });
  }

  async handleCommand(socket, session, message) {
    const command = message.command || {};
    if (!command.commandId || !command.type) return this.send(socket, { type: 'error', code: 'invalid_command' });

    const protocol = this.ensureProtocolV2(session);
    if (protocol.writableControlInstanceId) {
      return this.send(socket, { type: 'error', code: 'protocol_v2_control_active' });
    }

    if (command.type === 'end_session') {
      const blocked = this.sessionEndBlockDetail(session);
      if (blocked) return this.send(socket, {
        type: 'error',
        code: 'session_end_requires_idle',
        detail: blocked,
        commandId: command.commandId
      });
      await this.endSession(session, 'explicit');
      return this.send(socket, { type: 'command_ack', commandId: command.commandId });
    }

    if (command.type === 'display_state') {
      session.display = displayState(command.display);
      await this.ctx.storage.put('session', session);
      this.broadcast({ type: 'display_state', display: session.display }, 'display');
      this.send(socket, { type: 'command_ack', commandId: command.commandId });
      return;
    }

    // 프리버퍼 힌트: 다가오는 곡의 videoId(최대 2개)를 player 위젯에 릴레이만
    // 한다 — 위젯이 준비된 오디오를 미리 통째로 받아 곡 전환을 즉시 만들기 위함.
    // ★ 순수 릴레이: transport/세션 상태를 일절 바꾸지 않고 storage.put 도 절대
    // 하지 않는다. 큐가 바뀔 때마다 올 수 있는 힌트라 영속하면 DO 쓰기가 다시
    // 폭증한다(무료 티어 쓰기 한도 초과 사고 재발 방지). 힌트가 유실·실패해도
    // 위젯은 기존 스트리밍 재생으로 폴백하므로 신뢰성 요구가 없다.
    if (command.type === 'prefetch') {
      const videoIds = (Array.isArray(command.videoIds) ? command.videoIds : [])
        .filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id))
        .slice(0, 2);
      this.broadcast({ type: 'command', command: { type: 'prefetch', commandId: command.commandId, videoIds } }, 'player');
      return this.send(socket, { type: 'command_ack', commandId: command.commandId });
    }

    // A legacy control command has no target/epoch identity. Once a v2 lease is
    // active it must not bypass that lease; during mixed rollout it is relayed
    // only to legacy players so a standby v2 output can never start audibly.
    if (protocol.leaseTarget) {
      return this.send(socket, { type: 'error', code: 'protocol_v2_lease_active' });
    }
    const liveLegacyPlayers = this.ctx.getWebSockets().filter((candidate) => {
      const attachment = candidate.deserializeAttachment() || {};
      return attachment.role === 'player' && attachment.protocolVersion !== PROTOCOL_V2;
    });
    // Legacy commands have no target identity. They are safe only when exactly
    // one legacy player exists; broadcasting to two browser sources can create
    // real double audio before Protocol v2 has a chance to arbitrate a lease.
    if (liveLegacyPlayers.length !== 1) {
      return this.send(socket, {
        type: 'error',
        code: 'legacy_player_count',
        detail: { expected: 1, actual: liveLegacyPlayers.length }
      });
    }

    const nextTransport = { ...session.transport };
    if (command.type === 'load') {
      nextTransport.song = command.song || null;
      nextTransport.sessionId = command.sessionId || crypto.randomUUID();
      nextTransport.position = Number(command.position) || 0;
      if (Number.isFinite(command.volume)) nextTransport.volume = Math.max(0, Math.min(100, command.volume));
      nextTransport.status = 'loading';
    } else if (command.type === 'play') {
      nextTransport.status = 'playing';
    } else if (command.type === 'pause') {
      nextTransport.status = 'paused';
    } else if (command.type === 'seek') {
      nextTransport.position = Math.max(0, Number(command.position) || 0);
    } else if (command.type === 'volume') {
      nextTransport.volume = Math.max(0, Math.min(100, Number(command.volume) || 0));
    } else if (command.type === 'stop') {
      nextTransport.status = 'stopped';
      nextTransport.position = 0;
      nextTransport.song = null;
      nextTransport.sessionId = null;
    } else {
      return this.send(socket, { type: 'error', code: 'unsupported_command' });
    }

    session.transport = nextTransport;
    // seek 은 position 만 바꾸는 자기보정 값이다(플레이어 position 이벤트가 곧
    // 덮어씀) — 재생바 드래그가 seek 명령을 연발하므로 영속하면 DO 쓰기가 폭증한다.
    // 브로드캐스트는 유지해 플레이어가 즉시 반응하되, 스토리지에는 남기지 않는다.
    // (Antigravity f461686 은 position 이벤트만 막았고 이 명령 쪽 폭풍은 놓쳤다.)
    if (command.type !== 'seek') await this.ctx.storage.put('session', session);
    this.broadcastLegacyPlayers({ type: 'command', command: { ...command, sessionId: nextTransport.sessionId } });
    this.broadcastLegacyControls({ type: 'transport', transport: nextTransport });
    this.send(socket, { type: 'command_ack', commandId: command.commandId });
  }

  async handlePlayerEvent(session, message) {
    const event = message.event || {};
    if (!event.type) return;

    // Legacy events do not carry player/run/lease identity and therefore
    // cannot confirm a v2-routed output.
    if (this.ensureProtocolV2(session).leaseTarget) return;

    if (event.sessionId && session.transport.sessionId && event.sessionId !== session.transport.sessionId) return;

    const nextTransport = { ...session.transport };
    if (typeof event.position === 'number') nextTransport.position = Math.max(0, event.position);
    if (typeof event.duration === 'number') nextTransport.duration = Math.max(0, event.duration);
    if (['ready', 'playing', 'paused', 'buffering', 'ended', 'error'].includes(event.type)) {
      nextTransport.status = event.type;
    }
    session.transport = nextTransport;
    // ★ position 은 초당 발화하는 순수 진행도라 DO 스토리지에 영속하지 않는다
    // (Gemini f461686). 2시간 방송이면 세션당 ~7200회 쓰기 → DO 쓰기 한도(10만/일)
    // 를 동시 스트리머 몇 명이면 소진한다. 인메모리 캐시(this.sessionState)에는
    // 반영되므로 후속 읽기는 최신 위치를 보고, 다음 상태변경 이벤트에서 함께 영속된다.
    if (event.type !== 'position') await this.ctx.storage.put('session', session);
    this.broadcastLegacyControls({ type: 'player_event', event, transport: nextTransport });
  }

  async uploadAsset(request) {
    const session = await this.getSession();
    const token = parseBearer(request);
    if (!session || session.status !== 'active' || !(await this.authenticate(session, token, 'control'))) {
      return json({ error: 'Unauthorized or closed session' }, 401);
    }

    const declaredSize = Number(request.headers.get('X-Rekasong-Size'));
    if (!request.body || !Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > MAX_UPLOAD_BYTES) {
      return json({ error: 'Unsupported upload size' }, 400);
    }

    const assetId = crypto.randomUUID();
    const contentType = request.headers.get('X-Rekasong-Type') || 'application/octet-stream';
    const rawName = request.headers.get('X-Rekasong-Name') || 'local-media';
    const filename = decodeURIComponent(rawName).slice(0, 180);
    const key = assetKey(session.room, assetId);
    const object = await this.env.MEDIA_BUCKET.put(key, request.body, {
      httpMetadata: { contentType },
      customMetadata: { filename, session: session.room }
    });
    if (!object) return json({ error: 'Upload failed' }, 500);

    session.assets[assetId] = { key, filename, contentType, size: object.size, uploadedAt: Date.now() };
    await this.ctx.storage.put('session', session);
    return json({ assetId, filename, contentType, size: object.size });
  }

  async streamAsset(request) {
    const session = await this.getSession();
    const url = new URL(request.url);
    const assetId = url.pathname.split('/').pop();
    const token = url.searchParams.get('token') || '';
    if (!session || session.status !== 'active' || !(await this.authenticate(session, token, 'player'))) {
      return json({ error: 'This media session has ended' }, 410);
    }
    const asset = session.assets?.[assetId];
    if (!asset) return json({ error: 'Media not found' }, 404);

    const object = await this.env.MEDIA_BUCKET.get(asset.key, { range: request.headers });
    if (!object) return json({ error: 'Media not found' }, 404);
    return mediaResponse(object);
  }

  async webSocketClose(socket, code, reason, wasClean) {
    const closingAttachment = socket.deserializeAttachment() || {};
    const role = closingAttachment.role;
    if (Number.isInteger(code) || typeof wasClean === 'boolean') {
      console.info('websocket:close', {
        role: typeof role === 'string' ? role : 'unknown',
        protocolVersion: Number.isInteger(closingAttachment.protocolVersion)
          ? closingAttachment.protocolVersion
          : null,
        code: Number.isInteger(code) ? code : null,
        wasClean: typeof wasClean === 'boolean' ? wasClean : null,
        reasonPresent: typeof reason === 'string' && reason.length > 0
      });
    }
    // 같은 역할의 다른 소켓이 남아 있으면(위젯 새로고침 시 새/구 연결 겹침 등)
    // connected 는 여전히 true 다 — 닫히는 소켓 자신은 집계에서 제외한다.
    // (거짓 false 로 대시보드 표시가 깜빡이거나 재생 게이트가 오작동하지 않게.)
    const stillConnected = this.ctx.getWebSockets()
      .some((other) => {
        if (other === socket) return false;
        const attachment = other.deserializeAttachment() || {};
        return attachment.role === role && attachment.negotiationState !== 'unnegotiated';
      });
    const releaseDurableQueue = await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
    try {
      const session = await this.getSession();
      const candidateSession = session ? structuredClone(session) : null;
      let shouldPersist = false;
      let transportChanged = false;
      if (session && role === 'control' && closingAttachment.protocolVersion === PROTOCOL_V2
        && closingAttachment.negotiationState === 'negotiated') {
        const protocol = this.ensureProtocolV2(candidateSession);
        const sameOwnerConnected = this.ctx.getWebSockets().some((candidate) => {
          if (candidate === socket) return false;
          const attachment = candidate.deserializeAttachment() || {};
          return attachment.role === 'control'
            && attachment.protocolVersion === PROTOCOL_V2
            && attachment.negotiationState === 'negotiated'
            && attachment.controlInstanceId === closingAttachment.controlInstanceId;
        });
        if (protocol.writableControlInstanceId === closingAttachment.controlInstanceId && !sameOwnerConnected) {
          protocol.controlEpoch += 1;
          protocol.writableControlInstanceId = null;
          shouldPersist = true;
        }
      }
      if (session && role === 'player' && closingAttachment.protocolVersion === PROTOCOL_V2) {
        const protocol = this.ensureProtocolV2(candidateSession);
        const sameInstanceConnected = this.livePlayerRecords(socket)
          .some(({ attachment }) => attachment.playerInstanceId === closingAttachment.playerInstanceId);
        const closingPendingForcedResetTarget = protocol.leaseStatus === 'emergency_stopping'
          && protocol.confirmedPlayback?.forceResetRequested === true
          && protocol.pendingEmergencyTargets.includes(closingAttachment.connectionId)
          && !sameInstanceConnected;
        if (closingPendingForcedResetTarget) {
          protocol.pendingEmergencyTargets = protocol.pendingEmergencyTargets
            .filter((target) => target !== closingAttachment.connectionId);
          protocol.emergencyAcknowledgedTargets = protocol.emergencyAcknowledgedTargets
            .filter((target) => target !== closingAttachment.connectionId);
          protocol.pendingEmergencyTargetInstances = Object.fromEntries(
            Object.entries(protocol.pendingEmergencyTargetInstances || {})
              .filter(([target]) => target !== closingAttachment.connectionId)
          );
          const requiredTargetClosed = protocol.pendingEmergencyRequiredPlayerInstanceId
            === closingAttachment.playerInstanceId;
          if (requiredTargetClosed) {
            protocol.pendingEmergencyRequiredPlayerInstanceId = null;
            protocol.pendingEmergencyRequiredTargetKnown = true;
          }
          protocol.confirmedPlayback = {
            ...protocol.confirmedPlayback,
            recoveryOverride: true,
            missingTargetUnverified: protocol.confirmedPlayback?.missingTargetUnverified === true
              || requiredTargetClosed,
            liveTargetLossUnverified: true,
          };
          const allRemainingTargetsAcknowledged = protocol.pendingEmergencyTargets
            .every((target) => protocol.emergencyAcknowledgedTargets.includes(target));
          const requiredTargetResolved = protocol.pendingEmergencyRequiredTargetKnown === true
            && (
              protocol.pendingEmergencyRequiredPlayerInstanceId === null
              || protocol.pendingEmergencyTargets.some((target) => (
                protocol.pendingEmergencyTargetInstances?.[target]
                  === protocol.pendingEmergencyRequiredPlayerInstanceId
                && protocol.emergencyAcknowledgedTargets.includes(target)
              ))
            );
          if (allRemainingTargetsAcknowledged
            && protocol.pendingEmergencyLegacyCount === 0
            && requiredTargetResolved) {
            this.finalizeV2EmergencyStopState(candidateSession);
            transportChanged = true;
          }
          shouldPersist = true;
        }
        if (protocol.leaseTarget === closingAttachment.playerInstanceId && !sameInstanceConnected) {
          const interruptedTransition = this.currentRouteTransitionForProtocol(protocol);
          if (interruptedTransition) {
            this.clearRouteTransition(protocol, interruptedTransition.identity);
          }
          protocol.leaseStatus = 'unknown';
          protocol.confirmedPlayback = {
            status: 'unknown',
            reasonCode: 'target_disconnected',
            playerInstanceId: closingAttachment.playerInstanceId,
            leaseEpoch: protocol.leaseEpoch
          };
          if (['loading', 'playing', 'buffering', 'ready'].includes(candidateSession.transport?.status)) {
            candidateSession.transport = { ...candidateSession.transport, status: 'unknown' };
            transportChanged = true;
          }
          shouldPersist = true;
        }
      }
      if (!this.hasConnectedSessionParticipant(socket)) {
        // A disconnected media element did not prove that it paused. Preserve
        // uncertainty explicitly instead of manufacturing a paused confirmation.
        if (candidateSession && ['loading', 'playing', 'buffering'].includes(candidateSession.transport?.status)) {
          candidateSession.transport = { ...candidateSession.transport, status: 'unknown' };
          shouldPersist = true;
          transportChanged = true;
        }
        await this.ctx.storage.setAlarm(Date.now() + SESSION_RECONNECT_GRACE_MS);
        this.activeOutputHeartbeatAlarmKnown = false;
      }
      if (session && shouldPersist) {
        await this.ctx.storage.put('session', candidateSession);
        this.adoptPersistedSession(session, candidateSession);
      }
      if (closingAttachment.negotiationState !== 'unnegotiated') {
        if (role === 'control') {
          this.broadcastLegacyPlayers({ type: 'presence', role, connected: stillConnected });
        } else {
          this.broadcastLegacyControls({ type: 'presence', role, connected: stillConnected });
        }
      }
      if (session && transportChanged) {
        this.broadcastLegacyControls({ type: 'transport', transport: session.transport });
      }
      if (session) this.broadcastProtocolV2Snapshot(session, socket);
    } finally {
      releaseDurableQueue();
    }
  }

  async alarm() {
    // Cloudflare reports getAlarm() as null while the alarm handler is
    // running, so any still-needed deadline must be explicitly re-armed.
    this.activeOutputHeartbeatAlarmKnown = false;
    const releaseDurableQueue = await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
    try {
      // Re-read both the authoritative session reference and live socket state
      // only after every in-flight hello/close/event mutation has committed.
      // Otherwise a grace alarm can end a player that has just re-enrolled.
      const session = await this.getSession();
      if (!session) return;
      if (session.status === 'ended') {
        // A previously queued grace/watchdog event can reach this handler after
        // endSession has persisted a later cleanup deadline. Preserve the full
        // retention window and explicitly re-arm the consumed alarm.
        if (Number.isFinite(session.cleanupAt) && Date.now() < session.cleanupAt) {
          await this.ctx.storage.setAlarm(session.cleanupAt);
          return;
        }
        await this.deleteAssets(session);
        return;
      }
      if (!this.hasConnectedSessionParticipant()) {
        await this.endSessionWhileDurableQueueHeld(session, 'player_disconnected');
        return;
      }
      const routeTransition = this.currentRouteTransition(session);
      if (routeTransition && Date.now() >= routeTransition.deadlineAt) {
        const transitioned = await this.persistRouteTransitionTimeout(session, routeTransition, {
          mutationLockHeld: true
        });
        if (transitioned) this.publishActiveOutputUnknown(session);
        return;
      }
      const protocol = this.ensureProtocolV2(session);
      const issue = this.activeOutputLivenessIssue(session, protocol.leaseTarget);
      if (issue) {
        const transitioned = await this.persistActiveOutputUnknown(session, issue, {
          mutationLockHeld: true
        });
        if (transitioned) this.publishActiveOutputUnknown(session);
        return;
      }
      await this.ensureActiveOutputHeartbeatAlarm(session);
    } finally {
      releaseDurableQueue();
    }
  }

  async endSession(session, reason) {
    const releaseDurableQueue = await this.acquireV2PlayerQueue(V2_DURABLE_MUTATION_QUEUE_KEY);
    try {
      // The caller may have observed `session` before waiting for this queue.
      // Always finish from the latest adopted durable state instead.
      const currentSession = await this.getSession();
      return await this.endSessionWhileDurableQueueHeld(currentSession || session, reason);
    } finally {
      releaseDurableQueue();
    }
  }

  async endSessionWhileDurableQueueHeld(session, reason) {
    if (!session) return;
    if (session.status === 'ended') return;
    const candidate = structuredClone(session);
    candidate.status = 'ended';
    candidate.endedAt = Date.now();
    candidate.cleanupAt = candidate.endedAt + ASSET_DELETE_DELAY_MS;
    candidate.transport = { ...candidate.transport, status: 'stopped', position: 0 };
    this.clearRouteTransition(this.ensureProtocolV2(candidate));
    await this.ctx.storage.put('session', candidate);
    this.adoptPersistedSession(session, candidate);
    for (const socket of this.ctx.getWebSockets()) this.sendSessionEnded(socket, session, reason);
    await this.ctx.storage.setAlarm(session.cleanupAt);
    this.activeOutputHeartbeatAlarmKnown = false;
  }

  async deleteAssets(session) {
    const keys = Object.values(session.assets || {}).map((asset) => asset.key);
    if (keys.length) await this.env.MEDIA_BUCKET.delete(keys);
    await this.ctx.storage.deleteAll();
    this.sessionState = null;
  }

  broadcast(message, role) {
    for (const socket of this.ctx.getWebSockets()) {
      const socketRole = socket.deserializeAttachment()?.role;
      if (!role || socketRole === role) this.send(socket, message);
    }
  }

  broadcastV2Controls(message) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.role === 'control' && attachment.protocolVersion === PROTOCOL_V2
        && attachment.negotiationState === 'negotiated') this.send(socket, message);
    }
  }

  broadcastLegacyControls(message) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.role === 'control' && attachment.protocolVersion !== PROTOCOL_V2) this.send(socket, message);
    }
  }

  sendSessionEnded(socket, session, reasonCode) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.protocolVersion === PROTOCOL_V2) {
      this.send(socket, {
        type: 'session_ended',
        protocolVersion: PROTOCOL_V2,
        reasonCode,
        cleanupAt: Number.isFinite(session?.cleanupAt) ? session.cleanupAt : Date.now()
      });
      return;
    }
    this.send(socket, { type: 'session_ended', reason: reasonCode, cleanupAt: session?.cleanupAt });
  }

  broadcastLegacyPlayers(message) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.role === 'player' && attachment.protocolVersion !== PROTOCOL_V2) {
        this.send(socket, message);
      }
    }
  }

  // excluded: webSocketClose 중인 소켓 — 런타임 버전에 따라 닫히는 소켓이
  // getWebSockets() 에 아직 남아 있을 수 있어 명시적으로 제외한다.
  hasConnectedPlayer(excluded) {
    return this.ctx.getWebSockets()
      .some((socket) => {
        if (socket === excluded) return false;
        const attachment = socket.deserializeAttachment() || {};
        return attachment.role === 'player' && attachment.negotiationState !== 'unnegotiated';
      });
  }

  handleV2ControlHeartbeat(socket, message) {
    const attachment = socket.deserializeAttachment() || {};
    const controlInstanceId = protocolId(message.controlInstanceId);
    const connectionId = protocolId(message.connectionId);
    const allowedFields = new Set([
      'type',
      'controlInstanceId',
      'connectionId',
      'sequence',
      'monotonicTimeMs'
    ]);
    const invalidShape = Object.keys(message).some((field) => !allowedFields.has(field))
      || !Number.isSafeInteger(message.sequence)
      || message.sequence < 0
      || (hasOwn(message, 'monotonicTimeMs')
        && (!Number.isFinite(message.monotonicTimeMs) || message.monotonicTimeMs < 0));
    if (attachment.protocolVersion !== PROTOCOL_V2
      || attachment.negotiationState !== 'negotiated') {
      return this.sendProtocolError(socket, 'control_heartbeat_requires_negotiation');
    }
    if (!controlInstanceId || !connectionId || invalidShape) {
      return this.sendProtocolError(socket, 'invalid_control_heartbeat');
    }
    if (attachment.controlInstanceId !== controlInstanceId
      || attachment.connectionId !== connectionId) {
      return this.sendProtocolError(socket, 'foreign_control_heartbeat', {
        controlInstanceId,
        connectionId
      });
    }
    // Transport keepalive only: no response, durable write, attachment update,
    // snapshot broadcast, or control-lease mutation.
    return undefined;
  }

  // A dashboard control is the owner of an active listening/broadcast setup.
  // Speaker mode intentionally has no server-side player, so session lifetime
  // must follow either a negotiated control or a negotiated player instead of
  // requiring a player at all times. Display-only widgets do not keep abandoned
  // sessions alive indefinitely.
  hasConnectedSessionParticipant(excluded) {
    return this.ctx.getWebSockets().some((socket) => {
      if (socket === excluded) return false;
      const attachment = socket.deserializeAttachment() || {};
      return ['control', 'player'].includes(attachment.role)
        && attachment.negotiationState !== 'unnegotiated';
    });
  }

  // 스냅숏용 presence 집계 — 위젯 두 역할의 "지금 실제 연결" 여부.
  // 스토리지에 아무것도 쓰지 않는다(런타임 소켓 상태가 유일한 진실).
  // 참고: OBS 브라우저 소스가 얼어도 소켓이 안 닫힐 수 있다. 재생 중에는
  // player 의 position 이벤트가 암묵 하트비트지만, 유휴 시 감지가 필요해지면
  // 서버 주기 ping / last-seen 방식을 여기에 더할 수 있다(이번 범위 밖).
  connectedWidgetPresence() {
    const presence = { player: false, display: false };
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.negotiationState === 'unnegotiated') continue;
      const role = attachment.role;
      if (role === 'player' || role === 'display') presence[role] = true;
    }
    return presence;
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      // Closed sockets are removed by the runtime.
      return false;
    }
  }
}

// 전역 싱글턴(idFromName('global')). 방 단위가 아니다 — 준비 캐시와 큐는
// 모든 방송이 공유한다. (PREPARE_PIPELINE.md §2)
export class PrepareQueue {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/v1/prepare' && request.method === 'POST') return this.requestPrepare(request);
    if (url.pathname === '/v1/prepare/claim' && request.method === 'POST') return this.claim(request);
    if (url.pathname === '/v1/prepare/stats' && request.method === 'GET') return this.stats(request);

    const match = url.pathname.match(/^\/v1\/prepare\/([A-Za-z0-9_-]{11})(?:\/(bytes|fail|heartbeat))?$/);
    if (!match) return json({ error: 'Not found' }, 404);
    const [, videoId, action] = match;
    if (!action && request.method === 'GET') return this.status(videoId);
    if (action === 'bytes' && request.method === 'PUT') return this.uploadBytes(request, videoId);
    if (action === 'fail' && request.method === 'POST') return this.markFailed(request, videoId);
    if (action === 'heartbeat' && request.method === 'POST') return this.heartbeat(request, videoId);
    return json({ error: 'Not found' }, 404);
  }

  // 시크릿 미설정 상태에서 열려버리는 fail-open을 막기 위해 env 부재도 거부한다.
  async verifyWorker(request) {
    const token = parseBearer(request);
    if (!token || !this.env.PREPARE_TOKEN) return false;
    return (await hashToken(token)) === (await hashToken(this.env.PREPARE_TOKEN));
  }

  async getJob(videoId) {
    return this.ctx.storage.get(`job:${videoId}`);
  }

  async putJob(job) {
    await this.ctx.storage.put(`job:${job.videoId}`, job);
  }

  async listJobs() {
    const stored = await this.ctx.storage.list({ prefix: 'job:' });
    return [...stored.values()];
  }

  async bumpCounters(update) {
    const counters = await this.getCounters();
    update(counters);
    await this.ctx.storage.put('counters', counters);
  }

  async getCounters() {
    return await this.ctx.storage.get('counters') || {
      claims: 0,
      ready: 0,
      leaseExpired: 0,
      failures: { botwall: 0, unavailable: 0, network: 0, upload: 0, unknown: 0 }
    };
  }

  publicJob(job) {
    if (!job) return { status: 'absent' };
    const view = { status: job.status, videoId: job.videoId, attempts: job.attempts || 0 };
    if (job.status === 'preparing') {
      view.claimedAt = job.claimedAt;
      view.leaseUntil = job.leaseUntil;
    }
    if (job.status === 'ready') {
      view.size = job.size;
      view.contentType = job.contentType;
      view.preparedAt = job.preparedAt;
    }
    if (job.status === 'failed') {
      view.failureKind = job.failureKind;
      view.reason = job.reason;
      view.failedAt = job.failedAt;
      view.nextRetryAt = job.nextRetryAt;
    }
    return view;
  }

  async enqueue(videoId, previous) {
    const now = Date.now();
    const job = {
      videoId,
      status: 'queued',
      createdAt: previous?.createdAt || now,
      queuedAt: now,
      attempts: previous?.attempts || 0
    };
    await this.putJob(job);
    return job;
  }

  // 멱등: ready면 작업을 만들지 않고 즉시 반환한다(캐시 히트 = YouTube 미접촉).
  async requestPrepare(request) {
    const body = await request.json().catch(() => ({}));
    const videoId = String(body?.videoId || '');
    if (!VIDEO_ID_PATTERN.test(videoId)) return json({ error: 'Invalid videoId' }, 400);

    const job = await this.getJob(videoId);
    if (job?.status === 'queued' || job?.status === 'preparing') return json(this.publicJob(job));

    if (job?.status === 'ready') {
      // 수동/TTL 정리로 바이트만 사라진 ready는 거짓 안전이다. 폴링(GET)이 아닌
      // 스테이징 시점에만 실존을 확인해 R2 head 비용을 요청 1회로 묶는다.
      // force도 여기엔 적용하지 않는다 — 실존하는 바이트를 다시 받을 이유가 없다.
      if (await this.env.MEDIA_BUCKET.head(audioKey(videoId))) return json(this.publicJob(job));
      return json(this.publicJob(await this.enqueue(videoId, job)), 202);
    }

    if (job?.status === 'failed') {
      // force는 사용자의 명시적 재시도 전용 문이다. failed(unavailable 포함)를
      // 지우고 재큐하되, 자동 경로(claim)의 정책은 그대로다 — unavailable을
      // 기계가 계속 긁으면 죽은 영상 요청이 봇월을 부른다. 시도 이력도 초기화해
      // 백오프가 새로 시작된다.
      if (body?.force === true) {
        return json(this.publicJob(await this.enqueue(videoId, { createdAt: job.createdAt })), 202);
      }
      // unavailable은 영구 실패 — 재큐 금지. 그 외에는 백오프가 지난 뒤에만
      // 재큐한다(스테이징 재시도가 botwall 백오프를 우회하면 안 된다).
      if (job.failureKind === 'unavailable') return json(this.publicJob(job));
      if ((job.nextRetryAt || 0) > Date.now()) return json(this.publicJob(job));
      return json(this.publicJob(await this.enqueue(videoId, job)), 202);
    }

    return json(this.publicJob(await this.enqueue(videoId, null)), 202);
  }

  async status(videoId) {
    return json(this.publicJob(await this.getJob(videoId)));
  }

  // DO는 이벤트 단위 직렬 실행이므로 이 안의 조회→갱신이 곧 원자적 claim이다.
  async claim(request) {
    if (!(await this.verifyWorker(request))) return json({ error: 'Unauthorized' }, 401);

    const now = Date.now();
    let candidate = null;
    let candidateAt = Infinity;
    for (const job of await this.listJobs()) {
      const eligible = job.status === 'queued'
        || (job.status === 'failed' && job.failureKind !== 'unavailable' && (job.nextRetryAt || 0) <= now);
      if (!eligible) continue;
      const at = job.queuedAt ?? job.nextRetryAt ?? job.createdAt;
      if (at < candidateAt) {
        candidate = job;
        candidateAt = at;
      }
    }
    if (!candidate) return new Response(null, { status: 204, headers: corsHeaders });

    const claimed = {
      videoId: candidate.videoId,
      status: 'preparing',
      createdAt: candidate.createdAt,
      attempts: (candidate.attempts || 0) + 1,
      claimedAt: now,
      leaseUntil: now + PREPARE_LEASE_MS
    };
    await this.putJob(claimed);
    await this.bumpCounters((counters) => { counters.claims += 1; });
    await this.scheduleLeaseAlarm();
    return json({ videoId: claimed.videoId, leaseUntil: claimed.leaseUntil, attempts: claimed.attempts });
  }

  async uploadBytes(request, videoId) {
    if (!(await this.verifyWorker(request))) return json({ error: 'Unauthorized' }, 401);
    const job = await this.getJob(videoId);
    if (!job) return json({ error: 'Unknown prepare job' }, 404);

    // R2 스트리밍 put은 길이를 알아야 한다 — 청크 전송이면 여기서 걸러진다.
    const declaredSize = Number(request.headers.get('Content-Length'));
    if (!request.body || !Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > MAX_UPLOAD_BYTES) {
      return json({ error: 'Unsupported upload size' }, 400);
    }

    const contentType = request.headers.get('Content-Type') || 'audio/mp4';
    const object = await this.env.MEDIA_BUCKET.put(audioKey(videoId), request.body, {
      httpMetadata: { contentType },
      customMetadata: { videoId }
    });
    if (!object) return json({ error: 'Upload failed' }, 500);

    // 리스 만료로 재큐된 뒤 도착한 업로드도 받는다 — 바이트가 실존하면 ready가
    // 진실이고, 이 상태 모델의 판정 기준은 "실제로 존재하는 바이트"다.
    await this.putJob({
      videoId,
      status: 'ready',
      createdAt: job.createdAt,
      attempts: job.attempts || 0,
      size: object.size,
      contentType,
      preparedAt: Date.now()
    });
    await this.bumpCounters((counters) => { counters.ready += 1; });
    await this.scheduleLeaseAlarm();
    return json({ ok: true, size: object.size });
  }

  async markFailed(request, videoId) {
    if (!(await this.verifyWorker(request))) return json({ error: 'Unauthorized' }, 401);
    const job = await this.getJob(videoId);
    if (!job) return json({ error: 'Unknown prepare job' }, 404);
    // 리스 만료 후 다른 워커가 이미 완성했다면, 죽은 줄 알았던 워커의 늦은
    // 실패 보고가 실존하는 바이트를 강등시키면 안 된다.
    if (job.status === 'ready') return json({ ok: true, ignored: 'already ready' });

    const body = await request.json().catch(() => ({}));
    const failureKind = FAILURE_KINDS.includes(body?.failureKind) ? body.failureKind : 'unknown';
    const now = Date.now();
    const nextRetryAt = failureKind === 'unavailable'
      ? null
      : now + retryDelayMs(failureKind, job.attempts || 1);

    await this.putJob({
      videoId,
      status: 'failed',
      createdAt: job.createdAt,
      attempts: job.attempts || 0,
      failureKind,
      reason: String(body?.reason || '').slice(0, 500),
      failedAt: now,
      nextRetryAt
    });
    await this.bumpCounters((counters) => { counters.failures[failureKind] += 1; });
    await this.scheduleLeaseAlarm();
    return json({ ok: true, failureKind, nextRetryAt });
  }

  async heartbeat(request, videoId) {
    if (!(await this.verifyWorker(request))) return json({ error: 'Unauthorized' }, 401);
    const job = await this.getJob(videoId);
    // 리스가 이미 만료돼 다른 워커가 잡았을 수 있다 — 409로 원래 워커가 중단하게 한다.
    if (!job || job.status !== 'preparing') return json({ error: 'Lease lost' }, 409);

    job.leaseUntil = Date.now() + PREPARE_LEASE_MS;
    await this.putJob(job);
    await this.scheduleLeaseAlarm();
    return json({ leaseUntil: job.leaseUntil });
  }

  async stats(request) {
    if (!(await this.verifyWorker(request))) return json({ error: 'Unauthorized' }, 401);

    const counts = { queued: 0, preparing: 0, ready: 0, failed: 0 };
    for (const job of await this.listJobs()) {
      if (counts[job.status] !== undefined) counts[job.status] += 1;
    }
    const counters = await this.getCounters();
    const failureTotal = Object.values(counters.failures).reduce((sum, value) => sum + value, 0);
    const resolved = counters.ready + failureTotal;
    return json({
      counts,
      counters,
      // 쿠키 투입 여부의 판단 근거(§6): 처리 결과(ready+실패) 대비 botwall 비율.
      botwallRate: resolved ? counters.failures.botwall / resolved : 0
    });
  }

  // 워커가 죽어도 작업이 영원히 잠기지 않도록, 만료된 리스를 queued로 되돌린다.
  async alarm() {
    const now = Date.now();
    for (const job of await this.listJobs()) {
      if (job.status !== 'preparing' || (job.leaseUntil || 0) > now) continue;
      await this.putJob({
        videoId: job.videoId,
        status: 'queued',
        createdAt: job.createdAt,
        queuedAt: now,
        attempts: job.attempts || 0
      });
      await this.bumpCounters((counters) => { counters.leaseExpired += 1; });
    }
    await this.scheduleLeaseAlarm();
  }

  async scheduleLeaseAlarm() {
    let earliest = Infinity;
    for (const job of await this.listJobs()) {
      if (job.status === 'preparing' && (job.leaseUntil || 0) < earliest) earliest = job.leaseUntil;
    }
    if (earliest === Infinity) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(earliest);
  }
}
