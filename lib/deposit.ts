// lib/deposit.ts
// Add-Fund request workflow — aligned with actual `deposits` schema:
//   { amount, createdAt, screenshotUrl, status ("PENDING"|"APPROVED"|"REJECTED"|"CODE_SENT"),
//     uid, updatedAt, userEmail, userName, utrNumber, adminNote (rejection reason) }
// Status is UPPERCASE. Reject reason goes to `adminNote`.

import { db, FieldValue } from './firebase';
import { walletService } from './wallet';
import { redeemService } from './redeem';
import { adminLogs } from './logs';
import { logger } from './logger';
import { makeIdempotencyKey } from './utils';

const COLLECTION = 'deposits';

export type AddFundStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CODE_SENT';

export interface AddFundRequest {
  id: string;
  uid: string;
  userEmail?: string;
  userName?: string;
  amount: number;
  utrNumber?: string;
  screenshotUrl?: string;
  status: AddFundStatus;
  createdAt: number;
  updatedAt?: number;
  processedAt?: number;
  processedBy?: number;
  adminNote?: string;      // rejection reason lives here
  walletTxId?: string;
  redeemCode?: string;
}

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  const anyV = v as { toMillis?: () => number; seconds?: number; _seconds?: number } | undefined;
  if (anyV && typeof anyV.toMillis === 'function') return anyV.toMillis();
  if (anyV && typeof anyV.seconds === 'number')    return anyV.seconds * 1000;
  if (anyV && typeof anyV._seconds === 'number')   return anyV._seconds * 1000;
  return 0;
}

function map(id: string, d: Record<string, unknown>): AddFundRequest {
  return {
    id,
    uid:           String(d.uid || ''),
    userEmail:     (d.userEmail as string) || (d.email as string),
    userName:      (d.userName as string) || (d.name as string),
    amount:        Number(d.amount || 0),
    utrNumber:     d.utrNumber as string | undefined,
    screenshotUrl: (d.screenshotUrl || d.screenshot) as string | undefined,
    status:        String(d.status || 'PENDING').toUpperCase() as AddFundStatus,
    createdAt:     toMs(d.createdAt),
    updatedAt:     toMs(d.updatedAt) || undefined,
    processedAt:   toMs(d.processedAt) || undefined,
    processedBy:   Number(d.processedBy) || undefined,
    adminNote:     (d.adminNote as string) || (d.rejectReason as string),
    walletTxId:    d.walletTxId as string | undefined,
    redeemCode:    d.redeemCode as string | undefined,
  };
}

export const depositService = {
  async pending(limit = 10): Promise<AddFundRequest[]> {
    try {
      const q = await db().collection(COLLECTION)
        .where('status', 'in', ['PENDING', 'pending'])
        .orderBy('createdAt', 'desc').limit(limit).get();
      return q.docs.map(d => map(d.id, d.data()));
    } catch (err) {
      logger.warn('deposit.pending.index_missing', { error: (err as Error).message });
      const q = await db().collection(COLLECTION)
        .where('status', 'in', ['PENDING', 'pending'])
        .limit(limit).get();
      return q.docs.map(d => map(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
    }
  },

  async history(limit = 20): Promise<AddFundRequest[]> {
    try {
      const q = await db().collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
      return q.docs.map(d => map(d.id, d.data()));
    } catch {
      const q = await db().collection(COLLECTION).limit(limit).get();
      return q.docs.map(d => map(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
    }
  },

  async get(id: string): Promise<AddFundRequest | null> {
    const s = await db().collection(COLLECTION).doc(id).get();
    return s.exists ? map(s.id, s.data() || {}) : null;
  },

  /** Directly credit user's deposit balance. */
  async approveDirect(id: string, adminId: number): Promise<{ ok: true; txId: string } | { ok: false; error: string }> {
    const r = await this.get(id);
    if (!r) return { ok: false, error: 'Request not found' };
    if (r.status !== 'PENDING') return { ok: false, error: `Already ${r.status}` };

    const result = await walletService.execute({
      uid: r.uid,
      action: 'ADDFUND',
      type: 'ADD_MONEY',
      amount: r.amount,
      balanceType: 'depositBalance',
      description: `Add-fund #${id} approved by admin ${adminId}`,
      idempotencyKey: `addfund_${id}_approve`,
      performedBy: String(adminId),
      metadata: { requestId: id, utrNumber: r.utrNumber, userEmail: r.userEmail },
    });
    if (!result.ok) {
      await adminLogs.record({
        telegramId: adminId, module: 'deposit', action: 'approve_direct',
        target: r.uid, amount: r.amount, result: 'failure', errorMessage: result.message,
      });
      return { ok: false, error: result.message };
    }

    await db().collection(COLLECTION).doc(id).set({
      status: 'APPROVED',
      processedAt: Date.now(),
      processedBy: String(adminId),
      walletTxId: result.txId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'deposit', action: 'approve_direct',
      target: r.uid, amount: r.amount, result: 'success', metadata: { id, txId: result.txId },
    });
    logger.info('addfund.approved_direct', { id, uid: r.uid, amount: r.amount });
    return { ok: true, txId: result.txId };
  },

  /** Approve by generating a redeem code and (optionally) emailing it. */
  async approveWithRedeemCode(
    id: string,
    adminId: number,
    opts: { sendEmail: boolean; expiresInDays?: number; adminName?: string } = { sendEmail: true, expiresInDays: 7 },
  ): Promise<{ ok: true; code: string; emailed: boolean } | { ok: false; error: string }> {
    const r = await this.get(id);
    if (!r) return { ok: false, error: 'Request not found' };
    if (r.status !== 'PENDING') return { ok: false, error: `Already ${r.status}` };

    const created = await redeemService.create({
      amount: r.amount,
      uid: r.uid,
      adminId,
      adminName: opts.adminName || `Admin${adminId}`,
      expiresInDays: opts.expiresInDays ?? 7,
      note: `Add-fund request ${id}${r.utrNumber ? ' (UTR ' + r.utrNumber + ')' : ''}`,
      linkedRequestId: id,
    });
    if (!created.ok) return { ok: false, error: created.error };

    let emailed = false;
    // sendEmail auto-fetches email from users/{uid}, so we no longer need r.userEmail here
    if (opts.sendEmail) {
      const em = await redeemService.sendEmail(created.code.code, adminId);
      emailed = em.ok;
      if (!em.ok) logger.warn('addfund.email.failed', { id, error: em.error });
    }

    await db().collection(COLLECTION).doc(id).set({
      status: 'CODE_SENT',
      processedAt: Date.now(),
      processedBy: String(adminId),
      redeemCode: created.code.code,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'deposit', action: 'approve_code',
      target: r.uid, amount: r.amount, result: 'success',
      metadata: { id, code: created.code.code, emailed },
    });
    return { ok: true, code: created.code.code, emailed };
  },

  async reject(id: string, adminId: number, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await this.get(id);
    if (!r) return { ok: false, error: 'Request not found' };
    if (r.status !== 'PENDING') return { ok: false, error: `Already ${r.status}` };

    await db().collection(COLLECTION).doc(id).set({
      status: 'REJECTED',
      adminNote: reason,
      processedAt: Date.now(),
      processedBy: String(adminId),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'deposit', action: 'reject',
      target: r.uid, amount: r.amount, description: reason, result: 'success', metadata: { id },
    });
    return { ok: true };
  },
};

export { makeIdempotencyKey };
