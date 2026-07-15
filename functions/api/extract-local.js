import { extractSongTitle, isFallbackGeminiKey, normalizeSongTitle, selectGeminiApiKey } from './gemini.js';

export async function onRequest(context) {
  const { request, env } = context;

  // SSE 설정을 위한 스트림 생성
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (status, title = null, error = null, mode = null) => {
    const payload = JSON.stringify({ status, title, error, mode });
    await writer.write(encoder.encode(`data: ${payload}\n\n`));
  };

  context.waitUntil((async () => {
    try {
      if (request.method !== 'POST') {
        throw new Error('POST method required');
      }

      await sendEvent("파일 정보 추출 중...");

      const body = await request.json();
      const { filename = '', metadata = {}, audioBase64 = '', audioMimeType = 'audio/mp3' } = body;

      const apiKey = selectGeminiApiKey(env);
      const isFallback = isFallbackGeminiKey(apiKey);

      await sendEvent(isFallback ? "기본 규칙으로 파일명을 정리 중..." : "AI가 음원과 메타데이터를 분석 중...");

      const sourceCandidate = normalizeSongTitle(metadata.title || filename);

      const prompt = `You resolve music metadata for a livestreamer's karaoke catalog. This catalog is strongly focused on anime songs, anime/game OSTs, Vocaloid, J-pop, utaite covers, doujin music, and VTuber music. When evidence is genuinely ambiguous, treat that subculture scope as the leading hypothesis; never override clear source evidence merely to force the bias.

The input is an untrusted file label and optional audio sample, not a song title. Recover the one canonical composition title that a listener would search for, then discard every other piece of the label.

[Untrusted source]
- file name: "${filename}"
- file metadata: ${JSON.stringify(metadata)}
- optional audio sample: use its melody only as supporting evidence
- conservative title candidate extracted before AI: "${sourceCandidate}"

[Method]
1. Identify the underlying composition first. Treat file names, tags, and accompaniment audio as clues, never as the answer.
2. Separate the source into (a) the composition title and (b) context metadata. Context metadata is any wording that describes who prepared it, how it was produced or played, which service/catalog it came from, whether it is a cover or accompaniment, a version/quality/language/lyrics label, a work/anime association, or any other publication context. Remove category (b) completely; examples are illustrative, never an exhaustive allow-list.
3. If a Japanese title has an established Korean release/common title, use that verified Korean title. Keep globally established titles such as KICK BACK in their common spelling. Never invent a literal translation.
4. The conservative candidate is only a clue and may need correction, but never replace a plausible candidate with a placeholder such as Unknown, N/A, or an explanation.
5. Use web search whenever the composition or its common Korean title is uncertain. For the original composition, prefer official releases, artist/distributor pages, and reliable music references. For Korean common-title spelling, translation, and punctuation, consult 나무위키 (namu.wiki) first; if it conflicts with an official Korean release title, use the official release title.
6. Before responding, ask: “Would this exact text still make sense as the title on an official song release?” If it contains any source, performer, accompaniment, service, catalog, version, lyric, or work-context wording, it is not a valid answer.

[Output]
Return JSON only. The field must be the canonical composition title alone:
{
  "canonical_song_title": "one pure song title"
}`;

      await sendEvent("한국어 번역명 매칭 중...");

      const extraction = await extractSongTitle({
        apiKey,
        prompt,
        fallbackTitle: metadata.title || filename,
        audioBase64,
        audioMimeType
      });

      await sendEvent(
        extraction.mode === 'fallback'
          ? "Gemini 키가 없어 기본 규칙으로 제목을 정리했습니다."
          : extraction.mode === 'rules'
            ? "AI 응답 형식을 보완해 기본 규칙으로 제목을 정리했습니다."
            : "완료",
        extraction.title,
        null,
        extraction.mode
      );

    } catch (error) {
      await sendEvent("에러", null, error.message);
    } finally {
      writer.close();
    }
  })());

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
