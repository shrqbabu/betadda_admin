// lib/logs.ts
// Admin action audit log — persisted to Firestore.

import { db, FieldValue } from './firebase';
import { logger } from './logger';

const COLLECTION = 'admin_logs';

export interface AdminLogEntry {
  telegramId: number;
  module: string;         // wallet | users | deposit | withdraw | poker | broadcast | ai | server
  action: string;         // add | deduct | approve | reject | ban | ...
  target?: string;        // target uid, tableId, etc.
  amount?: number;
  description?: string;
  result: 'success' | 'failure';
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export const adminLogs = {
  async record(entry: AdminLogEntry): Promise<void> {
    try {
      await db().collection(COLLECTION).add({
        ...entry,
        createdAt: FieldValue.serverTimestamp(),
        createdAtMs: Date.now(),
      });
    } catch (err) {
      logger.error('adminLogs.record.failed', { error: (err as Error).message, entry });
    }
  },

  async recent(limit = 50): Promise<Array<AdminLogEntry & { id: string; createdAtMs: number }>> {
    const q = await db()
      .collection(COLLECTION)
      .orderBy('createdAtMs', 'desc')
      .limit(limit)
      .get();
    return q.docs.map(d => ({ id: d.id, ...(d.data() as AdminLogEntry & { createdAtMs: number }) }));
  },

  async byAdmin(telegramId: number, limit = 30): Promise<Array<AdminLogEntry & { id: string; createdAtMs: number }>> {
    const q = await db()
      .collection(COLLECTION)
      .where('telegramId', '==', telegramId)
      .orderBy('createdAtMs', 'desc')
      .limit(limit)
      .get();
    return q.docs.map(d => ({ id: d.id, ...(d.data() as AdminLogEntry & { createdAtMs: number }) }));
  },
};
