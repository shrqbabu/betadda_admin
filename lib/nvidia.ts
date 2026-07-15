// lib/nvidia.ts
// NVIDIA Integrate API (OpenAI-compatible chat/completions).
// Used by aiService when AI_PROVIDER=nvidia and by /api/chat.

import { config } from './config';
import { httpRequest, HttpError } from './http';
import { logger } from './logger';

export interface NvidiaTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NvidiaChatOptions {
  model?:        string;      // primary model override (else config.nvidia.model)
  fallbacks?:    string[];    // additional fallback models tried in order
  systemPrompt?: string;
  temperature?:  number;
  maxTokens?:    number;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

function parseFallbacks(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

interface OpenAIModelsResponse {
  data?: Array<{ id: string }>;
}

/**
 * List available model IDs on NVIDIA's Integrate API. Handy for debugging
 * "model not found" 404s — call this once to see what's actually available.
 */
export async function listNvidiaModels(): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (!config.nvidia.apiKey) {
    return { ok: false, error: 'NVIDIA_API_KEY missing' };
  }
  try {
    const res = await httpRequest<OpenAIModelsResponse>(
      `${config.nvidia.apiBase}/models`,
      {
        method: 'GET',
        timeoutMs: 15_000,
        headers: { 'Authorization': `Bearer ${config.nvidia.apiKey}` },
      },
    );
    const ids = (res.data?.data || []).map(m => m.id).sort();
    return { ok: true, ids };
  } catch (err) {
    const body = err instanceof HttpError ? err.body.slice(0, 300) : '';
    return { ok: false, error: `${(err as Error).message}${body ? ' | ' + body : ''}` };
  }
}

/**
 * Send a multi-turn chat request. Tries the primary model first; on 5xx,
 * 429, or empty reply, falls through the fallback list until one succeeds.
 */
export async function nvidiaChat(
  turns: NvidiaTurn[],
  opts: NvidiaChatOptions = {},
): Promise<{ ok: true; reply: string; model: string } | { ok: false; error: string }> {
  if (!config.nvidia.apiKey) {
    return { ok: false, error: 'NVIDIA not configured (missing NVIDIA_API_KEY).' };
  }

  const primary = opts.model || config.nvidia.model;
  const fallbacks = opts.fallbacks && opts.fallbacks.length
    ? opts.fallbacks
    : parseFallbacks(config.nvidia.fallbacks);
  const candidates = [primary, ...fallbacks.filter(m => m !== primary)];

  const messages: NvidiaTurn[] = [
    ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
    ...turns.filter(t => t.content && t.content.trim()),
  ];
  if (messages.length === 0 || !messages.some(m => m.role === 'user')) {
    return { ok: false, error: 'No user messages to send.' };
  }

  let lastError = 'unknown';
  for (const model of candidates) {
    try {
      const res = await httpRequest<OpenAIChatResponse>(
        `${config.nvidia.apiBase}/chat/completions`,
        {
          method: 'POST',
          timeoutMs: 30_000,
          headers: {
            'Authorization': `Bearer ${config.nvidia.apiKey}`,
          },
          body: {
            model,
            messages,
            temperature: opts.temperature ?? 0.5,
            top_p: 1,
            max_tokens: opts.maxTokens ?? 1024,
            stream: false,
          },
        },
      );
      const reply = res.data?.choices?.[0]?.message?.content?.trim() ?? '';
      if (reply) return { ok: true, reply, model };
      lastError = res.data?.error?.message || 'empty reply';
      logger.warn('nvidia.chat.empty', { model, error: lastError });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      const body = err instanceof HttpError ? err.body.slice(0, 300) : '';
      lastError = `${(err as Error).message}${body ? ' | ' + body : ''}`;
      logger.warn('nvidia.chat.failed', { model, status, error: lastError });
      // 4xx (except 429) is likely a permanent request problem — no point retrying
      if (status >= 400 && status < 500 && status !== 429) {
        // exception: try next model on 404 (unknown model)
        if (status !== 404) return { ok: false, error: lastError };
      }
    }
  }
  return { ok: false, error: `All NVIDIA models failed. Last: ${lastError}` };
}
