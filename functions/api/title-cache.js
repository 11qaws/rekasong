const CACHE_VERSION = 'v1';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 180;

export const titleCacheKey = (kind, id) => `${CACHE_VERSION}:${kind}:${encodeURIComponent(String(id || '').trim())}`;

export async function getCachedTitle(env, kind, id) {
  if (!env?.TITLE_CACHE || !id) return null;
  try {
    const value = await env.TITLE_CACHE.get(titleCacheKey(kind, id), { type: 'json' });
    return value?.title ? value : null;
  } catch {
    return null;
  }
}

export async function putCachedTitle(env, kind, id, title, extra = {}) {
  if (!env?.TITLE_CACHE || !id || !String(title || '').trim()) return;
  try {
    await env.TITLE_CACHE.put(titleCacheKey(kind, id), JSON.stringify({
      title: String(title).trim(),
      updatedAt: Date.now(),
      ...extra
    }), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // Cache availability must never prevent a title from being used.
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const kind = url.searchParams.get('kind') || '';
    const ids = [...new Set([
      ...url.searchParams.getAll('id'),
      ...(url.searchParams.get('ids') || '').split(',')
    ].map((id) => id.trim()).filter(Boolean))].slice(0, 100);
    if (ids.length > 1) {
      const pairs = await Promise.all(ids.map(async (id) => [id, await getCachedTitle(env, kind, id)]));
      const entries = Object.fromEntries(pairs.filter(([, cached]) => cached));
      return new Response(JSON.stringify({ entries }), { headers: { 'Content-Type': 'application/json' } });
    }
    const id = ids[0] || '';
    const cached = await getCachedTitle(env, kind, id);
    return new Response(JSON.stringify({ cached }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const body = await request.json();
    const title = String(body.title || '').trim();
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!title || entries.length === 0) {
      return new Response(JSON.stringify({ error: 'title and cache entries are required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    await Promise.all(entries.map((entry) => putCachedTitle(env, entry.kind, entry.id, title, {
      source: entry.source || 'streamer-confirmed',
      mrId: entry.mrId || null,
      songbookId: entry.songbookId || null
    })));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid cache request' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
}
