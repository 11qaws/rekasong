const MELOMING_BASE = 'https://openapi.meloming.com/v1';

function parseChannelId(value) {
  const id = String(value || '').trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) throw new Error('멜로밍 채널 ID는 숫자로 입력해주세요.');
  return id;
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  let channelId;
  try {
    channelId = parseChannelId(requestUrl.searchParams.get('channelId'));
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    const firstResponse = await fetch(`${MELOMING_BASE}/channels/${channelId}/songs?page=1&limit=100&sortBy=title`);
    const firstData = await firstResponse.json();
    if (!firstResponse.ok) throw new Error(firstData.message || `멜로밍 채널을 읽을 수 없습니다 (${firstResponse.status}).`);

    const total = Number(firstData.total || firstData.songs?.length || 0);
    const totalPages = Math.min(Math.ceil(total / 100), 100);
    const pages = [firstData];
    for (let page = 2; page <= totalPages; page += 1) {
      const response = await fetch(`${MELOMING_BASE}/channels/${channelId}/songs?page=${page}&limit=100&sortBy=title`);
      const data = await response.json();
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
      source: { channelId: Number(channelId), name: firstData.songs?.[0]?.channel?.name || `Meloming ${channelId}` },
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
