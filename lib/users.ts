// lib/users.ts
// Matches actual Firestore schema:
//   { uid, name, email, phone, photoURL, isBanned, isAdmin, isOnline,
//     role, referralCode, referredBy, createdAt, updatedAt }
// Ban/unban uses the boolean `isBanned` field (not `status`).

import { db, auth, FieldValue } from './firebase';
import { walletService } from './wallet';
import { logger } from './logger';
import { isEmail, isPhone } from './validators';
import type { UserRecord, UserStatus } from '../types/user';

const COLLECTION = 'users';

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  const anyV = v as { toMillis?: () => number; seconds?: number; _seconds?: number } | undefined;
  if (anyV && typeof anyV.toMillis === 'function') return anyV.toMillis();
  if (anyV && typeof anyV.seconds === 'number')    return anyV.seconds * 1000;
  if (anyV && typeof anyV._seconds === 'number')   return anyV._seconds * 1000;
  return 0;
}

function mapUser(uid: string, d: Record<string, unknown>): UserRecord {
  const banned = Boolean(d.isBanned) || Boolean(d.disabled);
  const status: UserStatus = banned ? 'banned' : 'active';
  return {
    uid,
    displayName: (d.name as string) || (d.displayName as string) || (d.fullName as string),
    email:       d.email as string | undefined,
    phone:       (d.phone as string) || (d.phoneNumber as string),
    photoURL:    d.photoURL as string | undefined,
    status,
    createdAt:   toMs(d.createdAt),
    lastLoginAt: toMs(d.lastLoginAt) || toMs(d.updatedAt) || undefined,
    isAdmin:     Boolean(d.isAdmin),
    banReason:   (d.banReason as string) || (d.adminNote as string) || undefined,
    banAt:       toMs(d.banAt) || undefined,
  };
}

export const usersService = {
  async findByUid(uid: string): Promise<UserRecord | null> {
    const snap = await db().collection(COLLECTION).doc(uid).get();
    if (snap.exists) return mapUser(snap.id, snap.data() || {});
    // Fallback to Firebase Auth for accounts not mirrored to Firestore.
    try {
      const u = await auth().getUser(uid);
      return {
        uid: u.uid,
        displayName: u.displayName,
        email: u.email,
        phone: u.phoneNumber,
        photoURL: u.photoURL,
        status: u.disabled ? 'banned' : 'active',
        createdAt: Date.parse(u.metadata.creationTime) || 0,
        lastLoginAt: u.metadata.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) : undefined,
      };
    } catch { return null; }
  },

  async findByEmail(email: string): Promise<UserRecord | null> {
    const q = await db().collection(COLLECTION).where('email', '==', email).limit(1).get();
    if (!q.empty) { const d = q.docs[0]!; return mapUser(d.id, d.data()); }
    try {
      const u = await auth().getUserByEmail(email);
      return this.findByUid(u.uid);
    } catch { return null; }
  },

  async findByPhone(phone: string): Promise<UserRecord | null> {
    const q = await db().collection(COLLECTION).where('phone', '==', phone).limit(1).get();
    if (!q.empty) { const d = q.docs[0]!; return mapUser(d.id, d.data()); }
    try {
      const u = await auth().getUserByPhoneNumber(phone);
      return this.findByUid(u.uid);
    } catch { return null; }
  },

  async search(query: string): Promise<UserRecord | null> {
    const q = query.trim();
    if (!q) return null;
    if (isEmail(q)) return this.findByEmail(q);
    if (isPhone(q)) return this.findByPhone(q);
    return this.findByUid(q);
  },

  async ban(uid: string, reason: string, adminId: number): Promise<void> {
    await db().collection(COLLECTION).doc(uid).set({
      isBanned: true,
      banReason: reason,
      banAt: Date.now(),
      bannedBy: String(adminId),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    try { await auth().updateUser(uid, { disabled: true }); }
    catch (err) { logger.warn('users.ban.auth_update_failed', { uid, error: (err as Error).message }); }
  },

  async unban(uid: string, adminId: number): Promise<void> {
    await db().collection(COLLECTION).doc(uid).set({
      isBanned: false,
      banReason: FieldValue.delete(),
      banAt: FieldValue.delete(),
      unbannedBy: String(adminId),
      unbanAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    try { await auth().updateUser(uid, { disabled: false }); }
    catch (err) { logger.warn('users.unban.auth_update_failed', { uid, error: (err as Error).message }); }
  },

  async updateField(uid: string, field: 'displayName' | 'email' | 'phone', value: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      // Map our normalized field → actual Firestore field.
      const fsField = field === 'displayName' ? 'name' : field;
      await db().collection(COLLECTION).doc(uid).set({
        [fsField]: value,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // Mirror to Firebase Auth where possible.
      if (field === 'displayName') await auth().updateUser(uid, { displayName: value }).catch(() => {});
      if (field === 'email')       await auth().updateUser(uid, { email: value }).catch(() => {});
      if (field === 'phone')       await auth().updateUser(uid, { phoneNumber: value }).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async remove(uid: string, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await db().collection(COLLECTION).doc(uid).delete();
      await auth().deleteUser(uid).catch(() => {});
      logger.info('users.deleted', { uid, adminId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async recentTransactions(uid: string, limit = 10): Promise<Array<Record<string, unknown>>> {
    return walletService.transactions(uid, limit);
  },

  async recentGames(uid: string, limit = 10): Promise<Array<{ id: string; game: string; result: string; amount: number; at: number }>> {
    for (const c of ['bethistory', 'game_results']) {
      try {
        const q = await db().collection(c).where('uid', '==', uid).orderBy('createdAt', 'desc').limit(limit).get();
        if (q.size > 0) {
          return q.docs.map(d => {
            const data = d.data();
            return {
              id: d.id,
              game:   String(data.game || data.tableName || 'unknown'),
              result: String(data.type || data.result || ''),
              amount: Number(data.amount || 0),
              at:     toMs(data.createdAt),
            };
          });
        }
      } catch { /* try next */ }
    }
    return [];
  },
};
