const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/regal-muse-384522/databases/(default)/documents';

function readFirestoreValue(value) {
  if (!value) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, 'referenceValue')) return value.referenceValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(readFirestoreValue);
  if (value.mapValue) return Object.fromEntries(
    Object.entries(value.mapValue.fields || {}).map(([key, nested]) => [key, readFirestoreValue(nested)]),
  );
  return null;
}

function readFirestoreDocument(document) {
  return Object.fromEntries(
    Object.entries(document?.fields || {}).map(([key, value]) => [key, readFirestoreValue(value)]),
  );
}

async function getFirestoreDocument(path) {
  const response = await fetch(`${FIRESTORE_BASE}/${path}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Setlink 공개 데이터를 읽을 수 없습니다 (${response.status}).`);
  return response.json();
}

async function getSongs(userId) {
  const songs = [];
  let pageToken = '';

  // A public Setlink list is normally well below this limit. The page token
  // loop keeps larger catalogues usable without allowing unbounded reads.
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`${FIRESTORE_BASE}/users/${encodeURIComponent(userId)}/Songs?${params}`);
    if (!response.ok) throw new Error(`Setlink 곡 목록을 읽을 수 없습니다 (${response.status}).`);
    const data = await response.json();
    songs.push(...(data.documents || []).map(readFirestoreDocument));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return songs;
}

function includesText(song, query) {
  const text = [song.title, song.artist, song.genre, song.note, song.memo, ...(song.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
  return text.includes(query.toLocaleLowerCase());
}

function splitCriteria(value) {
  return String(value || '').split(',').map((item) => item.trim().toLocaleLowerCase()).filter(Boolean);
}

function applyPublicCriteria(songs, criteria = {}) {
  const freeKeyword = String(criteria.freeKeyword || '').trim();
  const artist = String(criteria.artist || '').trim().toLocaleLowerCase();
  const genre = String(criteria.genre || '').trim().toLocaleLowerCase();
  const tag = String(criteria.tag || '').trim().toLocaleLowerCase();
  const excludedTags = splitCriteria(criteria.excludedTags);
  const excludedGenres = splitCriteria(criteria.excludedGenres);
  const skillLevel = Number(criteria.skillLevel || 0);
  const maxSung = Number(criteria.maxSung || 0);

  return songs.filter((song) => {
    const songArtist = String(song.artist || '').toLocaleLowerCase();
    const songGenre = String(song.genre || '').toLocaleLowerCase();
    const songTags = (song.tags || []).map((item) => String(item).toLocaleLowerCase());
    if (freeKeyword && !includesText(song, freeKeyword)) return false;
    if (artist && !songArtist.includes(artist)) return false;
    if (genre && songGenre !== genre) return false;
    if (tag && !songTags.includes(tag)) return false;
    if (excludedTags.some((item) => songTags.includes(item))) return false;
    if (excludedGenres.includes(songGenre)) return false;

    if (skillLevel > 0) {
      const value = Number(song.skillLevel || 0);
      if (criteria.skillLevelOption === '以上' && value < skillLevel) return false;
      if (criteria.skillLevelOption !== '以上' && value > skillLevel) return false;
    }
    if (maxSung > 0) {
      const value = Number(song.singingCount || 0);
      if (criteria.maxSungOption === '以上' && value < maxSung) return false;
      if (criteria.maxSungOption !== '以上' && value > maxSung) return false;
    }
    return true;
  });
}

function parsePublicUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'setlink.jp') {
    throw new Error('https://setlink.jp 공개 URL만 가져올 수 있습니다.');
  }
  const match = parsed.pathname.match(/^\/(?:public|p)\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) throw new Error('Setlink 공개 페이지 URL 형식이 아닙니다.');
  return match[1];
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const sourceUrl = url.searchParams.get('url');
  if (!sourceUrl) return new Response(JSON.stringify({ error: 'url 파라미터가 필요합니다.' }), { status: 400 });

  try {
    const publicId = parsePublicUrl(sourceUrl);
    const publicDocument = await getFirestoreDocument(`publicPages/${publicId}`);
    if (!publicDocument) return new Response(JSON.stringify({ error: '공개 Setlink 페이지를 찾을 수 없습니다.' }), { status: 404 });

    const publicData = readFirestoreDocument(publicDocument);
    if (!publicData.userId) throw new Error('공개 페이지 소유자 정보를 찾을 수 없습니다.');
    const settingsDocument = await getFirestoreDocument(
      `users/${encodeURIComponent(publicData.userId)}/publicPages/${publicId}`,
    );
    const settings = readFirestoreDocument(settingsDocument || {});
    const allSongs = await getSongs(publicData.userId);
    const songs = applyPublicCriteria(allSongs, settings.searchCriteria).map((song, index) => ({
      id: song.id || `${publicId}-${index}`,
      title: String(song.title || '').trim(),
      artist: String(song.artist || '').trim(),
      tags: Array.isArray(song.tags) ? song.tags.filter(Boolean) : [],
      genre: String(song.genre || '').trim(),
      youtubeUrl: String(song.youtubeUrl || '').trim(),
      note: String(song.note || '').trim(),
      memo: String(song.memo || '').trim(),
      skillLevel: Number(song.skillLevel || 0),
      updatedAt: song.updatedAt || null,
    })).filter((song) => song.title);

    return new Response(JSON.stringify({
      source: {
        id: publicId,
        url: `https://setlink.jp/public/${publicId}`,
        name: String(settings.name || publicData.name || 'Setlink 공개 목록'),
        description: String(settings.description || ''),
        updatedAt: settings.updatedAt || publicData.updatedAt || null,
      },
      songs,
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Setlink 목록을 가져오지 못했습니다.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
