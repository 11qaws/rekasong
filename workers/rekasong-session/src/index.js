const SESSION_GRACE_MS = 2 * 60 * 1000;
const SESSION_INITIAL_GRACE_MS = 30 * 60 * 1000;
const ASSET_DELETE_DELAY_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const PREPARE_LEASE_MS = 120 * 1000;
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

    const routeMatch = url.pathname.match(/^\/v1\/sessions\/([a-f0-9-]+)\/(ws|assets|media|display-token)(?:\/([^/]+))?$/i);
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
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/init') return this.initialize(request);
    if (request.method === 'POST' && url.pathname === '/verify-media-token') return this.verifyMediaToken(request);
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
    if (!this.sessionState) this.sessionState = await this.ctx.storage.get('session');
    return this.sessionState;
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
    if (!['control', 'player', 'display'].includes(role)) return json({ error: 'Invalid socket role' }, 400);

    const session = await this.getSession();
    if (!session || session.status !== 'active' || !(await this.authenticate(session, token, role))) {
      return json({ error: 'Unauthorized or closed session' }, 401);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });
    // The OBS player being back is the only signal that broadcast output is
    // live again. A controller refresh must not keep abandoned media alive.
    if (role === 'player') await this.ctx.storage.deleteAlarm();
    this.send(server, {
      type: 'snapshot',
      transport: session.transport,
      display: session.display || { currentSong: null, history: [] },
      // 현재 위젯 연결 상태(런타임 소켓 집계 — 스토리지 스키마 불변).
      // control 이 언제 붙거나 재접속해도 이미 연결된 위젯을 즉시 안다.
      presence: this.connectedWidgetPresence(),
      session: { room: session.room, status: session.status }
    });
    // 위젯(player·display) 연결은 control 에, control 연결은 player 에 알린다.
    // display 도 대칭으로 브로드캐스트한다 — OBS 설정 흐름에서 화면 정보 위젯이
    // 실제로 들어왔는지 대시보드가 확인해야 하기 때문.
    if (role === 'player' || role === 'display') this.broadcast({ type: 'presence', role, connected: true }, 'control');
    if (role === 'control') this.broadcast({ type: 'presence', role, connected: true }, 'player');
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    let message;
    try {
      message = JSON.parse(typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage));
    } catch {
      return this.send(socket, { type: 'error', code: 'invalid_message' });
    }

    const role = socket.deserializeAttachment()?.role;
    const session = await this.getSession();
    if (!session || session.status !== 'active') return this.send(socket, { type: 'session_ended' });

    if (role === 'control') {
      if (message.type === 'command') await this.handleCommand(socket, session, message);
      return;
    }
    if (role === 'player' && message.type === 'event') await this.handlePlayerEvent(session, message);
  }

  async handleCommand(socket, session, message) {
    const command = message.command || {};
    if (!command.commandId || !command.type) return this.send(socket, { type: 'error', code: 'invalid_command' });

    if (command.type === 'end_session') {
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
    this.broadcast({ type: 'command', command: { ...command, sessionId: nextTransport.sessionId } }, 'player');
    this.broadcast({ type: 'transport', transport: nextTransport }, 'control');
    this.send(socket, { type: 'command_ack', commandId: command.commandId });
  }

  async handlePlayerEvent(session, message) {
    const event = message.event || {};
    if (!event.type) return;

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
    this.broadcast({ type: 'player_event', event, transport: nextTransport }, 'control');
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

  async webSocketClose(socket) {
    const role = socket.deserializeAttachment()?.role;
    // 같은 역할의 다른 소켓이 남아 있으면(위젯 새로고침 시 새/구 연결 겹침 등)
    // connected 는 여전히 true 다 — 닫히는 소켓 자신은 집계에서 제외한다.
    // (거짓 false 로 대시보드 표시가 깜빡이거나 재생 게이트가 오작동하지 않게.)
    const stillConnected = this.ctx.getWebSockets()
      .some((other) => other !== socket && other.deserializeAttachment()?.role === role);
    this.broadcast({ type: 'presence', role, connected: stillConnected });
    if (!this.hasConnectedPlayer(socket)) {
      // 플레이어(OBS 위젯)가 모두 끊기면 재생 중이던 상태를 paused 로 내려
      // 대시보드가 진실을 반영하게 한다(Gemini f461686 — 허공 재생 표시 방지).
      const session = await this.getSession();
      if (session && ['loading', 'playing', 'buffering'].includes(session.transport?.status)) {
        session.transport = { ...session.transport, status: 'paused' };
        await this.ctx.storage.put('session', session);
        this.broadcast({ type: 'transport', transport: session.transport }, 'control');
      }
      await this.ctx.storage.setAlarm(Date.now() + SESSION_GRACE_MS);
    }
  }

  async alarm() {
    const session = await this.getSession();
    if (!session) return;
    if (session.status === 'ended') {
      await this.deleteAssets(session);
      return;
    }
    if (!this.hasConnectedPlayer()) await this.endSession(session, 'player_disconnected');
  }

  async endSession(session, reason) {
    if (session.status === 'ended') return;
    session.status = 'ended';
    session.endedAt = Date.now();
    session.cleanupAt = session.endedAt + ASSET_DELETE_DELAY_MS;
    session.transport = { ...session.transport, status: 'stopped', position: 0 };
    await this.ctx.storage.put('session', session);
    this.broadcast({ type: 'session_ended', reason, cleanupAt: session.cleanupAt });
    await this.ctx.storage.setAlarm(session.cleanupAt);
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

  // excluded: webSocketClose 중인 소켓 — 런타임 버전에 따라 닫히는 소켓이
  // getWebSockets() 에 아직 남아 있을 수 있어 명시적으로 제외한다.
  hasConnectedPlayer(excluded) {
    return this.ctx.getWebSockets()
      .some((socket) => socket !== excluded && socket.deserializeAttachment()?.role === 'player');
  }

  // 스냅숏용 presence 집계 — 위젯 두 역할의 "지금 실제 연결" 여부.
  // 스토리지에 아무것도 쓰지 않는다(런타임 소켓 상태가 유일한 진실).
  // 참고: OBS 브라우저 소스가 얼어도 소켓이 안 닫힐 수 있다. 재생 중에는
  // player 의 position 이벤트가 암묵 하트비트지만, 유휴 시 감지가 필요해지면
  // 서버 주기 ping / last-seen 방식을 여기에 더할 수 있다(이번 범위 밖).
  connectedWidgetPresence() {
    const presence = { player: false, display: false };
    for (const socket of this.ctx.getWebSockets()) {
      const role = socket.deserializeAttachment()?.role;
      if (role === 'player' || role === 'display') presence[role] = true;
    }
    return presence;
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Closed sockets are removed by the runtime.
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
