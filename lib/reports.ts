// lib/reports.ts
// Aggregate reports. Uses simple queries (no complex indexes needed).
// Handles both numeric-ms `createdAt` and Firestore Timestamp `createdAt`.

import { db } from './firebase';

const RANGES = { '24h': 86400_000, '7d': 604800_000, '30d': 2592000_000 } as const;
export type ReportRange = keyof typeof RANGES;

export interface UsersReport    { total: number; banned: number; active: number; newInRange: number; }
export interface RevenueReport  { totalDeposits: number; totalWithdrawals: number; net: number; count: { deposits: number; withdrawals: number }; }
export interface DepositReport  { pending: number; approvedInRange: number; totalInRange: number; }
export interface WithdrawReport { pending: number; approvedInRange: number; totalInRange: number; }
export interface WalletReport   { totalWallets: number; totalBalance: number; avgBalance: number; }
export interface GamesReport    {
  poker: { total: number; running: number };
  ludo:  { total: number; running: number };
  joker: { total: number; running: number };
  ninecard: { total: number; running: number };
  tambola:  { total: number; running: number };
}

// Firestore Timestamp shape check
function toMillis(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const anyV = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof anyV.toMillis === 'function') return anyV.toMillis();
    if (typeof anyV.seconds === 'number')    return anyV.seconds * 1000;
    if (typeof anyV._seconds === 'number')   return anyV._seconds * 1000;
  }
  return 0;
}

async function collectAllInRange(
  collection: string,
  cutoffMs: number,
  extraFilter?: (data: Record<string, unknown>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  // Cap at 500 docs per report to stay within limits.
  const snap = await db().collection(collection).limit(500).get();
  const out: Array<Record<string, unknown>> = [];
  snap.forEach(d => {
    const data = d.data();
    const t = toMillis(data.createdAt) || toMillis(data.processedAt);
    if (t < cutoffMs) return;
    if (extraFilter && !extraFilter(data)) return;
    out.push({ id: d.id, ...data });
  });
  return out;
}

async function safeCount(collection: string, where?: [string, FirebaseFirestore.WhereFilterOp, unknown]): Promise<number> {
  try {
    let q: FirebaseFirestore.Query = db().collection(collection);
    if (where) q = q.where(where[0], where[1], where[2]);
    const c = await q.count().get();
    return c.data().count;
  } catch {
    // Fallback if count() unavailable in the region.
    const snap = await (where
      ? db().collection(collection).where(where[0], where[1], where[2]).limit(1000).get()
      : db().collection(collection).limit(1000).get());
    return snap.size;
  }
}

export const reportsService = {
  async users(range: ReportRange = '30d'): Promise<UsersReport> {
    const cutoff = Date.now() - RANGES[range];
    const total  = await safeCount('users');
    const banned = await safeCount('users', ['status', '==', 'banned']);
    const rows   = await collectAllInRange('users', cutoff);
    return { total, banned, active: Math.max(0, total - banned), newInRange: rows.length };
  },

  async revenue(range: ReportRange = '30d'): Promise<RevenueReport> {
    const cutoff = Date.now() - RANGES[range];
    // Deposits approved — checks both `deposits` and `addfund_requests`, case-insensitive.
    const isApproved = (d: Record<string, unknown>) => {
      const s = String(d.status || '').toUpperCase();
      return s === 'APPROVED' || s === 'CODE_SENT' || s === 'COMPLETED';
    };
    const [depA, depB] = await Promise.all([
      collectAllInRange('deposits',        cutoff, isApproved),
      collectAllInRange('addfund_requests',cutoff, isApproved),
    ]);
    const wdRows = await collectAllInRange('withdrawals', cutoff, isApproved);

    let totalDeposits = 0;
    [...depA, ...depB].forEach(d => { totalDeposits += Number(d.amount || 0); });
    let totalWithdrawals = 0;
    wdRows.forEach(d => { totalWithdrawals += Number(d.amount || 0); });

    return {
      totalDeposits, totalWithdrawals,
      net: totalDeposits - totalWithdrawals,
      count: { deposits: depA.length + depB.length, withdrawals: wdRows.length },
    };
  },

  async deposits(range: ReportRange = '30d'): Promise<DepositReport> {
    const cutoff = Date.now() - RANGES[range];
    const isPending  = (d: Record<string, unknown>) => String(d.status || '').toUpperCase() === 'PENDING';
    const isApproved = (d: Record<string, unknown>) => {
      const s = String(d.status || '').toUpperCase();
      return s === 'APPROVED' || s === 'CODE_SENT' || s === 'COMPLETED';
    };
    const [pendA, pendB] = await Promise.all([
      collectAllInRange('deposits',         Date.now() - RANGES['30d'] * 12, isPending),
      collectAllInRange('addfund_requests', Date.now() - RANGES['30d'] * 12, isPending),
    ]);
    const approvedRows = [
      ...await collectAllInRange('deposits',        cutoff, isApproved),
      ...await collectAllInRange('addfund_requests',cutoff, isApproved),
    ];
    const totalRows = [
      ...await collectAllInRange('deposits',        cutoff),
      ...await collectAllInRange('addfund_requests',cutoff),
    ];
    return {
      pending: pendA.length + pendB.length,
      approvedInRange: approvedRows.length,
      totalInRange: totalRows.length,
    };
  },

  async withdrawals(range: ReportRange = '30d'): Promise<WithdrawReport> {
    const cutoff = Date.now() - RANGES[range];
    const isPending  = (d: Record<string, unknown>) => String(d.status || '').toUpperCase() === 'PENDING';
    const isApproved = (d: Record<string, unknown>) => {
      const s = String(d.status || '').toUpperCase();
      return s === 'APPROVED' || s === 'COMPLETED';
    };
    const pendingRows  = await collectAllInRange('withdrawals', Date.now() - RANGES['30d'] * 12, isPending);
    const approvedRows = await collectAllInRange('withdrawals', cutoff, isApproved);
    const totalRows    = await collectAllInRange('withdrawals', cutoff);
    return { pending: pendingRows.length, approvedInRange: approvedRows.length, totalInRange: totalRows.length };
  },

  async wallets(): Promise<WalletReport> {
    const q = await db().collection('wallets').limit(1000).get();
    let totalBalance = 0;
    q.forEach(d => { totalBalance += Number((d.data() as { totalBalance?: number }).totalBalance || 0); });
    return { totalWallets: q.size, totalBalance, avgBalance: q.size > 0 ? totalBalance / q.size : 0 };
  },

  async games(): Promise<GamesReport> {
    async function stats(coll: string): Promise<{ total: number; running: number }> {
      const total   = await safeCount(coll);
      const running = await safeCount(coll, ['status', 'in', ['playing', 'waiting'] as unknown as string]);
      // Firestore `in` requires array — safeCount already handles fallback.
      return { total, running };
    }
    // Use a smarter fallback for `running` since `in` in safeCount needs work — do it explicitly.
    async function runningCount(coll: string): Promise<number> {
      try {
        const q = await db().collection(coll).where('status', 'in', ['playing', 'waiting']).count().get();
        return q.data().count;
      } catch {
        const snap = await db().collection(coll).limit(500).get();
        let n = 0;
        snap.forEach(d => { const s = (d.data() as { status?: string }).status; if (s === 'playing' || s === 'waiting') n++; });
        return n;
      }
    }
    async function totalCount(coll: string): Promise<number> {
      try {
        const q = await db().collection(coll).count().get();
        return q.data().count;
      } catch {
        const snap = await db().collection(coll).limit(1000).get();
        return snap.size;
      }
    }
    // NOTE: collection names games.ts ke COLLECTION_MAP se match hone chahiye
    // (camelCase) — pehle snake_case the jo kabhi exist hi nahi karte (hamesha 0)
    const [pt, pr, lt, lr, jt, jr, nt, nr, tt, tr] = await Promise.all([
      totalCount('pokerTables'),    runningCount('pokerTables'),
      totalCount('ludoTables'),     runningCount('ludoTables'),
      totalCount('jokerPairTables'),runningCount('jokerPairTables'),
      totalCount('nineCardTables'), runningCount('nineCardTables'),
      totalCount('tambolaTables'),  runningCount('tambolaTables'),
    ]);
    return {
      poker:    { total: pt, running: pr },
      ludo:     { total: lt, running: lr },
      joker:    { total: jt, running: jr },
      ninecard: { total: nt, running: nr },
      tambola:  { total: tt, running: tr },
    };
  },
};
