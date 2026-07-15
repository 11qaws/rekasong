const latestPayloads = new Map();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);

  if (request.method === 'POST') {
    try {
      const { room, payload } = await request.json();

      if (!room || !payload?.state || !payload.timestamp) {
        return json({ error: 'room and a timestamped payload are required' }, 400);
      }

      latestPayloads.set(room, payload);
      return json({ success: true });
    } catch {
      return json({ error: 'Invalid JSON payload' }, 400);
    }
  }

  if (request.method === 'GET') {
    const room = url.searchParams.get('room');

    if (!room) {
      return json({ error: 'room is required' }, 400);
    }

    return json(latestPayloads.get(room) || {});
  }

  return json({ error: 'Method not allowed' }, 405);
}
