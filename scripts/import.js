// scripts/import.js
// Restore a backup/ folder into a Firebase project (new account transfer).
//
// Usage:
//   node scripts/import.js backup/2026-07-20T14-30-00                  → into .env project
//   node scripts/import.js backup/2026-07-20T14-30-00 --env .env.new   → into a DIFFERENT project
//   node scripts/import.js backup/... --overwrite                      → replace existing docs
//
// Default is MERGE-SAFE: existing docs are skipped, sirf naye docs likhe jaate hain.
// --overwrite dene par backup wala data existing docs ke upar likh diya jayega.

const fs = require('fs');
const path = require('path');
const { loadEnv, initFirebase, deserialize } = require('./_common');

const WRITE_BATCH = 400; // Firestore batch limit is 500; stay under it

async function main() {
  const argv = process.argv.slice(2);
  const backupDir = argv.find(a => !a.startsWith('--'));
  const envFile = argv.includes('--env') ? argv[argv.indexOf('--env') + 1] : '.env';
  const overwrite = argv.includes('--overwrite');

  if (!backupDir) {
    console.error('❌ Backup folder do. Example: node scripts/import.js backup/2026-07-20T14-30-00');
    process.exit(1);
  }
  const dir = path.resolve(__dirname, '..', backupDir);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    console.error(`❌ ${backupDir} mein manifest.json nahi mila — sahi backup folder do.`);
    process.exit(1);
  }

  const env = loadEnv(envFile);
  if (!env) {
    console.error(`❌ ${envFile} nahi mila.`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const { admin, db, projectId } = initFirebase(env, 'import-app');

  console.log(`📥 Import: backup of "${manifest.projectId}" (${manifest.exportedAt})`);
  console.log(`   → target Firebase project: ${projectId}`);
  console.log(`   Mode: ${overwrite ? '⚠️  OVERWRITE (existing docs replaced)' : 'merge-safe (existing docs skipped)'}`);
  if (manifest.projectId === projectId && overwrite) {
    console.log('   ⚠️  Same project + overwrite — data wapas backup jaisa ho jayega.');
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  let totalWritten = 0;
  let totalSkipped = 0;

  for (const file of files) {
    const coll = file.replace(/\.json$/, '');
    const docs = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const ids = Object.keys(docs);
    let written = 0;
    let skipped = 0;

    for (let i = 0; i < ids.length; i += WRITE_BATCH) {
      const chunk = ids.slice(i, i + WRITE_BATCH);

      // In merge-safe mode, check which docs already exist and skip them
      let existing = new Set();
      if (!overwrite) {
        const refs = chunk.map(id => db.collection(coll).doc(id));
        const snaps = await db.getAll(...refs);
        existing = new Set(snaps.filter(s => s.exists).map(s => s.id));
      }

      const batch = db.batch();
      let inBatch = 0;
      for (const id of chunk) {
        if (existing.has(id)) { skipped++; continue; }
        batch.set(db.collection(coll).doc(id), deserialize(docs[id], admin, db));
        inBatch++;
      }
      if (inBatch > 0) await batch.commit();
      written += inBatch;
    }

    console.log(`  ✅ ${coll}: ${written} written${skipped ? `, ${skipped} skipped (already exist)` : ''}`);
    totalWritten += written;
    totalSkipped += skipped;
  }

  console.log(`\n🎉 Done! ${totalWritten} docs imported${totalSkipped ? `, ${totalSkipped} skipped` : ''}.`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Import failed:', err.message);
  process.exit(1);
});
