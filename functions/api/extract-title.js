export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');

  // SSE 설정을 위한 스트림 생성
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (status, title = null, error = null) => {
    const payload = JSON.stringify({ status, title, error });
    await writer.write(encoder.encode(`data: ${payload}\n\n`));
  };

  context.waitUntil((async () => {
    try {
      if (!videoId) throw new Error('Missing "id" parameter');

      await sendEvent("유튜브 영상 정보 분석 중...");
      
      const apiKeys = [env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3].filter(Boolean);
      if (apiKeys.length === 0) throw new Error('Missing GEMINI_API_KEY environment variable');
      const apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];

      let ytTitle = '';
      let ytDescription = '';
      let ytAuthor = '';

      try {
        const ytRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = await ytRes.text();

        const titleMatch = html.match(/<meta name="title" content="([^"]+)">/i);
        const descMatch = html.match(/<meta name="description" content="([^"]+)">/i);
        const authorMatch = html.match(/<link itemprop="name" content="([^"]+)">/i);

        ytTitle = titleMatch ? titleMatch[1] : '';
        ytDescription = descMatch ? descMatch[1] : '';
        ytAuthor = authorMatch ? authorMatch[1] : '';
      } catch (err) {
        console.error('Failed to fetch YouTube page', err);
      }

      await sendEvent("원본 제목 및 공식명 찾는 중...");

      const prompt = `너는 버튜버(VTuber) 스트리머의 노래방 방송을 돕는 일류 비서이자 서브컬처 음악 전문가야.
너는 기본적으로 애니메송, OST, 보컬로이드(Vocaloid), J-POP, 우타이테, 동인 음악 등 '서브컬처 노래'에 대한 매우 강한 편향(Bias)과 깊은 지식을 가지고 있어. 제목이 모호한 상황이라면 서브컬처 곡을 최우선으로 가정하고 분석해.

[입력 데이터]
- 채널명(Author): "${ytAuthor}"
- 영상 제목(Title): "${ytTitle}"
- 영상 설명(Description): "${ytDescription.slice(0, 500)}"

다음 절차에 따라 엄격하게 분석해:
1. 입력된 정보에서 '원본 곡명', '아티스트명/채널명', '피처링', '기타 부가설명'을 논리적으로 식별해.
2. 【歌ってみた】, Cover, 커버, MV, M/V, 오리지널 곡, Official 등 곡의 본질(Title)과 상관없는 접두사, 접미사, 괄호 말머리는 **무조건 완벽하게 제거**해! (예: 【歌ってみた】可愛くてごめん -> 可愛くてごめん)
3. 잘 모르겠거나 애매한 정보가 있다면 구글 검색(Google Search)을 적극 활용해 실제 공식 곡명이 무엇인지 찾아봐.
4. 아티스트명(우타이테, 버튜버 이름 포함), 피처링, 부가설명은 결과에서 반드시 제외해.
5. 원본 곡명이 일본어(한자/히라가나/가타카나)인 경우, **원본 일본어를 완전히 지우고 한국 팬덤에서 가장 널리 쓰이는 한국어 번역명(또는 한국어 발음)으로만 100% 대체해.** 일본어는 1글자도 남기지 마. (예: 可愛くてごめん -> 귀여워서 미안해)
6. 분석 과정을 'analysis' 필드에 상세히 작성하고, 위 규칙들이 모두 적용된 최종 추출 곡명을 'final_title' 필드에 작성해.

반드시 아래 JSON 형식으로만 응답해:
{
  "analysis": "어떤 부분이 아티스트이고 제목인지, 구글 검색 결과는 무엇인지 등 논리적 추론 과정",
  "final_title": "최종 추출된 순수 곡명 단 하나"
}`;

      await sendEvent("한국어 번역명 찾는 중...");

      const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          tools: [{
            googleSearch: {}
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        })
      });

      const data = await aiResponse.json();
      
      if (!aiResponse.ok) {
        throw new Error(data.error?.message || 'Failed to fetch from Gemini');
      }

      const jsonString = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!jsonString) {
        throw new Error('Empty response from AI');
      }

      let parsedData;
      try {
        parsedData = JSON.parse(jsonString);
      } catch (parseError) {
        throw new Error(`JSON 파싱 실패. 원본 응답: ${jsonString}`);
      }
      const extractedTitle = parsedData.final_title || '';

      await sendEvent("완료", extractedTitle.replace(/^["']|["']$/g, ''));

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
      'Connection': 'keep-alive'
    }
  });
}
