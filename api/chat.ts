// api/chat.ts
// Public AI chat endpoint (NVIDIA-backed). Callable from other domains (CORS).
//
// POST /api/chat
//   Body: { message: string, model?: string, history?: [{role, content}], system?: string, fallbacks?: string[] }
//   Headers: x-api-key (if PUBLIC_API_KEY env var is set)
//
// GET /api/chat  → health check.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { nvidiaChat, type NvidiaTurn } from '../lib/nvidia';
import { resolveModel } from '../lib/models';
import { config } from '../lib/config';
import { applyCors, checkPublicApiKey } from '../lib/cors';
import { logger } from '../lib/logger';

interface ChatBody {
  message: string;
  model?: string;
  system?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  fallbacks?: string[];
}

function parseBody(req: VercelRequest): ChatBody | null {
  const raw = req.body;
  if (!raw) return null;
  const obj = typeof raw === 'string' ? safeJson(raw) : (raw as ChatBody);
  if (!obj || typeof obj !== 'object') return null;
  if (typeof (obj as ChatBody).message !== 'string' || !(obj as ChatBody).message.trim()) return null;
  return obj as ChatBody;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    res.status(200).json({ ok: true, service: 'ai-chat', provider: 'nvidia' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!checkPublicApiKey(req)) {
    res.status(401).json({ ok: false, error: 'Missing or invalid x-api-key' });
    return;
  }

  const body = parseBody(req);
  if (!body) {
    res.status(400).json({ ok: false, error: 'Invalid body — { message: string, model?: string, history?, system?, fallbacks? } required.' });
    return;
  }

  const modelId = resolveModel(body.model, config.nvidia.model);
  const fallbacks = Array.isArray(body.fallbacks)
    ? body.fallbacks.map(m => resolveModel(m, m))
    : undefined;

  const turns: NvidiaTurn[] = (body.history || [])
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-20);
  turns.push({ role: 'user', content: body.message });

  try {
    const r = await nvidiaChat(turns, {
      model: modelId,
      fallbacks,
      systemPrompt: body.system,
      temperature: 0.5,
      maxTokens: 1024,
    });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: r.error, model: modelId });
      return;
    }
    res.status(200).json({ ok: true, reply: r.reply, model: r.model });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('api.chat.unhandled', { error: msg });
    res.status(500).json({ ok: false, error: msg });
  }
}
