// lib/cors.ts
// CORS helper for endpoints that need to be callable from other domains.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from './config';

function isOriginAllowed(origin: string): boolean {
  const raw = config.cors.allowedOrigins.trim();
  if (!raw || raw === '*') return true;
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin);
}

/**
 * Apply CORS headers. Returns true if the request is a preflight (OPTIONS)
 * and the response has already been ended — caller should return early.
 */
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  const origin = String(req.headers.origin || '');
  const allowAll = config.cors.allowedOrigins.trim() === '*';

  if (allowAll) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * Optional shared-secret gate. If PUBLIC_API_KEY is set in env, the request
 * must send a matching `x-api-key` header. Returns true if authorized.
 */
export function checkPublicApiKey(req: VercelRequest): boolean {
  const expected = config.cors.publicApiKey;
  if (!expected) return true; // gate not enabled
  const got = String(req.headers['x-api-key'] || '');
  return got === expected;
}
