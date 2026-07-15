export const GEMINI_MODEL = 'gemini-3-flash-preview';

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
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

function getInteractionText(interaction) {
  const text = (interaction.steps || [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content || [])
    .filter((content) => content.type === 'text' && content.text)
    .map((content) => content.text)
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

  const input = [{ type: 'text', text: prompt }];
  if (audioBase64) input.push({ type: 'audio', data: audioBase64, mime_type: audioMimeType });

  const response = await fetch(GEMINI_INTERACTIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input,
      tools: [{ type: 'google_search' }],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: {
          type: 'object',
          properties: {
            final_title: {
              type: 'string',
              description: 'Artist, channel, MV, version, work title, and karaoke metadata removed; Korean common title only.'
            }
          },
          required: ['final_title']
        }
      }
    })
  });

  const interaction = await response.json();
  if (!response.ok) {
    const details = interaction.error?.message || interaction.error?.status || JSON.stringify(interaction.error || {});
    throw new Error(`Gemini request failed (${response.status}): ${details}`);
  }
  const result = parseJsonResponse(getInteractionText(interaction));
  const title = typeof result.final_title === 'string' ? result.final_title.trim() : '';
  if (!title) throw new Error('Gemini did not return a final_title');
  return title.replace(/^["']|["']$/g, '');
}
