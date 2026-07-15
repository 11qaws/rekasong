const CACHE_VERSION = 'v1';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 180;
const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

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

export async function putCachedTitle(env, kind, id, title, extra = {}, { persistent = false } = {}) {
  if (!env?.TITLE_CACHE || !id || !String(title || '').trim()) return;
  try {
    await env.TITLE_CACHE.put(titleCacheKey(kind, id), JSON.stringify({
      title: String(title).trim(),
      updatedAt: Date.now(),
      ...extra
    }), persistent ? {} : { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // Cache availability must never prevent a title from being used.
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
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
      return json({ entries });
    }
    const id = ids[0] || '';
    const cached = await getCachedTitle(env, kind, id);
    return json({ cached });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await request.json();
    if (body.operation === 'lookup') {
      const kind = String(body.kind || '').trim();
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean))].slice(0, 100);
      const pairs = await Promise.all(ids.map(async (id) => [id, await getCachedTitle(env, kind, id)]));
      const entries = Object.fromEntries(pairs.filter(([, cached]) => cached));
      return json({ entries });
    }

    const title = String(body.title || '').trim();
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!title || entries.length === 0) {
      return json({ error: 'title and cache entries are required' }, 400);
    }

    await Promise.all(entries.map((entry) => putCachedTitle(env, entry.kind, entry.id, title, {
      source: entry.source || 'streamer-confirmed',
      mrId: entry.mrId || null,
      mrKind: entry.mrKind || null,
      songbookId: entry.songbookId || null,
      verifiedAt: entry.persistent && entry.mrId ? Date.now() : null
    }, { persistent: Boolean(entry.persistent) })));
    return json({ ok: true });
  } catch {
    return json({ error: 'Invalid cache request' }, 400);
  }
}
