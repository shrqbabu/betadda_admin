// lib/wallet.ts
// Wallet service aligned with existing internalWalletTransaction.
// - Writes to `transactions` collection (matching client-side reads).
// - Idempotency doc id is `idem_<key>`.
// - Supports ADD / DEDUCT / WITHDRAW / ADDFUND actions.
// - ADD to winningBalance triggers 1% bonus→deposit conversion.
// - DEDUCT auto-cascades across deposit → winning → referral → bonus.

import { db, FieldValue } from './firebase';
import { logger } from './logger';
import type {
  WalletRequest, WalletResult, WalletDoc, WalletBalanceType, WalletAction, WalletTxType,
} from '../types/wallet';

const WALLETS = 'wallets';
const TX      = 'transactions';

const BONUS_CONVERSION_RATE = 0.01;

const ALLOWED_TYPES: WalletTxType[] = [
  'DEPOSIT', 'WINNING', 'REFERRAL', 'BONUS', 'BET_WIN', 'SPLIT_WIN', 'REDEEM_CODE',
  'GAME_BET', 'CASH_OUT', 'GAME_ENTRY', 'ADD_MONEY', 'GAME_WIN', 'BET_LOSS',
  'REFUND', 'WITHDRAWAL', 'ADMIN_DEDUCTION',
];

const ALLOWED_BALANCE_TYPES: WalletBalanceType[] = [
  'depositBalance', 'winningBalance', 'bonusBalance', 'referralBalance',
];

const ALLOWED_ACTIONS: WalletAction[] = ['ADD', 'DEDUCT', 'WITHDRAW', 'ADDFUND'];

// ─── helpers ────────────────────────────────────────────────────────────────
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

function cascadeDeduct(w: WalletDoc, amount: number):
  { depositBalance: number; winningBalance: number; referralBalance: number; bonusBalance: number; totalBalance: number } | null {
  let rem = amount;
  let d = num(w.depositBalance), win = num(w.winningBalance), r = num(w.referralBalance), b = num(w.bonusBalance);
  const p1 = Math.min(d, rem);   d -= p1;   rem -= p1;
  const p2 = Math.min(win, rem); win -= p2; rem -= p2;
  const p3 = Math.min(r, rem);   r -= p3;   rem -= p3;
  const p4 = Math.min(b, rem);   b -= p4;   rem -= p4;
  if (rem > 0) return null;
  return { depositBalance: d, winningBalance: win, referralBalance: r, bonusBalance: b, totalBalance: d + win + r + b };
}

// ─── service ────────────────────────────────────────────────────────────────
export const walletService = {
  async getOrCreate(uid: string): Promise<WalletDoc> {
    const ref = db().collection(WALLETS).doc(uid);
    const s = await ref.get();
    if (s.exists) return s.data() as WalletDoc;
    const empty: WalletDoc = {
      uid,
      depositBalance: 0, winningBalance: 0, bonusBalance: 0, referralBalance: 0,
      totalBalance: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await ref.set(empty);
    return empty;
  },

  async getBalance(uid: string): Promise<WalletDoc | null> {
    const s = await db().collection(WALLETS).doc(uid).get();
    return s.exists ? (s.data() as WalletDoc) : null;
  },

  async execute(req: WalletRequest): Promise<WalletResult> {
    // ─── validation ───────────────────────────────────────
    if (!req.uid) return { ok: false, code: 'INVALID_USER', message: 'uid required' };
    if (!req.amount || typeof req.amount !== 'number' || req.amount <= 0)
      return { ok: false, code: 'INVALID_AMOUNT', message: 'amount must be positive' };
    if (!ALLOWED_ACTIONS.includes(req.action))
      return { ok: false, code: 'INVALID_AMOUNT', message: `Invalid action: ${req.action}` };
    if (!ALLOWED_TYPES.includes(req.type))
      return { ok: false, code: 'INVALID_AMOUNT', message: `Invalid type: ${req.type}` };
    if (req.balanceType && !ALLOWED_BALANCE_TYPES.includes(req.balanceType))
      return { ok: false, code: 'INVALID_AMOUNT', message: `Invalid balanceType: ${req.balanceType}` };
    if (!req.idempotencyKey)
      return { ok: false, code: 'INVALID_AMOUNT', message: 'idempotencyKey required' };

    const txId      = `idem_${req.idempotencyKey}`;
    const txRef     = db().collection(TX).doc(txId);
    const walletRef = db().collection(WALLETS).doc(req.uid);
    const resolvedBalance: WalletBalanceType = req.balanceType || 'winningBalance';

    try {
      const result = await db().runTransaction<WalletResult>(async (tx) => {
        const [dupSnap, walletSnap] = await Promise.all([tx.get(txRef), tx.get(walletRef)]);

        if (dupSnap.exists) {
          logger.info('wallet.idempotent_hit', { txId });
          const w = walletSnap.exists ? (walletSnap.data() as WalletDoc) : ({} as WalletDoc);
          return { ok: true, txId, wallet: w, duplicate: true };
        }

        if (!walletSnap.exists) {
          // Auto-create wallet for admin operations.
          tx.set(walletRef, {
            uid: req.uid,
            depositBalance: 0, winningBalance: 0, bonusBalance: 0, referralBalance: 0,
            totalBalance: 0,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        const wallet = walletSnap.exists
          ? (walletSnap.data() as WalletDoc)
          : { depositBalance: 0, winningBalance: 0, bonusBalance: 0, referralBalance: 0, totalBalance: 0 } as WalletDoc;

        // ─── action handlers ─────────────────────────────
        if (req.action === 'DEDUCT') {
          const nb = cascadeDeduct(wallet, req.amount);
          if (!nb) return { ok: false, code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' };
          tx.update(walletRef, { ...nb, updatedAt: FieldValue.serverTimestamp() });

        } else if (req.action === 'WITHDRAW') {
          if (req.amount < 100)
            return { ok: false, code: 'BELOW_MIN', message: 'Minimum withdrawal is ₹100' };
          const cur = num(wallet[resolvedBalance] as number);
          if (cur < req.amount)
            return { ok: false, code: 'INSUFFICIENT_BALANCE', message: `Insufficient ${resolvedBalance}` };
          tx.update(walletRef, {
            [resolvedBalance]: FieldValue.increment(-req.amount),
            totalBalance:      FieldValue.increment(-req.amount),
            updatedAt:         FieldValue.serverTimestamp(),
          });

        } else if (req.action === 'ADDFUND') {
          if (req.amount < 50)
            return { ok: false, code: 'BELOW_MIN', message: 'Minimum add fund is ₹50' };
          tx.update(walletRef, {
            depositBalance: FieldValue.increment(req.amount),
            totalBalance:   FieldValue.increment(req.amount),
            updatedAt:      FieldValue.serverTimestamp(),
          });

        } else if (req.action === 'ADD') {
          if (resolvedBalance === 'winningBalance') {
            let bonusB   = num(wallet.bonusBalance);
            let depositB = num(wallet.depositBalance);
            const winB   = num(wallet.winningBalance) + req.amount;
            const conv   = Math.floor(req.amount * BONUS_CONVERSION_RATE);
            if (conv > 0 && bonusB > 0) {
              const actual = Math.min(conv, bonusB);
              bonusB   -= actual;
              depositB += actual;
            }
            tx.update(walletRef, {
              depositBalance: depositB,
              winningBalance: winB,
              bonusBalance:   bonusB,
              totalBalance:   depositB + winB + bonusB + num(wallet.referralBalance),
              updatedAt:      FieldValue.serverTimestamp(),
            });
          } else {
            tx.update(walletRef, {
              [resolvedBalance]: FieldValue.increment(req.amount),
              totalBalance:      FieldValue.increment(req.amount),
              updatedAt:         FieldValue.serverTimestamp(),
            });
          }
        }

        // ─── record transaction ─────────────────────────
        tx.set(txRef, {
          uid: req.uid,
          type: req.type,
          action: req.action,
          amount: req.action === 'DEDUCT' || req.action === 'WITHDRAW'
            ? -Math.abs(req.amount) : Math.abs(req.amount),
          status: req.status || 'COMPLETED',
          game: req.game || 'admin',
          description: req.description || '',
          balanceType: resolvedBalance,
          idempotencyKey: req.idempotencyKey,
          performedBy: req.performedBy,
          metadata: req.metadata || null,
          createdAt: FieldValue.serverTimestamp(),
        });

        // Load fresh wallet to return.
        // (Post-write value not readable inside tx; we read pre-write and compute delta on client side.)
        return { ok: true, txId, wallet, duplicate: false };
      });

      // Read the fresh wallet post-transaction to return latest balances.
      if (result.ok) {
        const fresh = await this.getBalance(req.uid);
        if (fresh) result.wallet = fresh;
      }
      return result;
    } catch (err) {
      logger.error('wallet.execute.error', { error: (err as Error).message, req });
      return { ok: false, code: 'INTERNAL_ERROR', message: (err as Error).message };
    }
  },

  async transactions(uid: string, limit = 20): Promise<Array<Record<string, unknown>>> {
    const q = await db()
      .collection(TX)
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return q.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  // ─── Admin: read/edit transactions ────────────────────────────────────────

  async getTransaction(id: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    const s = await db().collection(TX).doc(id).get();
    return s.exists ? { id: s.id, ...s.data() } : null;
  },

  async listAllTransactions(limit = 30, opts: { uid?: string; type?: WalletTxType; status?: string } = {}): Promise<Array<Record<string, unknown>>> {
    let q: FirebaseFirestore.Query = db().collection(TX);
    if (opts.uid)    q = q.where('uid', '==', opts.uid);
    if (opts.type)   q = q.where('type', '==', opts.type);
    if (opts.status) q = q.where('status', '==', opts.status);
    const snap = await q.orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  /**
   * Admin edits safe metadata on a transaction (status, description, note,
   * metadata). Does NOT touch `amount`, `uid`, or `type` — changing those
   * would desync the wallet. Use `adjustTransaction` for corrective entries.
   */
  async updateTransaction(
    id: string,
    patch: { status?: string; description?: string; note?: string; metadata?: Record<string, unknown> },
    adminId: number | string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = await db().collection(TX).doc(id).get();
    if (!s.exists) return { ok: false, error: 'Transaction not found' };

    const update: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
      lastEditedBy: String(adminId),
    };
    if (patch.status      !== undefined) update.status      = patch.status;
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.note        !== undefined) update.note        = patch.note;
    if (patch.metadata    !== undefined) update.metadata    = { ...(s.data()?.metadata || {}), ...patch.metadata };

    await db().collection(TX).doc(id).set(update, { merge: true });
    logger.info('wallet.tx.updated', { id, adminId, patch });
    return { ok: true };
  },

  /**
   * Corrective adjustment — creates a NEW transaction that adds or deducts
   * `delta` on the same balance type, linked to the original via
   * `metadata.adjustsTxId`. Safer than editing `amount` on the original.
   *
   * If `delta > 0`: credits (ADD). If `delta < 0`: debits (DEDUCT).
   * Idempotency key ensures the same adjustment cannot double-apply.
   */
  async adjustTransaction(
    originalTxId: string,
    delta: number,
    balanceType: WalletBalanceType,
    adminId: number | string,
    reason: string,
  ): Promise<{ ok: true; newTxId?: string } | { ok: false; error: string }> {
    if (!delta || !Number.isFinite(delta)) return { ok: false, error: 'delta must be a non-zero number' };

    const orig = await db().collection(TX).doc(originalTxId).get();
    if (!orig.exists) return { ok: false, error: 'Original transaction not found' };
    const od = orig.data() as { uid?: string; type?: WalletTxType };
    if (!od.uid) return { ok: false, error: 'Original tx missing uid' };

    const res = await this.execute({
      uid:            od.uid,
      action:         delta > 0 ? 'ADD' : 'DEDUCT',
      type:           delta > 0 ? 'ADMIN_DEDUCTION' : 'ADMIN_DEDUCTION', // audited as admin-side
      amount:         Math.abs(delta),
      balanceType,
      description:    `Adjustment for ${originalTxId}: ${reason}`,
      idempotencyKey: `adjust_${originalTxId}_${delta}_${adminId}`,
      performedBy:    String(adminId),
      metadata:       { adjustsTxId: originalTxId, reason },
    });
    if (!res.ok) return { ok: false, error: res.message };

    // Link back on the original so audit trail is complete
    await db().collection(TX).doc(originalTxId).set({
      hasAdjustment: true,
      lastAdjustedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    return { ok: true, newTxId: res.txId };
  },
};
