// lib/session.ts
// Per-admin conversation state stored in Firestore.

import { db, FieldValue } from './firebase';
import { logger } from './logger';

const COLLECTION = 'admin_sessions';

export type SessionState =
  | 'idle'
  | 'wallet:await_uid'
  | 'wallet:await_amount'
  | 'wallet:await_description'
  | 'wallet:await_confirm'
  | 'users:await_query'
  | 'users:await_edit_value'
  | 'withdraw:await_reject_reason'
  | 'deposit:await_reject_reason'
  | 'broadcast:await_content'
  | 'broadcast:await_confirm'
  | 'games:await_create_form'
  | 'games:await_kick_uid'
  | 'redeem:await_form'
  | 'ai:await_prompt'
  | 'ai:await_agent_prompt';

export interface SessionData {
  telegramId: number;
  chatId: number;
  state: SessionState;
  context: Record<string, unknown>;
  updatedAt: number;
}

function ref(telegramId: number) {
  return db().collection(COLLECTION).doc(String(telegramId));
}

export const sessionStore = {
  async get(telegramId: number): Promise<SessionData | null> {
    const s = await ref(telegramId).get();
    return s.exists ? (s.data() as SessionData) : null;
  },

  async set(telegramId: number, chatId: number, state: SessionState, context: Record<string, unknown> = {}): Promise<void> {
    await ref(telegramId).set({ telegramId, chatId, state, context, updatedAt: Date.now() });
  },

  async mergeContext(telegramId: number, patch: Record<string, unknown>): Promise<void> {
    const existing = await sessionStore.get(telegramId);
    const merged   = { ...(existing?.context || {}), ...patch };
    await ref(telegramId).set({ context: merged, updatedAt: Date.now() }, { merge: true });
  },

  async clear(telegramId: number): Promise<void> {
    try { await ref(telegramId).delete(); }
    catch (err) { logger.warn('session.clear.failed', { telegramId, error: (err as Error).message }); }
  },
};

// ─── Idempotency store (arbitrary keys) ─────────────────────────────────────
const IDEM = 'admin_idempotency';
export const idempotencyStore = {
  async check(key: string): Promise<{ exists: boolean; result?: unknown }> {
    const s = await db().collection(IDEM).doc(key).get();
    if (!s.exists) return { exists: false };
    return { exists: true, result: (s.data() || {}).result };
  },
  async save(key: string, result: unknown): Promise<void> {
    await db().collection(IDEM).doc(key).set({ key, result, createdAt: FieldValue.serverTimestamp() });
  },
};
