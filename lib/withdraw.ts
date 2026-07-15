// lib/withdraw.ts
// Matches actual Firestore schema:
//   { amount, createdAt, status: "PENDING"|"APPROVED"|"REJECTED", uid, updatedAt,
//     upiId, userEmail, userName }
// Status is UPPERCASE. Field names use upiId (not destination) and userEmail/userName.

import { db, FieldValue } from './firebase';
import { walletService } from './wallet';
import { adminLogs } from './logs';
import { logger } from './logger';

const COLLECTION = 'withdrawals';

// Status stored in Firestore is UPPERCASE.
export type WithdrawStatusUpper = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PROCESSING' | 'COMPLETED';

export interface WithdrawRequest {
  id: string;
  uid: string;
  amount: number;
  status: WithdrawStatusUpper;
  upiId?: string;
  userEmail?: string;
  userName?: string;
  createdAt: number;
  updatedAt?: number;
  processedAt?: number;
  processedBy?: number;
  rejectReason?: string;
  reservedAtCreation?: boolean;
  balanceType?: 'depositBalance' | 'winningBalance' | 'bonusBalance' | 'referralBalance';
}

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  const anyV = v as { toMillis?: () => number; seconds?: number; _seconds?: number } | undefined;
  if (anyV && typeof anyV.toMillis === 'function') return anyV.toMillis();
  if (anyV && typeof anyV.seconds === 'number')    return anyV.seconds * 1000;
  if (anyV && typeof anyV._seconds === 'number')   return anyV._seconds * 1000;
  return 0;
}

function map(id: string, d: Record<string, unknown>): WithdrawRequest {
  const rawStatus = String(d.status || 'PENDING').toUpperCase() as WithdrawStatusUpper;
  return {
    id,
    uid:                String(d.uid || ''),
    amount:             Number(d.amount || 0),
    status:             rawStatus,
    upiId:              d.upiId as string | undefined,
    userEmail:          d.userEmail as string | undefined,
    userName:           d.userName as string | undefined,
    createdAt:          toMs(d.createdAt),
    updatedAt:          toMs(d.updatedAt) || undefined,
    processedAt:        toMs(d.processedAt) || undefined,
    processedBy:        Number(d.processedBy) || undefined,
    rejectReason:       d.rejectReason as string | undefined,
    reservedAtCreation: Boolean(d.reservedAtCreation),
    balanceType:        (d.balanceType as WithdrawRequest['balanceType']) || 'winningBalance',
  };
}

export const withdrawService = {
  async pending(limit = 10): Promise<WithdrawRequest[]> {
    // Try both cases — some old rows might be lowercase.
    try {
      const q = await db().collection(COLLECTION)
        .where('status', 'in', ['PENDING', 'pending'])
        .orderBy('createdAt', 'desc')
        .limit(limit).get();
      return q.docs.map(d => map(d.id, d.data()));
    } catch (err) {
      logger.warn('withdraw.pending.index_missing', { error: (err as Error).message });
      // Fallback: no orderBy (case where composite index isn't built).
      const q = await db().collection(COLLECTION)
        .where('status', 'in', ['PENDING', 'pending'])
        .limit(limit).get();
      return q.docs.map(d => map(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
    }
  },

  async history(limit = 20): Promise<WithdrawRequest[]> {
    try {
      const q = await db().collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
      return q.docs.map(d => map(d.id, d.data()));
    } catch {
      const q = await db().collection(COLLECTION).limit(limit).get();
      return q.docs.map(d => map(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
    }
  },

  async get(id: string): Promise<WithdrawRequest | null> {
    const s = await db().collection(COLLECTION).doc(id).get();
    return s.exists ? map(s.id, s.data() || {}) : null;
  },

  async approve(id: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const w = await this.get(id);
    if (!w) return { ok: false, error: 'Withdrawal not found' };
    if (w.status !== 'PENDING') return { ok: false, error: `Already ${w.status}` };

    // Deduct from wallet unless already reserved when request was created.
    if (!w.reservedAtCreation) {
      const result = await walletService.execute({
        uid: w.uid,
        action: 'WITHDRAW',
        type: 'WITHDRAWAL',
        amount: w.amount,
        balanceType: w.balanceType || 'winningBalance',
        description: `Withdrawal ${id} approved by admin ${adminId} → UPI ${w.upiId || 'n/a'}`,
        idempotencyKey: `withdraw_${id}_approve`,
        performedBy: String(adminId),
        metadata: { withdrawalId: id, upiId: w.upiId, userEmail: w.userEmail },
      });
      if (!result.ok) {
        await adminLogs.record({
          telegramId: adminId, module: 'withdraw', action: 'approve',
          target: w.uid, amount: w.amount, result: 'failure', errorMessage: result.message,
        });
        return { ok: false, error: result.message };
      }
    }

    await db().collection(COLLECTION).doc(id).set({
      status: 'APPROVED',
      processedAt: Date.now(),
      processedBy: adminId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'withdraw', action: 'approve',
      target: w.uid, amount: w.amount, result: 'success',
      metadata: { withdrawalId: id, upiId: w.upiId },
    });
    logger.info('withdraw.approved', { id, uid: w.uid, amount: w.amount });
    return { ok: true };
  },

  async reject(id: string, adminId: number, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const w = await this.get(id);
    if (!w) return { ok: false, error: 'Withdrawal not found' };
    if (w.status !== 'PENDING') return { ok: false, error: `Already ${w.status}` };

    if (w.reservedAtCreation) {
      const refund = await walletService.execute({
        uid: w.uid,
        action: 'ADD',
        type: 'REFUND',
        amount: w.amount,
        balanceType: w.balanceType || 'winningBalance',
        description: `Withdrawal ${id} rejected — refund: ${reason}`,
        idempotencyKey: `withdraw_${id}_refund`,
        performedBy: String(adminId),
        metadata: { withdrawalId: id },
      });
      if (!refund.ok) return { ok: false, error: `Refund failed: ${refund.message}` };
    }

    await db().collection(COLLECTION).doc(id).set({
      status: 'REJECTED',
      rejectReason: reason,
      processedAt: Date.now(),
      processedBy: adminId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'withdraw', action: 'reject',
      target: w.uid, amount: w.amount, description: reason, result: 'success', metadata: { id },
    });
    return { ok: true };
  },
};
