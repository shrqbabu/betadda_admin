// scripts/export.js
// Full Firestore backup → backup/ folder (one JSON file per collection).
//
// Usage:
//   node scripts/export.js                 → uses .env
//   node scripts/export.js --env .env.old  → use a specific env file
//
// Output: backup/<timestamp>/<collection>.json + manifest.json

const fs = require('fs');
const path = require('path');
const { loadEnv, initFirebase, serialize } = require('./_common');

// All collections used by this project (from lib/*.ts)
const COLLECTIONS = [
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

const BATCH = 500; // docs per page while reading

async function main() {
  const argv = process.argv.slice(2);
  const envFile = argv.includes('--env') ? argv[argv.indexOf('--env') + 1] : '.env';

  const env = loadEnv(envFile);
  if (!env) {
    console.error(`❌ ${envFile} nahi mila. Pehle .env banao (FIREBASE_* keys ke saath).`);
    process.exit(1);
  }

  const { admin, db, projectId } = initFirebase(env, 'export-app');
  console.log(`📦 Export shuru — Firebase project: ${projectId}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(__dirname, '..', 'backup', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = { projectId, exportedAt: new Date().toISOString(), collections: {} };
  let totalDocs = 0;

  for (const coll of COLLECTIONS) {
    const docs = {};
    let count = 0;
    let last = null;

    // Page through the collection so big collections don't blow memory
    for (;;) {
      let q = db.collection(coll).orderBy('__name__').limit(BATCH);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        docs[d.id] = serialize(d.data(), admin);
        count++;
      }
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < BATCH) break;
    }

    if (count > 0) {
      fs.writeFileSync(path.join(outDir, `${coll}.json`), JSON.stringify(docs, null, 2));
      console.log(`  ✅ ${coll}: ${count} docs`);
    } else {
      console.log(`  ⏭️  ${coll}: empty (skip)`);
    }
    manifest.collections[coll] = count;
    totalDocs += count;
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n🎉 Done! ${totalDocs} docs saved in: backup/${stamp}/`);
  console.log('   Is folder ko zip karke safe rakho — isi se import hoga.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Export failed:', err.message);
  process.exit(1);
});
