import { useEffect, useRef } from 'react';

const CHANNEL_NAME_PREFIX = 'rekasong-widget-sync';
const STORAGE_KEY_PREFIX = 'rekasong-widget-sync-data';
const ROOM_STORAGE_KEY = 'rekasong-widget-room';
const KEYS_STORAGE_KEY = 'rekasong-widget-keys';

const channelName = (room) => `${CHANNEL_NAME_PREFIX}-${room || 'default'}`;
const storageKey = (room) => `${STORAGE_KEY_PREFIX}-${room || 'default'}`;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  return Uint8Array.from(atob(t + pad), c => c.charCodeAt(0));
};

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGO = { name: 'ECDSA', hash: 'SHA-256' };

export async function getOrCreateSigningKeys() {
  try {
    const stored = localStorage.getItem(KEYS_STORAGE_KEY);
    if (stored) {
      const { priv, pub } = JSON.parse(stored);
      const privateKey = await crypto.subtle.importKey('jwk', priv, ECDSA, false, ['sign']);
      return { privateKey, publicKeyB64: pub };
    }
  } catch { }

  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKeyB64 = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  try {
    localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify({ priv: privJwk, pub: publicKeyB64 }));
  } catch { }
  return { privateKey: pair.privateKey, publicKeyB64 };
}

export function resetSigningKeys() {
  try { localStorage.removeItem(KEYS_STORAGE_KEY); } catch { }
}

const signPayload = async (privateKey, state, timestamp) => {
  const data = new TextEncoder().encode(`${JSON.stringify(state)}|${timestamp}`);
  return b64url(await crypto.subtle.sign(SIGN_ALGO, privateKey, data));
};

const verifyPayload = async (publicKeyB64, payload) => {
  try {
    if (!payload || !payload.sig || !payload.state || !payload.timestamp) return false;
    const key = await crypto.subtle.importKey('raw', fromB64url(publicKeyB64), ECDSA, false, ['verify']);
    const data = new TextEncoder().encode(`${JSON.stringify(payload.state)}|${payload.timestamp}`);
    return await crypto.subtle.verify(SIGN_ALGO, key, fromB64url(payload.sig), data);
  } catch {
    return false;
  }
};

const isLocalDev = () =>
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const ntfyTopic = (room) => `https://ntfy.sh/rekasong-${room}`;

export function getOrCreateRoom() {
  try {
    let room = localStorage.getItem(ROOM_STORAGE_KEY);
    if (!room) {
      room = createRoom();
      localStorage.setItem(ROOM_STORAGE_KEY, room);
    }
    return room;
  } catch {
    return createRoom();
  }
}

export function createRoom() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export function saveRoom(room) {
  try { localStorage.setItem(ROOM_STORAGE_KEY, room); } catch { }
}

const RELAY_DEBOUNCE_MS = 500;
let ntfyTimer = null;

export function publishSync(payload, room, privateKey) {
  try {
    const channel = new BroadcastChannel(channelName(room));
    channel.postMessage(payload);
    channel.close();
  } catch { }

  try {
    localStorage.setItem(storageKey(room), JSON.stringify(payload));
  } catch { }

  if (isLocalDev() && room) {
    fetch(`${window.location.origin}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, payload })
    }).catch(() => {});
  }

  if (room && privateKey) {
    clearTimeout(ntfyTimer);
    ntfyTimer = setTimeout(async () => {
      try {
        const sig = await signPayload(privateKey, payload.state, payload.timestamp);
        await fetch(ntfyTopic(room), {
          method: 'POST',
          body: JSON.stringify({ ...payload, sig }),
        });
      } catch { }
    }, RELAY_DEBOUNCE_MS);
  }
}

export function useWidgetSync(room, publicKeyB64, onSync) {
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  useEffect(() => {
    const handle = (payload) => {
      if (payload && payload.state) onSyncRef.current(payload);
    };

    try {
      const cached = localStorage.getItem(storageKey(room));
      if (cached) handle(JSON.parse(cached));
    } catch { }

    const handleStorage = (e) => {
      if (e.key === storageKey(room) && e.newValue) {
        try { handle(JSON.parse(e.newValue)); } catch { }
      }
    };
    window.addEventListener('storage', handleStorage);

    let channel;
    try {
      channel = new BroadcastChannel(channelName(room));
      channel.onmessage = (e) => handle(e.data);
    } catch { }

    let devInterval;
    if (isLocalDev()) {
      let lastTimestamp = 0;
      devInterval = setInterval(async () => {
        try {
          const res = await fetch(`${window.location.origin}/api/sync?room=${encodeURIComponent(room || '')}`);
          if (!res.ok) return;
          const payload = await res.json();
          if (payload && payload.state && payload.timestamp > lastTimestamp) {
            lastTimestamp = payload.timestamp;
            handle(payload);
          }
        } catch { }
      }, 1000);
    }

    let es;
    if (room && publicKeyB64) {
      let lastAcceptedTs = 0;
      try {
        es = new EventSource(`${ntfyTopic(room)}/sse`);
        es.onmessage = async (e) => {
          try {
            const envelope = JSON.parse(e.data);
            if (envelope.event !== 'message' || !envelope.message) return;
            const payload = JSON.parse(envelope.message);
            if (!(await verifyPayload(publicKeyB64, payload))) return;
            if (payload.timestamp <= lastAcceptedTs) return;
            lastAcceptedTs = payload.timestamp;
            handle(payload);
          } catch { }
        };
      } catch { }
    }

    return () => {
      window.removeEventListener('storage', handleStorage);
      if (channel) channel.close();
      if (devInterval) clearInterval(devInterval);
      if (es) es.close();
    };
  }, [room, publicKeyB64]);
}
