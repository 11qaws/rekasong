export const GEMINI_MODEL = 'gemini-3.5-flash';

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export function selectGeminiApiKey(env) {
  const apiKeys = [env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3].filter(Boolean);

  if (apiKeys.length === 0) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }

  return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

function getInteractionText(interaction) {
  const text = (interaction.steps || [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content || [])
    .filter((content) => content.type === 'text' && content.text)
    .map((content) => content.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Empty response from Gemini');
  }

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

export async function extractSongTitle({ apiKey, prompt, audioBase64 = '', audioMimeType = 'audio/mp3' }) {
  const input = [{ type: 'text', text: prompt }];

  if (audioBase64) {
    input.push({ type: 'audio', data: audioBase64, mime_type: audioMimeType });
  }

  const response = await fetch(GEMINI_INTERACTIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      'Api-Revision': '2026-05-20'
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
            final_title: { type: 'string' }
          },
          required: ['final_title']
        }
      }
    })
  });

  const interaction = await response.json();

  if (!response.ok) {
    throw new Error(interaction.error?.message || 'Failed to fetch from Gemini');
  }

  const result = parseJsonResponse(getInteractionText(interaction));
  const title = typeof result.final_title === 'string' ? result.final_title.trim() : '';

  if (!title) {
    throw new Error('Gemini did not return a final_title');
  }

  return title.replace(/^["']|["']$/g, '');
}
