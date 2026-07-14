export async function onRequest(context) {
  const { request, env } = context;

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
      if (request.method !== 'POST') {
        throw new Error('POST method required');
      }

      await sendEvent("파일 정보 추출 중...");

      const body = await request.json();
      const { filename = '', metadata = {}, audioBase64 = '' } = body;

      const apiKeys = [env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3].filter(Boolean);
      if (apiKeys.length === 0) throw new Error('Missing GEMINI_API_KEY environment variable');
      const apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];

      await sendEvent("AI가 음원과 메타데이터를 분석 중...");

      const prompt = `너는 버튜버(VTuber) 스트리머의 노래방 방송을 돕는 일류 비서이자 서브컬처 음악 전문가야.
너는 기본적으로 애니메송, OST, 보컬로이드(Vocaloid), J-POP, 우타이테, 동인 음악 등 '서브컬처 노래'에 대한 매우 강한 편향(Bias)과 깊은 지식을 가지고 있어. 제목이 모호한 상황이라면 서브컬처 곡을 최우선으로 가정하고 분석해.

[입력 데이터]
- 파일명: "${filename}"
- ID3 태그 메타데이터: ${JSON.stringify(metadata)}
- 첨부된 오디오(도입부 일부)

[중요 힌트]
이 오디오는 스트리머가 부르기 위해 준비한 **보컬이 없는 노래방 반주(MR/Instrumental) 파일**일 확률이 99%야.
목소리가 없더라도 당황하지 말고, 반주의 멜로디와 분위기를 파악해. 그리고 제공된 파일명과 메타데이터 텍스트를 주요 단서로 삼아.

다음 절차에 따라 엄격하게 분석해:
1. 입력된 정보(텍스트 + 오디오 멜로디)를 종합하여 곡을 추론해.
2. 【歌ってみた】, Cover, 커버, MV, M/V, 오리지널 곡, Official, inst, instrumental, MR 등 곡의 본질(Title)과 상관없는 접두사, 접미사, 확장자는 **무조건 완벽하게 제거**해!
3. 잘 모르겠거나 애매한 정보가 있다면 구글 검색(Google Search)을 적극 활용해 실제 공식 곡명이 무엇인지 찾아봐.
4. 아티스트명(우타이테, 버튜버 이름 포함), 피처링, 부가설명은 결과에서 반드시 제외해.
5. 원본 곡명이 일본어(한자/히라가나/가타카나)인 경우, **원본 일본어를 완전히 지우고 한국 팬덤에서 가장 널리 쓰이는 한국어 번역명(또는 한국어 발음)으로만 100% 대체해.** 일본어는 1글자도 남기지 마. (예: 可愛くてごめん -> 귀여워서 미안해)
6. 분석 과정을 'analysis' 필드에 상세히 작성하고, 위 규칙들이 모두 적용된 최종 추출 곡명을 'final_title' 필드에 작성해.

반드시 아래 JSON 형식으로만 응답해:
{
  "analysis": "어떤 부분이 단서인지, 구글 검색 결과는 무엇인지, 멜로디는 어떠한지 논리적 추론 과정",
  "final_title": "최종 추출된 순수 곡명 단 하나"
}`;

      const contentsParts = [{ text: prompt }];

      if (audioBase64) {
        contentsParts.push({
          inline_data: {
            mime_type: "audio/mp3",
            data: audioBase64
          }
        });
      }

      await sendEvent("한국어 번역명 매칭 중...");

      const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: contentsParts
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
