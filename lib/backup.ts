// lib/backup.ts
// Full-database export/import for account transfer, driven from Telegram.
// Backup format matches scripts/export.js: Timestamps → { __type: 'timestamp', ms }.

import * as admin from 'firebase-admin';
import { db } from './firebase';
import { config } from './config';
import { logger } from './logger';

export const BACKUP_COLLECTIONS = [
  'users',
  'wallets',
  'transactions',
  'deposits',
  'withdrawals',
  'redeemCode',
  'admin_logs',
  'admin_prefs',
  'admin_sessions',
  'admin_idempotency',
  'pokerTables',
  'ludoTables',
  'jokerPairTables',
  'nineCardTables',
  'tambolaTables',
  'poker_tables',
];

const PAGE = 500;          // docs per read page
const WRITE_BATCH = 400;   // Firestore batch limit is 500 — stay under
const MAX_EXPORT_BYTES = 45 * 1024 * 1024; // Telegram bot upload cap is 50 MB

// Transient state — exported for completeness, but never restored:
// importing admin_sessions would clobber the live confirm-flow session.
const SKIP_ON_IMPORT = new Set(['admin_sessions', 'admin_idempotency']);

export interface BackupManifest {
  projectId: string;
  exportedAt: string;
  collections: Record<string, number>;
}

export interface CombinedBackup {
  manifest: BackupManifest;
  collections: Record<string, Record<string, unknown>>;
}

// ─── Value (de)serialization ────────────────────────────────────────────────
function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', ms: value.toMillis() };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geopoint', lat: value.latitude, lng: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type: 'ref', path: value.path };
  }
  if (Buffer.isBuffer(value)) {
    return { __type: 'bytes', base64: value.toString('base64') };
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialize(v);
    return out;
  }
  return value;
}

function deserialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deserialize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.__type === 'timestamp' && typeof obj.ms === 'number') {
      return admin.firestore.Timestamp.fromMillis(obj.ms);
    }
    if (obj.__type === 'geopoint' && typeof obj.lat === 'number' && typeof obj.lng === 'number') {
      return new admin.firestore.GeoPoint(obj.lat, obj.lng);
    }
    if (obj.__type === 'ref' && typeof obj.path === 'string') {
      return db().doc(obj.path);
    }
    if (obj.__type === 'bytes' && typeof obj.base64 === 'string') {
      return Buffer.from(obj.base64, 'base64');
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deserialize(v);
    return out;
  }
  return value;
}

// ─── Service ────────────────────────────────────────────────────────────────
export const backupService = {
  /** Read every collection and build one combined JSON backup. */
  async exportAll(): Promise<{ json: string; totalDocs: number; perCollection: Record<string, number> }> {
    const collections: Record<string, Record<string, unknown>> = {};
    const perCollection: Record<string, number> = {};
    let totalDocs = 0;

    for (const coll of BACKUP_COLLECTIONS) {
      const docs: Record<string, unknown> = {};
      let count = 0;
      let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;

      for (;;) {
        let q: FirebaseFirestore.Query = db().collection(coll).orderBy('__name__').limit(PAGE);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          docs[d.id] = serialize(d.data());
          count++;
        }
        last = snap.docs[snap.docs.length - 1]!;
        if (snap.size < PAGE) break;
      }

      if (count > 0) collections[coll] = docs;
      perCollection[coll] = count;
      totalDocs += count;
    }

    const backup: CombinedBackup = {
      manifest: {
        projectId: config.firebase.projectId,
        exportedAt: new Date().toISOString(),
        collections: perCollection,
      },
      collections,
    };

    const json = JSON.stringify(backup);
    if (json.length > MAX_EXPORT_BYTES) {
      throw new Error(
        `Backup bahut bada hai (${Math.round(json.length / 1024 / 1024)} MB). PC par scripts/export.js use karo.`
      );
    }
    logger.info('backup.export.done', { totalDocs, bytes: json.length });
    return { json, totalDocs, perCollection };
  },

  /** Validate an uploaded backup and return its summary (throws if invalid). */
  inspect(json: string): { manifest: BackupManifest; total: number; nonEmpty: Array<[string, number]> } {
    let parsed: unknown;
    try { parsed = JSON.parse(json); }
    catch { throw new Error('File valid JSON nahi hai.'); }

    const b = parsed as CombinedBackup;
    if (!b || typeof b !== 'object' || !b.manifest || !b.collections || typeof b.collections !== 'object') {
      throw new Error('Yeh backup file nahi lagti — Export se mili JSON file hi bhejo.');
    }
    let total = 0;
    const nonEmpty: Array<[string, number]> = [];
    for (const [coll, docs] of Object.entries(b.collections)) {
      const n = Object.keys(docs || {}).length;
      total += n;
      if (n > 0) nonEmpty.push([coll, n]);
    }
    if (total === 0) throw new Error('Backup file khali hai (0 docs).');
    return { manifest: b.manifest, total, nonEmpty };
  },

  /**
   * Restore a combined backup.
   * merge-safe by default: existing docs are skipped. overwrite=true replaces them.
   */
  async importAll(json: string, overwrite: boolean): Promise<{ written: number; skipped: number; perCollection: Record<string, string> }> {
    const b = JSON.parse(json) as CombinedBackup;
    let written = 0;
    let skipped = 0;
    const perCollection: Record<string, string> = {};

    for (const [coll, docs] of Object.entries(b.collections)) {
      if (SKIP_ON_IMPORT.has(coll)) { perCollection[coll] = 'skipped (transient)'; continue; }
      const ids = Object.keys(docs || {});
      if (ids.length === 0) continue;
      let collWritten = 0;
      let collSkipped = 0;

      for (let i = 0; i < ids.length; i += WRITE_BATCH) {
        const chunk = ids.slice(i, i + WRITE_BATCH);

        let existing = new Set<string>();
        if (!overwrite) {
          const refs = chunk.map(id => db().collection(coll).doc(id));
          const snaps = await db().getAll(...refs);
          existing = new Set(snaps.filter(s => s.exists).map(s => s.id));
        }

        const batch = db().batch();
        let inBatch = 0;
        for (const id of chunk) {
          if (existing.has(id)) { collSkipped++; continue; }
          batch.set(db().collection(coll).doc(id), deserialize(docs[id]) as Record<string, unknown>);
          inBatch++;
        }
        if (inBatch > 0) await batch.commit();
        collWritten += inBatch;
      }

      written += collWritten;
      skipped += collSkipped;
      perCollection[coll] = `${collWritten} written${collSkipped ? `, ${collSkipped} skipped` : ''}`;
    }

    logger.info('backup.import.done', { written, skipped, overwrite });
    return { written, skipped, perCollection };
  },
};
