// lib/redeem.ts
// Redeem codes — aligned with the REAL Firestore schema:
//
//   Collection: redeemCode
//   Doc ID:     the code itself (e.g. "BETADDA61747")
//   Fields:     code, amount, uid, asignBy, status ("ACTIVE"/"USED"/…),
//               used, usedBy, usedByName, usedAt, createdAt
//
// Admin flow:
//   1. Admin picks a user from the deposit-requests list (client UI).
//   2. Admin calls `create({ uid, amount, adminName })` — code is generated
//      and stored, assigned to that uid.
//   3. Admin (or auto) calls `sendEmail(code)` — fetches the user's email
//      from `users/{uid}` and mails the code.
//   4. User redeems on the client → `applyToUser(code, uid)` flips
//      `used=true`, `status='USED'`, and credits the wallet.

import { randomBytes } from 'crypto';
import { db, FieldValue } from './firebase';
import { emailService } from './email';
import { walletService } from './wallet';
import { adminLogs } from './logs';
import { logger } from './logger';

const COLLECTION = 'redeemCode';
const USERS      = 'users';

export type RedeemStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';

export interface RedeemCode {
  code:        string;
  amount:      number;
  uid:         string;         // Firestore uid of the recipient
  asignBy:     string;         // admin's display name (typo intentional — matches real schema)
  status:      RedeemStatus;
  used:        boolean;
  createdAt:   number;         // ms epoch
  usedAt?:     number;
  usedBy?:     string;
  usedByName?: string;

  // Optional extras (not part of the mandatory schema — safe to omit)
  expiresAt?:      number;
  emailSent?:      boolean;
  emailedAt?:      number;
  linkedRequestId?: string;    // deposit request id, if generated from one
  note?:           string;
}

/** BETADDA + 5-digit random number — matches existing code format in screenshot. */
function generateCodeString(): string {
  const n = randomBytes(4).readUInt32BE(0) % 100000;
  return `BETADDA${n.toString().padStart(5, '0')}`;
}

async function fetchUserEmail(uid: string): Promise<string | null> {
  try {
    const snap = await db().collection(USERS).doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data() as { email?: string; userEmail?: string } | undefined;
    return d?.email || d?.userEmail || null;
  } catch (err) {
    logger.error('redeem.fetchUserEmail.failed', { uid, error: (err as Error).message });
    return null;
  }
}

async function fetchUserName(uid: string): Promise<string | null> {
  try {
    const snap = await db().collection(USERS).doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data() as { name?: string; displayName?: string } | undefined;
    return d?.name || d?.displayName || null;
  } catch {
    return null;
  }
}

export const redeemService = {
  /**
   * Create a redeem code for a specific user (from deposit-list selection).
   * `adminName` becomes the `asignBy` field — shown to the user on the code.
   */
  async create(input: {
    uid: string;
    amount: number;
    adminId: number;             // telegram id — for audit logs
    adminName: string;           // display name — stored in `asignBy`
    expiresInDays?: number;
    note?: string;
    linkedRequestId?: string;    // deposit request id, if any
  }): Promise<{ ok: true; code: RedeemCode } | { ok: false; error: string }> {
    if (!input.uid)              return { ok: false, error: 'uid required' };
    if (!input.amount || input.amount <= 0)
                                 return { ok: false, error: 'Amount must be positive' };
    if (!input.adminName)        return { ok: false, error: 'adminName required (goes into asignBy)' };

    const code = generateCodeString();
    const now  = Date.now();

    const doc: RedeemCode = {
      code,
      amount:    Number(input.amount.toFixed(2)),
      uid:       input.uid,
      asignBy:   input.adminName,        // NOTE: matches real Firestore field name (`asignBy`)
      status:    'ACTIVE',
      used:      false,
      createdAt: now,
      ...(input.expiresInDays
        ? { expiresAt: now + input.expiresInDays * 24 * 60 * 60 * 1000 }
        : {}),
      ...(input.note              ? { note: input.note } : {}),
      ...(input.linkedRequestId   ? { linkedRequestId: input.linkedRequestId } : {}),
    };

    const ref = db().collection(COLLECTION).doc(code);
    await ref.set({ ...doc, createdAtServer: FieldValue.serverTimestamp() });

    await adminLogs.record({
      telegramId: input.adminId, module: 'redeem', action: 'create',
      target: input.uid, amount: input.amount, result: 'success',
      metadata: { code, linkedRequestId: input.linkedRequestId },
    });

    return { ok: true, code: doc };
  },

  async list(limit = 20, status?: RedeemStatus): Promise<RedeemCode[]> {
    let q: FirebaseFirestore.Query = db().collection(COLLECTION);
    if (status) q = q.where('status', '==', status);
    const snap = await q.orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data() as RedeemCode);
  },

  async get(code: string): Promise<RedeemCode | null> {
    const s = await db().collection(COLLECTION).doc(code).get();
    return s.exists ? (s.data() as RedeemCode) : null;
  },

  async revoke(code: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await this.get(code);
    if (!r) return { ok: false, error: 'Code not found' };
    if (r.status !== 'ACTIVE') return { ok: false, error: `Code already ${r.status}` };
    await db().collection(COLLECTION).doc(code).set({
      status: 'REVOKED',
      revokedBy: adminId,
      revokedAt: Date.now(),
    }, { merge: true });
    await adminLogs.record({
      telegramId: adminId, module: 'redeem', action: 'revoke',
      target: code, amount: r.amount, result: 'success',
    });
    return { ok: true };
  },

  /**
   * Email the code to the user. The user's email is fetched from
   * `users/{uid}` — we do NOT store email in the redeemCode doc (the
   * real schema doesn't have that field).
   */
  async sendEmail(code: string, adminId: number, siteName?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await this.get(code);
    if (!r) return { ok: false, error: 'Code not found' };
    if (!emailService.isConfigured()) return { ok: false, error: 'EmailJS not configured' };

    const email = await fetchUserEmail(r.uid);
    if (!email) return { ok: false, error: `No email found for user ${r.uid}` };

    const name = await fetchUserName(r.uid);

    const res = await emailService.send({
      toEmail: email,
      toName:  name || email,
      subject: `Your BetAdda Redeem Code — ₹${r.amount.toFixed(2)}`,
      templateParams: {
        redeem_code:  r.code,
        code:         r.code,
        amount:       r.amount.toFixed(2),
        amount_inr:   `₹${r.amount.toFixed(2)}`,
        expires_at:   r.expiresAt
          ? new Date(r.expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
          : 'No expiry',
        site_name:    siteName || 'BetAdda',
        assigned_by:  r.asignBy,
        message:      `Your redeem code is ${r.code} worth ₹${r.amount.toFixed(2)}. Use it in your BetAdda wallet.`,
      },
    });

    if (!res.ok) {
      await adminLogs.record({
        telegramId: adminId, module: 'redeem', action: 'email',
        target: code, amount: r.amount, result: 'failure', errorMessage: res.error,
      });
      return res;
    }

    await db().collection(COLLECTION).doc(code).set({
      emailSent: true, emailedAt: Date.now(),
    }, { merge: true });

    await adminLogs.record({
      telegramId: adminId, module: 'redeem', action: 'email',
      target: email, amount: r.amount, result: 'success', metadata: { code, uid: r.uid },
    });
    return { ok: true };
  },

  /**
   * Race-safe two-phase apply. Phase 1 (transaction) atomically claims the
   * code by flipping status → USED and used → true, but ONLY if it was still
   * ACTIVE at read time. Phase 2 credits the wallet.
   *
   * Two concurrent applies (e.g. client + admin panel) — only one wins the
   * transaction; the other throws "Code already USED" BEFORE any wallet
   * mutation, so no double-credit is possible even if the wallet's own
   * idempotency check were bypassed.
   *
   * `performedByLabel` is what shows up in the transaction log
   * (`displayName` for user apply, `Admin{id}` for admin apply).
   */
  async _claimAndCredit(input: {
    code: string;
    expectedUid?: string;      // if set, throws when doc.uid !== expectedUid
    performedByLabel: string;
    performedByUid: string;
    usedByName: string;
    description: string;
  }): Promise<{ ok: true; amount: number } | { ok: false; error: string }> {
    const codeRef = db().collection(COLLECTION).doc(input.code);

    // Phase 1 — atomic claim
    let claimed: { amount: number; uid: string };
    try {
      claimed = await db().runTransaction(async (tx) => {
        const snap = await tx.get(codeRef);
        if (!snap.exists) throw new Error('Code not found');
        const d = snap.data() as RedeemCode;

        if (d.status === 'REVOKED')  throw new Error('Code has been revoked');
        if (d.status === 'EXPIRED')  throw new Error('Code has expired');
        if (d.status === 'USED' || d.used) throw new Error('Code already used');
        if (d.status !== 'ACTIVE')   throw new Error(`Code is ${d.status}`);
        if (d.expiresAt && d.expiresAt < Date.now()) throw new Error('Code expired');

        if (input.expectedUid && d.uid !== input.expectedUid) {
          throw new Error('This code is not assigned to your account');
        }

        tx.update(codeRef, {
          status:     'USED',
          used:       true,
          usedAt:     Date.now(),
          usedBy:     input.performedByUid,
          usedByName: input.usedByName,
        });
        return { amount: d.amount, uid: d.uid };
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    // Phase 2 — credit wallet. If this fails, roll the claim back so the
    // admin/user can retry cleanly. Idempotency key protects against
    // double-credit from wallet-level retries.
    const wallet = await walletService.execute({
      uid:            claimed.uid,
      action:         'ADD',
      type:           'REDEEM_CODE',
      amount:         claimed.amount,
      balanceType:    'depositBalance',
      description:    input.description,
      idempotencyKey: `redeem_${input.code}`,
      performedBy:    input.performedByLabel,
      metadata:       { code: input.code },
    });

    if (!wallet.ok) {
      // Roll back the claim so the code becomes ACTIVE again.
      await codeRef.set({
        status: 'ACTIVE', used: false, usedAt: null, usedBy: '', usedByName: '',
      }, { merge: true }).catch(err => {
        logger.error('redeem.rollback.failed', { code: input.code, error: (err as Error).message });
      });
      return { ok: false, error: wallet.message };
    }

    return { ok: true, amount: claimed.amount };
  },

  /**
   * User redeems the code on the client. Race-safe (transactional claim).
   */
  async applyToUser(code: string, redeemingUid: string, redeemingName?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await this._claimAndCredit({
      code,
      expectedUid:      redeemingUid,
      performedByLabel: redeemingName || redeemingUid,
      performedByUid:   redeemingUid,
      usedByName:       redeemingName || '',
      description:      `Redeem code ${code}`,
    });
    if (!r.ok) return r;
    logger.info('redeem.applied', { code, uid: redeemingUid, amount: r.amount });
    return { ok: true };
  },

  /**
   * Admin-triggered manual apply — same claim path, no uid check.
   * If the user already applied this code, admin will now get a clean
   * "Code already used" error (previously would have double-credited).
   */
  async adminApply(code: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    // Look up target uid + name BEFORE the transaction — we don't have them
    // otherwise (adminApply credits whoever the code was originally assigned to).
    const preview = await this.get(code);
    if (!preview) return { ok: false, error: 'Code not found' };
    const name = await fetchUserName(preview.uid);

    const r = await this._claimAndCredit({
      code,
      performedByLabel: `Admin${adminId}`,
      performedByUid:   preview.uid,
      usedByName:       name || '',
      description:      `Redeem code ${code} applied by admin`,
    });
    if (!r.ok) return r;

    await adminLogs.record({
      telegramId: adminId, module: 'redeem', action: 'apply',
      target: preview.uid, amount: r.amount, result: 'success', metadata: { code },
    });
    return { ok: true };
  },
};
