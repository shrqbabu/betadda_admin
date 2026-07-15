// api/admin.ts
// The ONLY API endpoint. Receives Telegram webhooks + optional programmatic calls,
// authenticates, then hands off to the router. No business logic here.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../lib/auth';
import { handleUpdate } from '../lib/router';
import { telegram } from '../lib/telegram';
import { logger } from '../lib/logger';
import { ok, badRequest, unauthorized, serverError } from '../lib/response';
import type { TelegramUpdate } from '../types/telegram';

function parseBody(req: VercelRequest): unknown {
  if (!req.body) return null;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body;
}

function extractTelegramFromId(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const u = body as TelegramUpdate;
  const id = u.callback_query?.from?.id
    ?? u.message?.from?.id
    ?? u.edited_message?.from?.id;
  return typeof id === 'number' ? id : undefined;
}

function extractChatId(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const u = body as TelegramUpdate;
  return u.callback_query?.message?.chat.id
    ?? u.message?.chat.id
    ?? u.edited_message?.chat.id;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Health check
  if (req.method === 'GET') {
    ok(res, { ok: true, service: 'telegram-admin-backend' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    badRequest(res, 'Method not allowed');
    return;
  }

  const body = parseBody(req);
  if (!body || typeof body !== 'object') {
    badRequest(res, 'Invalid JSON body');
    return;
  }

  const telegramFromId = extractTelegramFromId(body);
  const chatId         = extractChatId(body);

  try {
    const auth = await authenticateRequest(req, telegramFromId);
    if (!auth.ok) {
      // If this is a Telegram interaction from a non-admin user, reply with a polite message.
      // We still return 200 to Telegram so it doesn't retry indefinitely.
      if (telegramFromId && chatId && auth.reason === 'not_admin_id') {
        await telegram.sendMessage({
          chat_id: chatId,
          text: '❌ Unauthorized',
        }).catch(() => {});
        logger.warn('auth.not_admin', { telegramFromId });
        ok(res); // ack Telegram
        return;
      }
      logger.warn('auth.failed', { reason: auth.reason });
      unauthorized(res, '❌ Unauthorized');
      return;
    }

    // Programmatic call path (no telegram body).
    if (!telegramFromId) {
      ok(res, { ok: true, message: 'Authenticated. Nothing to process (no Telegram update in body).' });
      return;
    }

    await handleUpdate(body as TelegramUpdate, telegramFromId);
    ok(res); // ack Telegram fast
  } catch (err) {
    logger.error('admin.handler.unhandled', { error: (err as Error).message, stack: (err as Error).stack });
    // Ack Telegram to avoid retries, but signal failure on programmatic path.
    if (telegramFromId) {
      ok(res);
    } else {
      serverError(res, (err as Error).message);
    }
  }
}
