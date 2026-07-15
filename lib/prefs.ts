// lib/prefs.ts
// Per-admin preferences (currently: preferred AI models).

import { db } from './firebase';
import { logger } from './logger';

const COLLECTION = 'admin_prefs';

export interface AdminPrefs {
  telegramId:        number;
  nvidiaModel?:      string;
  openrouterModel?:  string;
  updatedAt?:        number;
}

function ref(telegramId: number) {
  return db().collection(COLLECTION).doc(String(telegramId));
}

export const prefsStore = {
  async get(telegramId: number): Promise<AdminPrefs | null> {
    try {
      const s = await ref(telegramId).get();
      return s.exists ? (s.data() as AdminPrefs) : null;
    } catch (err) {
      logger.warn('prefs.get.failed', { telegramId, error: (err as Error).message });
      return null;
    }
  },

  async set(telegramId: number, patch: Partial<AdminPrefs>): Promise<void> {
    await ref(telegramId).set(
      { telegramId, ...patch, updatedAt: Date.now() },
      { merge: true },
    );
  },
};
