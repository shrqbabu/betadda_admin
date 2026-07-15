// lib/games.ts
// Table creation aligned with EXACT Firestore schemas per game.
// - Poker:    poker_tables    (full holdem state)
// - Ludo:     ludo_tables     (entryFee, playerAvatars/Names maps, players array, tier)
// - Joker:    joker_tables    (entryFee, hostId, players array, playerAvatars/Names maps)
// - 9-Card:   ninecard_tables (bootAmount, players map, playerOrder, deck)

import { db, FieldValue } from './firebase';
import { adminLogs } from './logs';
import { walletService } from './wallet';
import { logger } from './logger';

export type GameKind = 'poker' | 'ludo' | 'joker' | '9card';

const COLLECTION_MAP: Record<GameKind, string> = {
  poker:   'pokerTables',
  ludo:    'ludoTables',
  joker:   'jokerPairTables',
  '9card': 'nineCardTables',
};

export const GAME_LABELS: Record<GameKind, string> = {
  poker: '🃏 Poker',
  ludo:  '🎲 Ludo',
  joker: '🎭 Joker',
  '9card':'9️⃣ 9-Card',
};

function collectionFor(kind: GameKind): string { return COLLECTION_MAP[kind]; }

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  const anyV = v as { toMillis?: () => number; seconds?: number } | undefined;
  if (anyV && typeof anyV.toMillis === 'function') return anyV.toMillis();
  if (anyV && typeof anyV.seconds === 'number')    return anyV.seconds * 1000;
  return 0;
}

// ─── Summary view (for listing across games) ────────────────────────────────
export interface GameTableSummary {
  id: string;
  game: GameKind;
  name: string;
  status: string;
  pot: number;
  playerCount: number;
  maxPlayers: number;
  createdAt: number;
  raw: Record<string, unknown>;
}

function summarize(kind: GameKind, id: string, d: Record<string, unknown>): GameTableSummary {
  const players       = d.players;
  const playerCount   = Array.isArray(players) ? players.length
                      : players && typeof players === 'object' ? Object.keys(players).length
                      : 0;
  const pot           = Number(d.pot ?? d.prizePool ?? 0);
  const status        = String(d.status || 'unknown');
  const maxPlayers    = Number(d.maxPlayers ?? 6);
  return {
    id, game: kind,
    name: String(d.name || d.tableName || id),
    status, pot, playerCount, maxPlayers,
    createdAt: toMs(d.createdAt),
    raw: d,
  };
}

// ─── Create inputs (per-game) ───────────────────────────────────────────────
export interface CreatePokerInput {
  name: string;
  minBuyIn: number;
  maxBuyIn: number;
  smallBlind: number;
  bigBlind: number;
  maxPlayers?: number;
  adminId: number;
}

export interface CreateLudoInput {
  name: string;             // stored as `tier` in your schema; we keep both.
  tier?: string;
  entryFee: number;
  maxPlayers?: number;
  adminId: number;
}

export interface CreateJokerInput {
  name: string;
  entryFee: number;
  maxPlayers?: number;
  hostId?: string | null;
  adminId: number;
}

export interface CreateNineCardInput {
  name: string;
  bootAmount: number;
  minPlayers?: number;
  maxPlayers?: number;
  adminId: number;
}

export const gameService = {
  // ─── Poker ────────────────────────────────────────────
  async createPokerTable(input: CreatePokerInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (!input.name) return { ok: false, error: 'name required' };
    if (input.minBuyIn <= 0 || input.maxBuyIn < input.minBuyIn) return { ok: false, error: 'invalid buy-in' };
    if (input.smallBlind <= 0 || input.bigBlind < input.smallBlind) return { ok: false, error: 'invalid blinds' };

    const ref = db().collection('pokerTables').doc();
    const now = FieldValue.serverTimestamp();
    const doc = {
      id: ref.id,
      name: input.name,
      status: 'waiting',
      phase: 'waiting',
      minBuyIn: input.minBuyIn,
      maxBuyIn: input.maxBuyIn,
      smallBlind: input.smallBlind,
      bigBlind: input.bigBlind,
      maxPlayers: input.maxPlayers ?? 6,

      activePlayerUid: null,
      afkWarningEndsAt: null,
      afkWarningUid: null,
      communityCards: [],
      currentBet: 0,
      dealerSeat: 0,
      deck: [],
      handNumber: 0,
      lastActionAt: now,
      lastBrokePlayers: [],
      lastHandAllIn: false,
      lastHandWins: {},
      lastWinner: null,
      nextHandAt: null,
      players: [],
      pot: 0,
      reservedSeats: {},
      sidePots: [],
      spectatorQueue: [],
      turnExpiresAt: null,

      createdAt: now,
      updatedAt: now,
      createdBy: String(input.adminId),
    };
    await ref.set(doc);
    await adminLogs.record({
      telegramId: input.adminId, module: 'games', action: 'create_poker',
      target: ref.id, amount: input.minBuyIn, result: 'success',
      metadata: { name: input.name, sb: input.smallBlind, bb: input.bigBlind },
    });
    logger.info('games.poker.created', { id: ref.id, name: input.name });
    return { ok: true, id: ref.id };
  },

  // ─── Ludo ─────────────────────────────────────────────
  async createLudoTable(input: CreateLudoInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (!input.name)        return { ok: false, error: 'name required' };
    if (input.entryFee <= 0) return { ok: false, error: 'entryFee must be positive' };

    const ref = db().collection('ludoTables').doc();
    const now = FieldValue.serverTimestamp();
    const doc = {
      // No `id` field in your Ludo schema — keep aligned.
      entryFee: input.entryFee,
      playerAvatars: {},
      playerNames: {},
      players: [],
      prizePool: 0,
      round: 0,
      status: 'waiting',
      tier: input.tier || input.name,
      maxPlayers: input.maxPlayers ?? 4,
      createdBy: String(input.adminId),
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(doc);
    await adminLogs.record({
      telegramId: input.adminId, module: 'games', action: 'create_ludo',
      target: ref.id, amount: input.entryFee, result: 'success',
      metadata: { tier: doc.tier },
    });
    return { ok: true, id: ref.id };
  },

  // ─── Joker (pair) ─────────────────────────────────────
  async createJokerTable(input: CreateJokerInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (!input.name)        return { ok: false, error: 'name required' };
    if (input.entryFee <= 0) return { ok: false, error: 'entryFee must be positive' };

    const ref = db().collection('jokerPairTables').doc();
    const now = FieldValue.serverTimestamp();
    const doc = {
      entryFee: input.entryFee,
      hostId: input.hostId ?? null,
      maxPlayers: input.maxPlayers ?? 2,
      playerAvatars: {},
      playerNames: {},
      players: [],
      prizePool: 0,
      status: 'waiting',
      name: input.name,
      createdBy: String(input.adminId),
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(doc);
    await adminLogs.record({
      telegramId: input.adminId, module: 'games', action: 'create_joker',
      target: ref.id, amount: input.entryFee, result: 'success',
      metadata: { name: input.name },
    });
    return { ok: true, id: ref.id };
  },

  // ─── 9-Card ───────────────────────────────────────────
  async createNineCardTable(input: CreateNineCardInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (!input.name)         return { ok: false, error: 'name required' };
    if (input.bootAmount <= 0) return { ok: false, error: 'bootAmount must be positive' };

    const ref = db().collection('nineCardTables').doc();
    const now = FieldValue.serverTimestamp();
    const doc = {
      bootAmount: input.bootAmount,
      currentCallAmount: input.bootAmount,
      currentTurn: null,
      deck: [],
      deckIndex: 0,
      history: [],
      isDraw: false,
      lastRaiseAmount: 0,
      lastRaiseBy: null,
      locked: false,
      maxPlayers: input.maxPlayers ?? 2,
      minPlayers: input.minPlayers ?? 2,
      name: input.name,
      playerOrder: [],
      players: {},
      pot: 0,
      round: 0,
      status: 'waiting',
      winnerId: null,
      winnerReason: null,
      createdBy: String(input.adminId),
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(doc);
    await adminLogs.record({
      telegramId: input.adminId, module: 'games', action: 'create_9card',
      target: ref.id, amount: input.bootAmount, result: 'success',
      metadata: { name: input.name },
    });
    return { ok: true, id: ref.id };
  },

  // ─── Listing / management (works across all games) ────
  async listTables(kind: GameKind, limit = 20): Promise<GameTableSummary[]> {
    const coll = collectionFor(kind);
    try {
      const q = await db().collection(coll).orderBy('createdAt', 'desc').limit(limit).get();
      return q.docs.map(d => summarize(kind, d.id, d.data()));
    } catch {
      const q = await db().collection(coll).limit(limit).get();
      return q.docs.map(d => summarize(kind, d.id, d.data()))
                   .sort((a, b) => b.createdAt - a.createdAt);
    }
  },

  async getTable(kind: GameKind, id: string): Promise<GameTableSummary | null> {
    const s = await db().collection(collectionFor(kind)).doc(id).get();
    return s.exists ? summarize(kind, s.id, s.data() || {}) : null;
  },

  /** Extract player uids from the many possible shapes. */
  extractPlayers(kind: GameKind, raw: Record<string, unknown>): Array<{ uid: string; chips: number; name?: string }> {
    const players = raw.players;
    // Poker: array of { uid, chips, name, ... }
    if (Array.isArray(players)) {
      return players.map(p => ({
        uid:   String((p as { uid?: string }).uid || ''),
        chips: Number((p as { chips?: number }).chips || 0),
        name:  (p as { name?: string }).name,
      })).filter(p => p.uid);
    }
    // 9-Card / others: map keyed by uid
    if (players && typeof players === 'object') {
      return Object.entries(players as Record<string, unknown>).map(([uid, v]) => {
        const val = v as { chips?: number; name?: string; balance?: number };
        return { uid, chips: Number(val.chips ?? val.balance ?? 0), name: val.name };
      });
    }
    return [];
  },

  async kickPlayer(kind: GameKind, tableId: string, uid: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const t = await this.getTable(kind, tableId);
    if (!t) return { ok: false, error: 'Table not found' };
    const players = this.extractPlayers(kind, t.raw);
    const target  = players.find(p => p.uid === uid);
    if (!target)  return { ok: false, error: 'Player not at this table' };

    const coll = collectionFor(kind);
    const raw  = t.raw;

    if (Array.isArray(raw.players)) {
      const remaining = raw.players.filter(p => (p as { uid?: string }).uid !== uid);
      await db().collection(coll).doc(tableId).set({ players: remaining, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    } else if (raw.players && typeof raw.players === 'object') {
      await db().collection(coll).doc(tableId).set({
        [`players.${uid}`]: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    if (target.chips > 0) {
      await walletService.execute({
        uid, action: 'ADD', type: 'REFUND',
        amount: target.chips, balanceType: 'depositBalance',
        description: `${kind} table ${tableId} — kicked by admin`,
        idempotencyKey: `${kind}_${tableId}_kick_${uid}_${Date.now()}`,
        performedBy: String(adminId),
        metadata: { game: kind, tableId, reason: 'kick' },
      });
    }

    await adminLogs.record({
      telegramId: adminId, module: 'games', action: 'kick',
      target: `${kind}:${tableId}:${uid}`, amount: target.chips, result: 'success',
    });
    return { ok: true };
  },

  async refundTable(kind: GameKind, tableId: string, adminId: number): Promise<{ ok: true; refunded: number } | { ok: false; error: string }> {
    const t = await this.getTable(kind, tableId);
    if (!t) return { ok: false, error: 'Table not found' };
    const players = this.extractPlayers(kind, t.raw);

    let refunded = 0;
    for (const p of players) {
      if (p.chips <= 0) continue;
      const r = await walletService.execute({
        uid: p.uid, action: 'ADD', type: 'REFUND',
        amount: p.chips, balanceType: 'depositBalance',
        description: `${kind} table ${tableId} — full refund by admin`,
        idempotencyKey: `${kind}_${tableId}_refund_${p.uid}`,
        performedBy: String(adminId),
        metadata: { game: kind, tableId, reason: 'admin_refund' },
      });
      if (r.ok) refunded += p.chips;
    }

    const coll = collectionFor(kind);
    const emptyPlayers = Array.isArray(t.raw.players) ? [] : {};
    await db().collection(coll).doc(tableId).set({
      status: 'refunded', players: emptyPlayers, pot: 0, prizePool: 0,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'games', action: 'refund_table',
      target: `${kind}:${tableId}`, amount: refunded, result: 'success',
    });
    return { ok: true, refunded };
  },

  async endTable(kind: GameKind, tableId: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const coll = collectionFor(kind);
    const s = await db().collection(coll).doc(tableId).get();
    if (!s.exists) return { ok: false, error: 'Table not found' };
    const isArr = Array.isArray((s.data() || {}).players);
    await db().collection(coll).doc(tableId).set({
      status: 'ended',
      players: isArr ? [] : {},
      pot: 0, prizePool: 0,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await adminLogs.record({
      telegramId: adminId, module: 'games', action: 'end_table',
      target: `${kind}:${tableId}`, result: 'success',
    });
    return { ok: true };
  },

  async deleteTable(kind: GameKind, tableId: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    await db().collection(collectionFor(kind)).doc(tableId).delete();
    await adminLogs.record({
      telegramId: adminId, module: 'games', action: 'delete_table',
      target: `${kind}:${tableId}`, result: 'success',
    });
    return { ok: true };
  },
};
