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

export function normalizeSongTitle(value) {
  const rawTitle = String(value || '').replace(/\s+/g, ' ').trim();
  // Japanese MV uploads commonly use the dependable form: Artist MV「Song title」metadata.
  // Prefer that quoted title only when it immediately follows an MV marker, so quoted anime
  // names in ordinary video titles are not accidentally selected.
  const mvQuotedTitle = rawTitle.match(/(?:^|\s)(?:m\/?v|music\s*video)\s*[「『“"]([^」』”"]+)[」』”"]/i);
  const title = mvQuotedTitle?.[1] || rawTitle;

  return title
    .replace(/^\s*(?:【[^】]+】|\[[^\]]+\]|\([^)]*\))\s*/g, '')
    .replace(/^.*?\s+(?:m\/?v|music\s*video)\s*/i, '')
    .replace(/\[[^\]]*(off\s*vocal|instrumental|karaoke|カラオケ|노래방|카라오케|mr|inst)[^\]]*\]/gi, '')
    .replace(/\([^)]*(off\s*vocal|instrumental|karaoke|カラオケ|노래방|카라오케|mr|inst)[^)]*\)/gi, '')
    .replace(/\s*(?:[|\/·-]\s*)?(?:official\s*(?:video|audio)?|lyrics?|lyric\s*video|歌詞(?:あり)?|가사|자막|off\s*vocal|instrumental|karaoke|カラオケ|노래방|카라오케|금영(?:\s*노래방)?|mr|inst|ky|tj).*$/i, '')
    .replace(/\s*[-|/]\s*(?:[^-|/]+\s+)?(?:ost|op|ed)\b.*$/i, '')
    .replace(/^[「『“"]|[」』”"]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(value) {
  return normalizeSongTitle(value) || '제목을 직접 확인해 주세요';
}

function isUsableSongTitle(value) {
  const normalized = normalizeSongTitle(value)
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!normalized) return false;
  return !/^(?:unknown|untitled|n\/?a|none|null|알\s*수\s*없음|미상|제목\s*없음)$/i.test(normalized);
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
  const jsonText = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    const embeddedJson = jsonText.match(/\{[\s\S]*\}/)?.[0];
    if (!embeddedJson) return null;
    try {
      return JSON.parse(embeddedJson);
    } catch {
      return null;
    }
  }
}

function getModelTitle(result) {
  if (!result || typeof result !== 'object') return '';

  const preferredKeys = new Set([
    'canonical_song_title', 'canonicalsongtitle', 'canonical_title', 'canonicaltitle',
    'final_title', 'finaltitle', 'title', 'song_title', 'songtitle', 'track_title', 'tracktitle', 'name'
  ]);
  const queue = [result];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (preferredKeys.has(key.toLowerCase()) && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return '';
}

export async function extractSongTitle({ apiKey, prompt, fallbackTitle = '', audioBase64 = '', audioMimeType = 'audio/mp3' }) {
  if (isFallbackGeminiKey(apiKey)) {
    return { title: cleanTitle(fallbackTitle), mode: 'fallback' };
  }

  const input = audioBase64
    ? [
        { type: 'audio', data: audioBase64, mime_type: audioMimeType },
        { type: 'text', text: prompt }
      ]
    : prompt;

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
            canonical_song_title: {
              type: 'string',
              description: 'Canonical standalone composition title only. Exclude all source, performer, release, format, service, version, and work-context metadata.'
            }
          },
          required: ['canonical_song_title']
        }
      }
    })
  });

  const interaction = await response.json();
  if (!response.ok) {
    const details = interaction.error?.message || interaction.error?.status || JSON.stringify(interaction.error || {});
    throw new Error(`Gemini request failed (${response.status}): ${details}`);
  }
  const modelTitle = getModelTitle(parseJsonResponse(getInteractionText(interaction)));
  const useModelTitle = isUsableSongTitle(modelTitle);
  // A malformed structured response must not leave the streamer without a title.
  // The source title is still normalized by the same safety rules in that case.
  return {
    title: cleanTitle(useModelTitle ? modelTitle : fallbackTitle).replace(/^["']|["']$/g, ''),
    mode: useModelTitle ? 'ai' : 'rules'
  };
}
