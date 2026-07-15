// lib/auth.ts
// Authentication for the single admin webhook endpoint.

import type { VercelRequest } from '@vercel/node';
import { config } from './config';
import { auth as fbAuth } from './firebase';
import { logger } from './logger';

export type AuthReason =
  | 'ok'
  | 'missing_telegram_secret'
  | 'bad_telegram_secret'
  | 'missing_admin_secret'
  | 'bad_admin_secret'
  | 'not_admin_id'
  | 'bad_bearer_token'
  | 'unknown';

export interface AuthResult {
  ok: boolean;
  reason: AuthReason;
  telegramId?: number;
  firebaseUid?: string;
}

/** Verifies the Telegram webhook secret header (X-Telegram-Bot-Api-Secret-Token). */
export function verifyWebhookSecret(req: VercelRequest): boolean {
  const expected = config.telegram.webhookSecret;
  if (!expected) return true; // secret optional
  const got = req.headers['x-telegram-bot-api-secret-token'];
  return typeof got === 'string' && got === expected;
}

/** True when this Telegram user is an admin. */
export function isAdminTelegramId(id: number | undefined): boolean {
  if (!id) return false;
  return config.telegram.adminIds.includes(id);
}

/** Verify optional ADMIN_SECRET header (for programmatic calls, not for Telegram). */
export function verifyAdminSecret(req: VercelRequest): boolean {
  const got = req.headers['x-admin-secret'];
  return typeof got === 'string' && got === config.admin.secret;
}

/** Optional Firebase Bearer token verification (for programmatic / dashboard callers). */
export async function verifyFirebaseBearer(req: VercelRequest): Promise<string | null> {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return null;
  const token = raw.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const decoded = await fbAuth().verifyIdToken(token, true);
    return decoded.uid;
  } catch (err) {
    logger.warn('auth.firebase.verify_failed', { error: (err as Error).message });
    return null;
  }
}

/**
 * Main auth: for Telegram webhooks, check secret header + admin id.
 * For programmatic calls (no telegram body), require X-Admin-Secret and/or Firebase Bearer.
 */
export async function authenticateRequest(
  req: VercelRequest,
  telegramFromId: number | undefined
): Promise<AuthResult> {
  const isTelegramCall = !!telegramFromId;

  if (isTelegramCall) {
    if (!verifyWebhookSecret(req)) {
      return { ok: false, reason: 'bad_telegram_secret' };
    }
    if (!isAdminTelegramId(telegramFromId)) {
      return { ok: false, reason: 'not_admin_id', telegramId: telegramFromId };
    }
    return { ok: true, reason: 'ok', telegramId: telegramFromId };
  }

  // Programmatic path: require admin secret OR a valid firebase admin bearer token.
  const secretOk = verifyAdminSecret(req);
  const firebaseUid = await verifyFirebaseBearer(req);

  if (!secretOk && !firebaseUid) {
    return { ok: false, reason: 'missing_admin_secret' };
  }
  return { ok: true, reason: 'ok', firebaseUid: firebaseUid ?? undefined };
}
