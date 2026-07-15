const configuredBase = String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');

// GitHub Pages is static, so production API requests use the Cloudflare Pages
// Functions deployment. Local development keeps relative /api requests.
export const API_BASE_URL = configuredBase || (import.meta.env.DEV ? '' : 'https://rekasong.pages.dev');

export function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}
