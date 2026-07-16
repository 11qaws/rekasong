const MELOMING_BASE = 'https://openapi.meloming.com/v1';

function parseChannelIdentifier(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('멜로밍 채널 주소, 채널 경로 또는 숫자 ID를 입력해주세요.');

  if (/^\d+$/.test(raw)) {
    if (Number(raw) <= 0) throw new Error('멜로밍 채널 ID는 0보다 큰 숫자여야 합니다.');
    return raw;
  }

  const looksLikeMelomingUrl = /^(?:https?:\/\/)?(?:www\.)?meloming\.com(?:\/|$)/i.test(raw);
  if (looksLikeMelomingUrl) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new Error('멜로밍 채널 주소를 확인해주세요.');
    }

    if (!['meloming.com', 'www.meloming.com'].includes(url.hostname.toLowerCase())) {
      throw new Error('멜로밍 채널 주소만 사용할 수 있습니다.');
    }

    const path = url.pathname.match(/^\/channel\/([^/]+)\/?$/i);
    if (!path) throw new Error('멜로밍 채널 주소는 https://meloming.com/channel/채널경로 형식이어야 합니다.');

    try {
      const webPath = decodeURIComponent(path[1]).trim();
      if (webPath) return webPath;
    } catch {
      // Fall through to the same user-facing validation error.
    }
    throw new Error('멜로밍 채널 경로를 확인해주세요.');
  }

  const webPath = raw.replace(/^@/, '');
  if (!webPath || /[\s/\\?#]/.test(webPath) || webPath.length > 160) {
    throw new Error('채널 경로 또는 https://meloming.com/channel/채널경로 주소를 입력해주세요.');
  }
  return webPath;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function resolveChannel(identifier) {
  const response = await fetch(`${MELOMING_BASE}/channels/${encodeURIComponent(identifier)}`);
  const channel = await readJson(response);
  if (!response.ok) throw new Error(channel.message || `멜로밍 채널을 찾을 수 없습니다 (${response.status}).`);

  const channelId = Number(channel.id);
  if (!Number.isInteger(channelId) || channelId <= 0) throw new Error('멜로밍 채널 정보에 유효한 채널 ID가 없습니다.');

  return {
    id: channelId,
    name: String(channel.name || '').trim(),
    webPath: String(channel.webPath || identifier).trim(),
  };
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  let identifier;
  try {
    identifier = parseChannelIdentifier(requestUrl.searchParams.get('channel') || requestUrl.searchParams.get('channelId'));
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    // The public channel endpoint accepts either a numeric ID or the webPath
    // visible in https://meloming.com/channel/{webPath}. Resolve it once so
    // the songs endpoint always receives the canonical numeric channel ID.
    const channel = await resolveChannel(identifier);
    const channelId = channel.id;
    const firstResponse = await fetch(`${MELOMING_BASE}/channels/${channelId}/songs?page=1&limit=100&sortBy=title`);
    const firstData = await readJson(firstResponse);
    if (!firstResponse.ok) throw new Error(firstData.message || `멜로밍 채널을 읽을 수 없습니다 (${firstResponse.status}).`);

    const total = Number(firstData.total || firstData.songs?.length || 0);
    const totalPages = Math.min(Math.ceil(total / 100), 100);
    const pages = [firstData];
    for (let page = 2; page <= totalPages; page += 1) {
      const response = await fetch(`${MELOMING_BASE}/channels/${channelId}/songs?page=${page}&limit=100&sortBy=title`);
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.message || `멜로밍 곡 목록을 읽을 수 없습니다 (${response.status}).`);
      pages.push(data);
    }

    const songs = pages.flatMap((page) => page.songs || []).map((song) => ({
      id: `meloming-${song.id}`,
      title: String(song.title || '').trim(),
      artist: String(song.artist?.name || song.artistName || '').trim(),
      tags: [
        ...(song.categories || []).map((category) => category.name),
      ].filter(Boolean),
      youtubeUrl: String(song.karaokeUrl || '').trim(),
      sourceId: song.id,
      difficulty: song.difficulty || null,
      proficiency: song.proficiency || null,
      mrVerified: false,
      source: 'meloming',
    })).filter((song) => song.title);

    return new Response(JSON.stringify({
      source: {
        channelId,
        name: channel.name || firstData.songs?.[0]?.channel?.name || `Meloming ${channelId}`,
        webPath: channel.webPath,
        url: `https://meloming.com/channel/${encodeURIComponent(channel.webPath)}`,
      },
      songs,
      fetchedAt: new Date().toISOString(),
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || '멜로밍 목록을 가져오지 못했습니다.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
