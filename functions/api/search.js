export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  
  if (!q) {
    return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), { status: 400 });
  }

  // Inject MR / Karaoke keywords for better search results
  const searchString = `${q} (tj OR 금영 OR ky OR mr OR inst OR 노래방)`;
  const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchString)}`;

  try {
    const res = await fetch(ytUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    
    if (!res.ok) throw new Error(`Failed to fetch from YouTube (Status: ${res.status})`);
    
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*});<\/script>/);
    
    if (!match) {
      return new Response(JSON.stringify({ error: 'ytInitialData not found' }), { status: 500 });
    }

    const json = JSON.parse(match[1]);
    const contents = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    if (!contents) {
      return new Response(JSON.stringify({ error: 'Could not parse search results' }), { status: 500 });
    }

    let videos = [];
    for (const section of contents) {
      if (section.itemSectionRenderer?.contents) {
        const items = section.itemSectionRenderer.contents;
        const vids = items.filter(c => c.videoRenderer).map(c => {
          const v = c.videoRenderer;
          return {
            id: v.videoId,
            title: v.title.runs[0].text,
            thumbnail: v.thumbnail.thumbnails.length > 0 ? v.thumbnail.thumbnails[0].url : '',
            durationText: v.lengthText?.simpleText || '',
            channelTitle: v.ownerText?.runs[0]?.text || ''
          };
        });
        videos = videos.concat(vids);
      }
    }

    return new Response(JSON.stringify(videos.slice(0, 10)), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
