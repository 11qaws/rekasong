import { extractSongTitle, selectGeminiApiKey } from './gemini.js';

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
      
      let apiKey = null;
      try {
        apiKey = selectGeminiApiKey(env);
      } catch {
        // Without a Gemini secret, use deterministic title cleanup below.
      }

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
2. 【歌ってみた】, Cover, 커버, MV, M/V, 오리지널 곡, Official, inst, instrumental, MR, off vocal, 노래방 등 곡의 본질(Title)과 상관없는 접두사, 접미사, 괄호 말머리는 **무조건 완벽하게 제거**해! (예: 【歌ってみた】可愛くてごめん (Instrumental) -> 可愛くてごめん)
3. 곡명 외의 모든 부가 정보(애니메이션 이름, 오프닝/엔딩 표기, 노래방 번호, KY KARAOKE, TJ 등)를 완벽하게 제거해. (예: 아이돌 "【최애의 아이】" - 요아소비 (KY.44923) / KY KARAOKE -> 아이돌)
4. 아티스트명(우타이테, 버튜버 이름 포함), 피처링, 부가설명은 결과에서 반드시 제외해.
5. 원본 곡명이 일본어(한자/히라가나/가타카나)인 경우, 원본 일본어를 완전히 지우고 한국 팬덤에서 가장 널리 쓰이는 한국어 정식 발매명(또는 통용 번역명)으로 100% 대체해. (예: 可愛くてごめん -> 귀여워서 미안해)
6. **[검색 조건(환각 방지)]** 인공지능인 너는 곡명을 안다고 착각하여 임의로 직역해버리는 치명적인 버그가 있어. 네 지식을 절대 맹신하지 마! 아래 객관적 기준 중 하나라도 해당하면 **무조건 구글(나무위키) 검색을 실행**해서 팩트체크해:
   - 제목이 일반 명사나 문장형이라 직역될 위험이 있는 경우 (예: 小さきもの -> 작은 것(X) 작은 존재(O))
   - 원어 발음 그대로 읽지 않고 의미를 번역해야 하는 모든 일본어 곡
   - 띄어쓰기나 부제 등 한국 팬덤 내 정확한 통용 표기법에 대해 0.1%라도 확신이 없는 경우
   (단, '아이돌(アイドル)', 'KICK BACK'처럼 번역이 필요 없거나 원어 발음 그대로 한국에서도 쓰이는 초유명 곡은 검색 생략 가능)
7. 추론 과정, 출처, 부연 설명은 응답에 포함하지 말고 최종 곡명만 작성해.

반드시 아래 JSON 형식으로만 응답해:
{
  "final_title": "최종 추출된 순수 곡명 단 하나"
}`;

      await sendEvent("한국어 번역명 찾는 중...");

      const extractedTitle = await extractSongTitle({ apiKey, prompt });

      await sendEvent("완료", extractedTitle);

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
