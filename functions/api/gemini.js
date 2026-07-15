export const GEMINI_MODEL = 'gemini-3.5-flash';

const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const FALLBACK_KEY = '__rekasong_title_fallback__';

export function selectGeminiApiKey(env) {
  const apiKeys = [env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3].filter(Boolean);
  return apiKeys.length ? apiKeys[Math.floor(Math.random() * apiKeys.length)] : FALLBACK_KEY;
}

export function isFallbackGeminiKey(apiKey) {
  return apiKey === FALLBACK_KEY;
}

function cleanTitle(value) {
  const rawTitle = String(value || '').replace(/\s+/g, ' ').trim();
  // Japanese MV uploads commonly use the dependable form: Artist MV「Song title」metadata.
  // Prefer that quoted title only when it immediately follows an MV marker, so quoted anime
  // names in ordinary video titles are not accidentally selected.
  const mvQuotedTitle = rawTitle.match(/(?:^|\s)(?:m\/?v|music\s*video)\s*[「『“"]([^」』”"]+)[」』”"]/i);
  const title = mvQuotedTitle?.[1] || rawTitle;

  return title
    .replace(/^\s*(?:【[^】]+】|\[[^\]]+\]|\([^)]*\))\s*/g, '')
    .replace(/^.*?\s+(?:m\/?v|music\s*video)\s*/i, '')
    .replace(/\[[^\]]*(off\s*vocal|instrumental|karaoke|mr|inst)[^\]]*\]/gi, '')
    .replace(/\([^)]*(off\s*vocal|instrumental|karaoke|mr|inst)[^)]*\)/gi, '')
    .replace(/\s*(?:[|\/-]\s*)?(?:official\s*(?:video|audio)?|lyrics?|lyric\s*video|歌詞(?:あり)?|가사|자막|off\s*vocal|instrumental|karaoke|mr|inst|ky|tj).*$/i, '')
    .replace(/\s*[-|/]\s*(?:[^-|/]+\s+)?(?:ost|op|ed)\b.*$/i, '')
    .replace(/^[「『“"]|[」』”"]$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '제목을 직접 확인해 주세요';
}

function getGeneratedText(data) {
  const text = (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .filter((part) => part.text)
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

function parseJsonResponse(text) {
  const jsonText = text.replace(/^```json\s*|\s*```$/g, '').trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('Gemini returned an invalid JSON response');
  }
}

export async function extractSongTitle({ apiKey, prompt, fallbackTitle = '', audioBase64 = '', audioMimeType = 'audio/mp3' }) {
  if (isFallbackGeminiKey(apiKey)) {
    return cleanTitle(fallbackTitle);
  }

  const parts = [{ text: prompt }];
  if (audioBase64) parts.push({ inlineData: { data: audioBase64, mimeType: audioMimeType } });

  const response = await fetch(GEMINI_GENERATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: { final_title: { type: 'string' } },
          required: ['final_title']
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Failed to fetch from Gemini');
  const result = parseJsonResponse(getGeneratedText(data));
  const title = typeof result.final_title === 'string' ? result.final_title.trim() : '';
  if (!title) throw new Error('Gemini did not return a final_title');
  return title.replace(/^["']|["']$/g, '');
}
