// scripts/_common.js
// Shared helpers for export/import: .env loader, Firebase init, value (de)serialization.

const fs = require('fs');
const path = require('path');

// ─── Tiny .env parser (no dotenv dependency needed) ─────────────────────────
function loadEnv(file) {
  const envPath = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(envPath)) return null;
  const out = {};
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// ─── Firebase Admin init from a given env map ────────────────────────────────
function initFirebase(env, appName) {
  const admin = require('firebase-admin');
  const projectId = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  let privateKey = env.FIREBASE_PRIVATE_KEY || '';
  privateKey = privateKey.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.error('❌ Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY');
    process.exit(1);
  }

  const app = admin.initializeApp(
    {
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      projectId,
    },
    appName
  );
  const db = app.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return { admin, app, db, projectId };
}

// ─── Serialize Firestore values → plain JSON ─────────────────────────────────
// Timestamps become { __type: 'timestamp', ms: <epoch millis> } so import can
// restore them as real Timestamp objects.
function serialize(value, admin) {
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
  if (Array.isArray(value)) return value.map(v => serialize(v, admin));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v, admin);
    return out;
  }
  return value;
}

// ─── Deserialize plain JSON → Firestore values ───────────────────────────────
function deserialize(value, admin, db) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => deserialize(v, admin, db));
  if (typeof value === 'object') {
    if (value.__type === 'timestamp') return admin.firestore.Timestamp.fromMillis(value.ms);
    if (value.__type === 'geopoint') return new admin.firestore.GeoPoint(value.lat, value.lng);
    if (value.__type === 'ref') return db.doc(value.path);
    if (value.__type === 'bytes') return Buffer.from(value.base64, 'base64');
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deserialize(v, admin, db);
    return out;
  }
  return value;
}

module.exports = { loadEnv, initFirebase, serialize, deserialize };
