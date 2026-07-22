// api/chat.ts
// Public AI chat endpoint (Bedrock → OpenRouter). Callable from other domains (CORS).
//
// POST /api/chat
//   Body: { message: string, history?: [{role, content}], system?: string }
//   Headers: x-api-key (if PUBLIC_API_KEY env var is set)
//
// GET /api/chat  → health check.
//
// Provider is resolved in lib/ai.ts (resolveChatProvider): Bedrock when
// BEDROCK_API_KEY is set, else OpenRouter. NVIDIA is no longer used here.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { aiService } from '../lib/ai';
import { config } from '../lib/config';
import { applyCors, checkPublicApiKey } from '../lib/cors';
import { logger } from '../lib/logger';

interface ChatBody {
  message: string;
  system?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
    const provider = config.bedrock.apiKey ? 'bedrock' : 'openrouter';
    res.status(200).json({ ok: true, service: 'ai-chat', provider });
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
    res.status(400).json({ ok: false, error: 'Invalid body — { message: string, history?, system? } required.' });
    return;
  }

  const history = (body.history || [])
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-20);

  try {
    const r = await aiService.chatCompletion(body.message, {
      system: body.system,
      history,
      temperature: 0.5,
      maxTokens: 1024,
    });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: r.error });
      return;
    }
    res.status(200).json({ ok: true, reply: r.reply, model: r.model, provider: r.provider });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('api.chat.unhandled', { error: msg });
    res.status(500).json({ ok: false, error: msg });
  }
}
