#!/usr/bin/env node

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { extractNamuWikiLyricsBlocks } from '../functions/api/lyrics-search.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 47_653;
const MAX_REQUEST_BYTES = 4_096;
const MAX_SOURCE_BYTES = 2_000_000;

const json = (response, status, body, origin = '') => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  }
  response.end(JSON.stringify(body));
};

const allowedOrigin = (value) => {
  let origin;
  try { origin = new URL(String(value || '')); } catch { return false; }
  if (origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)) return true;
  if (origin.protocol !== 'https:') return false;
  return origin.hostname === '11qaws.github.io'
    || origin.hostname === 'rekasong.pages.dev'
    || origin.hostname.endsWith('.rekasong.pages.dev');
};

const safeNamuUrl = (value) => {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'namu.wiki'
    || !url.pathname.startsWith('/w/') || url.username || url.password) return null;
  url.hash = '';
  return url;
};

const readJson = async (request) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const readBoundedText = async (response, controller) => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) return '';
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) {
      controller.abort();
      return '';
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export async function fetchNamuWikiPage(value, fetchImpl = globalThis.fetch) {
  let url = safeNamuUrl(value);
  if (!url || typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!url) return null;
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Rekasong/0.2 (+https://github.com/11qaws/rekasong)',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        url = location ? safeNamuUrl(new URL(location, url).toString()) : null;
        continue;
      }
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !/^text\/html(?:;|$)/iu.test(contentType)) return null;
      const html = await readBoundedText(response, controller);
      const blocks = extractNamuWikiLyricsBlocks(html);
      if (!blocks.length) return null;
      url.search = '';
      return Object.freeze({
        schemaVersion: 1,
        sourceTitle: `${decodeURIComponent(url.pathname.slice(3))} - NamuWiki`.slice(0, 240),
        sourceUrl: url.toString(),
        blocks,
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function createNamuWikiLyricsHelperServer({ fetchImpl = globalThis.fetch } = {}) {
  return http.createServer(async (request, response) => {
    const origin = String(request.headers.origin || '');
    const browserOriginAllowed = allowedOrigin(origin);
    if (request.method === 'OPTIONS') {
      if (!browserOriginAllowed) return json(response, 403, { error: 'origin_not_allowed' });
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.setHeader('Access-Control-Max-Age', '600');
      response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
      return response.end();
    }
    if (request.method === 'GET' && request.url === '/health') {
      return json(response, 200, { ok: true, version: 1 }, browserOriginAllowed ? origin : '');
    }
    if (request.method !== 'POST' || request.url !== '/v1/namuwiki') {
      return json(response, 404, { error: 'not_found' }, browserOriginAllowed ? origin : '');
    }
    if (!browserOriginAllowed) return json(response, 403, { error: 'origin_not_allowed' });

    let input;
    try { input = await readJson(request); } catch {
      return json(response, 400, { error: 'request_invalid' }, origin);
    }
    const title = String(input?.title || '').normalize('NFC').trim().slice(0, 240);
    const sourceUrl = input?.sourceUrl
      ? safeNamuUrl(input.sourceUrl)
      : title ? safeNamuUrl(`https://namu.wiki/w/${encodeURIComponent(title)}`) : null;
    if (!sourceUrl) return json(response, 400, { error: 'namuwiki_url_invalid' }, origin);

    let result;
    try { result = await fetchNamuWikiPage(sourceUrl, fetchImpl); } catch { result = null; }
    return result
      ? json(response, 200, result, origin)
      : json(response, 404, { error: 'namuwiki_lyrics_blocks_not_found' }, origin);
  });
}

export async function startNamuWikiLyricsHelper({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  fetchImpl = globalThis.fetch,
} = {}) {
  const server = createNamuWikiLyricsHelperServer({ fetchImpl });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startNamuWikiLyricsHelper();
  console.log(`Rekasong NamuWiki helper: http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
