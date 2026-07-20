// lib/telegram.ts
// Telegram Bot API client + inline keyboard builder.

import { config } from './config';
import { httpRequest, HttpError } from './http';
import { logger } from './logger';
import type {
  InlineKeyboardButton, InlineKeyboardMarkup,
  SendMessageOptions, EditMessageOptions, AnswerCallbackQueryOptions,
  ForceReply,
} from '../types/telegram';

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function call<T>(method: string, payload: object): Promise<T> {
  const url = `${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`;
  try {
    const res = await httpRequest<TgResponse<T>>(url, {
      method: 'POST',
      body: payload,
      timeoutMs: 12_000,
    });
    if (!res.data?.ok || res.data.result === undefined) {
      logger.warn('telegram.api.non_ok', { method, description: res.data?.description });
      throw new Error(`Telegram API error: ${res.data?.description || 'unknown'}`);
    }
    return res.data.result;
  } catch (err) {
    if (err instanceof HttpError) {
      logger.error('telegram.api.http_error', { method, status: err.status, body: err.body.slice(0, 400) });
    } else {
      logger.error('telegram.api.error', { method, error: (err as Error).message });
    }
    throw err;
  }
}

export const telegram = {
  async sendMessage(opts: SendMessageOptions): Promise<{ message_id: number }> {
    return call<{ message_id: number }>('sendMessage', { ...opts, parse_mode: opts.parse_mode ?? 'HTML' });
  },
  async editMessageText(opts: EditMessageOptions): Promise<unknown> {
    return call('editMessageText', { ...opts, parse_mode: opts.parse_mode ?? 'HTML' });
  },
  async answerCallbackQuery(opts: AnswerCallbackQueryOptions): Promise<unknown> {
    return call('answerCallbackQuery', opts);
  },
  async sendPhoto(chatId: number | string, photo: string, caption?: string, keyboard?: InlineKeyboardMarkup): Promise<unknown> {
    return call('sendPhoto', {
      chat_id: chatId, photo,
      caption, parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  },
  async sendVideo(chatId: number | string, video: string, caption?: string, keyboard?: InlineKeyboardMarkup): Promise<unknown> {
    return call('sendVideo', {
      chat_id: chatId, video,
      caption, parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  },
  async sendDocument(chatId: number | string, document: string, caption?: string, keyboard?: InlineKeyboardMarkup): Promise<unknown> {
    return call('sendDocument', {
      chat_id: chatId, document,
      caption, parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  },
  /** Upload a document from in-memory content (multipart), e.g. a generated backup file. */
  async sendDocumentContent(chatId: number | string, filename: string, content: string | Buffer, caption?: string): Promise<unknown> {
    const url = `${config.telegram.apiBase}/bot${config.telegram.botToken}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    form.append('document', new Blob([bytes], { type: 'application/json' }), filename);
    const res = await fetch(url, { method: 'POST', body: form });
    const data = (await res.json().catch(() => null)) as TgResponse<unknown> | null;
    if (!res.ok || !data?.ok) {
      logger.error('telegram.sendDocumentContent.failed', { status: res.status, description: data?.description });
      throw new Error(`Telegram upload failed: ${data?.description || res.status}`);
    }
    return data.result;
  },
  /** Download a file the user sent to the bot (bot API limit: ≤20 MB). */
  async downloadFile(fileId: string): Promise<Buffer> {
    const info = await call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!info.file_path) throw new Error('Telegram ne file_path nahi diya');
    const url = `${config.telegram.apiBase}/file/bot${config.telegram.botToken}/${info.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`File download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async deleteMessage(chatId: number | string, messageId: number): Promise<unknown> {
    return call('deleteMessage', { chat_id: chatId, message_id: messageId });
  },
};

// ─── Inline Keyboard Builder ────────────────────────────────────────────────
export const kb = {
  button(text: string, callbackData: string): InlineKeyboardButton {
    return { text, callback_data: callbackData };
  },
  url(text: string, url: string): InlineKeyboardButton {
    return { text, url };
  },
  row(...buttons: InlineKeyboardButton[]): InlineKeyboardButton[] {
    return buttons;
  },
  build(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
    return { inline_keyboard: rows };
  },
  forceReply(placeholder?: string): ForceReply {
    return { force_reply: true, input_field_placeholder: placeholder, selective: true };
  },
};

/** Standard "Back / Home" navigation row. */
export function backHomeRow(backCb: string): InlineKeyboardButton[] {
  return [
    kb.button('⬅️ Back', backCb),
    kb.button('🏠 Home', 'nav:home'),
  ];
}
