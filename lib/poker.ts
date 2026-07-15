// lib/poker.ts
// Poker admin: read tables, kick players, refund entire table, end table.

import { db, FieldValue } from './firebase';
import { walletService } from './wallet';
import { adminLogs } from './logs';
import { logger } from './logger';

const COLLECTION = 'poker_tables';

export interface PokerAdminPlayer {
  uid: string;
  name: string;
  chips: number;
  bet?: number;
  seatIndex?: number;
  status?: string;
  seatStatus?: string;
}

export interface PokerAdminTable {
  id: string;
  name?: string;
  status: string;
  phase?: string;
  pot?: number;
  smallBlind?: number;
  bigBlind?: number;
  players: PokerAdminPlayer[];
  createdAt?: number;
  updatedAt?: number;
}

function mapTable(id: string, data: Record<string, unknown>): PokerAdminTable {
  const players = Array.isArray(data.players) ? (data.players as PokerAdminPlayer[]) : [];
  return {
    id,
    name:       (data.name as string) || undefined,
    status:     String(data.status || 'unknown'),
    phase:      data.phase as string | undefined,
    pot:        Number(data.pot || 0),
    smallBlind: Number(data.smallBlind || 0),
    bigBlind:   Number(data.bigBlind || 0),
    players,
    createdAt:  Number(data.createdAt) || undefined,
    updatedAt:  Number(data.updatedAt) || undefined,
  };
}

export const pokerService = {
  async runningTables(limit = 20): Promise<PokerAdminTable[]> {
    // Consider a table "running" if status is playing OR waiting.
    const q = await db()
      .collection(COLLECTION)
      .where('status', 'in', ['playing', 'waiting'])
      .limit(limit)
      .get();
    return q.docs.map(d => mapTable(d.id, d.data()));
  },

  async get(id: string): Promise<PokerAdminTable | null> {
    const s = await db().collection(COLLECTION).doc(id).get();
    return s.exists ? mapTable(s.id, s.data() || {}) : null;
  },

  async kickPlayer(tableId: string, uid: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const t = await this.get(tableId);
    if (!t) return { ok: false, error: 'Table not found' };
    const player = t.players.find(p => p.uid === uid);
    if (!player) return { ok: false, error: 'Player not at this table' };

    const remaining = t.players.filter(p => p.uid !== uid);
    await db().collection(COLLECTION).doc(tableId).set({
      players: remaining,
      updatedAt: Date.now(),
      lastAdminAction: {
        type: 'kick', by: adminId, target: uid, at: FieldValue.serverTimestamp(),
      },
    }, { merge: true });

    // Refund the player's chips to their deposit balance if they had any.
    if (player.chips > 0) {
      await walletService.execute({
        uid,
        action: 'ADD',
        type: 'REFUND',
        amount: player.chips,
        balanceType: 'depositBalance',
        description: `Poker table ${tableId} — kicked by admin, chip refund`,
        idempotencyKey: `poker_${tableId}_kick_${uid}_${Date.now()}`,
        performedBy: String(adminId),
        metadata: { tableId, reason: 'kick' },
      });
    }

    await adminLogs.record({
      telegramId: adminId, module: 'poker', action: 'kick',
      target: uid, amount: player.chips, result: 'success',
      metadata: { tableId },
    });
    return { ok: true };
  },

  async refundTable(tableId: string, adminId: number): Promise<{ ok: true; refunded: number } | { ok: false; error: string }> {
    const t = await this.get(tableId);
    if (!t) return { ok: false, error: 'Table not found' };

    let refunded = 0;
    for (const p of t.players) {
      const chips = Number(p.chips || 0);
      if (chips <= 0) continue;
      const r = await walletService.execute({
        uid: p.uid,
        action: 'ADD',
        type: 'REFUND',
        amount: chips,
        balanceType: 'depositBalance',
        description: `Poker table ${tableId} — full refund by admin ${adminId}`,
        idempotencyKey: `poker_${tableId}_refund_${p.uid}`,
        performedBy: String(adminId),
        metadata: { tableId, reason: 'admin_refund' },
      });
      if (r.ok) refunded += chips;
      else logger.warn('poker.refund.partial_fail', { tableId, uid: p.uid, error: r.message });
    }

    await db().collection(COLLECTION).doc(tableId).set({
      status: 'refunded',
      players: [],
      pot: 0,
      updatedAt: Date.now(),
      lastAdminAction: { type: 'refund_all', by: adminId, at: FieldValue.serverTimestamp() },
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'poker', action: 'refund_table',
      target: tableId, amount: refunded, result: 'success',
    });
    return { ok: true, refunded };
  },

  async endTable(tableId: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const t = await this.get(tableId);
    if (!t) return { ok: false, error: 'Table not found' };

    await db().collection(COLLECTION).doc(tableId).set({
      status: 'ended',
      players: [],
      pot: 0,
      updatedAt: Date.now(),
      lastAdminAction: { type: 'end', by: adminId, at: FieldValue.serverTimestamp() },
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'poker', action: 'end_table',
      target: tableId, result: 'success',
    });
    return { ok: true };
  },
};
