// lib/broadcast.ts
// Broadcast messages to all users who have a telegram chat id stored.

import { db } from './firebase';
import { telegram, kb } from './telegram';
import { adminLogs } from './logs';
import { logger } from './logger';
import { mapConcurrent } from './utils';
import type { InlineKeyboardMarkup } from '../types/telegram';

const USERS = 'users';

export type BroadcastMediaType = 'text' | 'image' | 'video' | 'pdf';

export interface BroadcastInput {
  type: BroadcastMediaType;
  content: string;      // For text: body text. For media: URL/file_id.
  caption?: string;     // For media types.
  buttons?: Array<{ text: string; url: string }>;
}

export interface BroadcastResult {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ chatId: number; error: string }>;
}

async function loadTargetChatIds(): Promise<number[]> {
  const q = await db()
    .collection(USERS)
    .where('telegramChatId', '>', 0)
    .get();
  const ids: number[] = [];
  q.forEach(d => {
    const cid = Number((d.data() as { telegramChatId?: number }).telegramChatId);
    if (Number.isFinite(cid) && cid > 0) ids.push(cid);
  });
  return Array.from(new Set(ids));
}

function buildKeyboard(input: BroadcastInput): InlineKeyboardMarkup | undefined {
  if (!input.buttons || input.buttons.length === 0) return undefined;
  const rows = input.buttons.map(b => [kb.url(b.text, b.url)]);
  return kb.build(rows);
}

export const broadcastService = {
  async send(input: BroadcastInput, adminId: number): Promise<BroadcastResult> {
    const chatIds  = await loadTargetChatIds();
    const keyboard = buildKeyboard(input);

    const result: BroadcastResult = { attempted: chatIds.length, succeeded: 0, failed: 0, errors: [] };

    await mapConcurrent(chatIds, 8, async (chatId) => {
      try {
        switch (input.type) {
          case 'text':
            await telegram.sendMessage({
              chat_id: chatId, text: input.content,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_markup: keyboard,
            });
            break;
          case 'image':
            await telegram.sendPhoto(chatId, input.content, input.caption, keyboard);
            break;
          case 'video':
            await telegram.sendVideo(chatId, input.content, input.caption, keyboard);
            break;
          case 'pdf':
            await telegram.sendDocument(chatId, input.content, input.caption, keyboard);
            break;
        }
        result.succeeded += 1;
      } catch (err) {
        result.failed += 1;
        result.errors.push({ chatId, error: (err as Error).message.slice(0, 200) });
      }
    });

    await adminLogs.record({
      telegramId: adminId, module: 'broadcast', action: 'send',
      result: result.failed === 0 ? 'success' : 'failure',
      description: `${input.type} → ${result.succeeded}/${result.attempted}`,
      metadata: { type: input.type },
    });
    logger.info('broadcast.completed', {
      adminId, type: input.type,
      attempted: result.attempted, succeeded: result.succeeded, failed: result.failed,
    });

    return result;
  },
};
