function parsePlaylistId(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(parsed.hostname)) {
    throw new Error('YouTube 플레이리스트 URL만 가져올 수 있습니다.');
  }
  const id = parsed.searchParams.get('list');
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('YouTube 플레이리스트 ID를 찾을 수 없습니다.');
  return id;
}

function textValue(value) {
  if (!value) return '';
  if (value.simpleText) return value.simpleText;
  return (value.runs || []).map((run) => run.text || '').join('');
}

function collectVideos(node, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (node.videoRenderer?.videoId) {
    const video = node.videoRenderer;
    output.push({
      id: `youtube-playlist-${video.videoId}`,
      title: textValue(video.title),
      artist: textValue(video.shortBylineText || video.ownerText),
      youtubeUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      sourceId: video.videoId,
      source: 'youtube-playlist',
      mrVerified: false,
    });
  }
  Object.values(node).forEach((child) => collectVideos(child, output));
  return output;
}

function findPlaylistRenderer(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.playlistVideoListRenderer) return node.playlistVideoListRenderer;
  for (const child of Object.values(node)) {
    const found = findPlaylistRenderer(child);
    if (found) return found;
  }
  return null;
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const sourceUrl = requestUrl.searchParams.get('url');
  if (!sourceUrl) return new Response(JSON.stringify({ error: 'url 파라미터가 필요합니다.' }), { status: 400 });

  try {
    const playlistId = parsePlaylistId(sourceUrl);
    const response = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8' },
    });
    if (!response.ok) throw new Error(`YouTube 플레이리스트를 읽을 수 없습니다 (${response.status}).`);
    const html = await response.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (!match) throw new Error('플레이리스트가 비공개이거나 목록을 읽을 수 없습니다.');
    const initialData = JSON.parse(match[1]);
    const playlistRenderer = findPlaylistRenderer(initialData);
    if (!playlistRenderer) throw new Error('플레이리스트가 비공개이거나 목록을 읽을 수 없습니다.');
    const allSongs = collectVideos(playlistRenderer);
    const songs = allSongs.filter((song, index, list) => list.findIndex((item) => item.sourceId === song.sourceId) === index).slice(0, 500);
    if (!songs.length) throw new Error('플레이리스트에 가져올 수 있는 영상이 없습니다.');

    return new Response(JSON.stringify({
      source: { id: playlistId, url: `https://www.youtube.com/playlist?list=${playlistId}`, name: `YouTube 플레이리스트 (${songs.length}개)` },
      songs,
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'YouTube 플레이리스트를 가져오지 못했습니다.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
