const SESSION_GRACE_MS = 2 * 60 * 1000;
const SESSION_INITIAL_GRACE_MS = 30 * 60 * 1000;
const ASSET_DELETE_DELAY_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      const room = crypto.randomUUID();
      const controlToken = randomToken();
      const playerToken = randomToken();
      const id = env.SESSION_ROOM.idFromName(room);
      const stub = env.SESSION_ROOM.get(id);
      const initRequest = new Request('https://session.internal/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, controlToken, playerToken })
      });
      const result = await stub.fetch(initRequest);
      if (!result.ok) return result;
      return json({ room, controlToken, playerToken });
    }

    const routeMatch = url.pathname.match(/^\/v1\/sessions\/([a-f0-9-]+)\/(ws|assets|media)(?:\/([^/]+))?$/i);
    if (!routeMatch) return json({ error: 'Not found' }, 404);

    const [, room] = routeMatch;
    const id = env.SESSION_ROOM.idFromName(room);
    return env.SESSION_ROOM.get(id).fetch(request);
  }
};

export class SessionRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/init') return this.initialize(request);
    if (url.pathname.endsWith('/ws')) return this.openSocket(request);
    if (url.pathname.endsWith('/assets') && request.method === 'POST') return this.uploadAsset(request);
    if (/\/media\/[^/]+$/.test(url.pathname) && request.method === 'GET') return this.streamAsset(request);
    return json({ error: 'Not found' }, 404);
  }

  async initialize(request) {
    const existing = await this.ctx.storage.get('session');
    if (existing) return json({ error: 'Session already exists' }, 409);
    const { room, controlToken, playerToken } = await request.json();
    if (!room || !controlToken || !playerToken) return json({ error: 'Invalid session setup' }, 400);

    await this.ctx.storage.put('session', {
      room,
      status: 'active',
      controlHash: await hashToken(controlToken),
      playerHash: await hashToken(playerToken),
      assets: {},
      transport: { status: 'idle', song: null, sessionId: null, position: 0, volume: 100 },
      endedAt: null,
      cleanupAt: null
    });
    // A staging upload can create a session before OBS has opened its player.
    // Do not retain those files forever if the broadcast is never started.
    await this.ctx.storage.setAlarm(Date.now() + SESSION_INITIAL_GRACE_MS);
    return json({ ok: true });
  }

  async getSession() {
    return this.ctx.storage.get('session');
  }

  async authenticate(session, token, role) {
    if (!session || !token) return false;
    const expected = role === 'control' ? session.controlHash : session.playerHash;
    return Boolean(expected) && expected === await hashToken(token);
  }

  async openSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426);
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') || '';
    if (!['control', 'player'].includes(role)) return json({ error: 'Invalid socket role' }, 400);

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
    this.send(server, { type: 'snapshot', transport: session.transport, session: { room: session.room, status: session.status } });
    this.broadcast({ type: 'presence', role, connected: true }, role === 'player' ? 'control' : 'player');
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
    await this.ctx.storage.put('session', session);
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
    await this.ctx.storage.put('session', session);
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
    this.broadcast({ type: 'presence', role, connected: false });
    if (!this.hasConnectedPlayer()) {
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
  }

  broadcast(message, role) {
    for (const socket of this.ctx.getWebSockets()) {
      const socketRole = socket.deserializeAttachment()?.role;
      if (!role || socketRole === role) this.send(socket, message);
    }
  }

  hasConnectedPlayer() {
    return this.ctx.getWebSockets().some((socket) => socket.deserializeAttachment()?.role === 'player');
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Closed sockets are removed by the runtime.
    }
  }
}
