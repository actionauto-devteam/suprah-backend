/**
 * DT-01: make Load.loadNumber unique per organization instead of globally.
 *
 * The daily load-number counter is per organization, so the old global
 * unique index (loadNumber_1) made the second organization to post on a given
 * day fail with E11000.
 *
 * Dry run (default):  npx ts-node --transpile-only src/scripts/migrate-load-number-org-index.ts
 * Apply:              npx ts-node --transpile-only src/scripts/migrate-load-number-org-index.ts --apply
 *
 * Order is safe: the compound index is built first (existing numbers are
 * already globally unique, so they are unique per org too), and only then is
 * the global index dropped.
 */
import mongoose from 'mongoose';
import config from '../config';

const APPLY = process.argv.includes('--apply');
const COMPOUND_INDEX_NAME = 'organizationId_1_loadNumber_1';
const LEGACY_INDEX_NAME = 'loadNumber_1';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to change indexes)'}`);

  const loads = mongoose.connection.collection('loads');

  const duplicates = await loads
    .aggregate([
      { $match: { loadNumber: { $type: 'string' } } },
      { $group: { _id: { organizationId: '$organizationId', loadNumber: '$loadNumber' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();

  if (duplicates.length > 0) {
    console.error('ABORT: duplicate load numbers exist within an organization:');
    for (const duplicate of duplicates) console.error('  ', JSON.stringify(duplicate));
    await mongoose.disconnect();
    process.exit(1);
  }

  const indexes = await loads.indexes();
  const compound = indexes.find((index) => index.name === COMPOUND_INDEX_NAME);
  const legacy = indexes.find((index) => index.name === LEGACY_INDEX_NAME);

  console.log(`Per-org index ${COMPOUND_INDEX_NAME}: ${compound ? 'present' : 'MISSING'}`);
  console.log(`Legacy index ${LEGACY_INDEX_NAME}: ${legacy ? `present (unique: ${Boolean(legacy.unique)})` : 'absent'}`);

  if (!APPLY) {
    console.log('Dry run complete. Planned actions:');
    if (!compound) console.log(`  - create unique ${COMPOUND_INDEX_NAME}`);
    if (legacy) console.log(`  - drop ${LEGACY_INDEX_NAME}`);
    if (compound && !legacy) console.log('  - nothing to do');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!compound) {
    await loads.createIndex(
      { organizationId: 1, loadNumber: 1 },
      {
        unique: true,
        name: COMPOUND_INDEX_NAME,
        partialFilterExpression: { loadNumber: { $type: 'string' } },
      },
    );
    console.log(`Created ${COMPOUND_INDEX_NAME}.`);
  }

  if (legacy) {
    await loads.dropIndex(LEGACY_INDEX_NAME);
    console.log(`Dropped ${LEGACY_INDEX_NAME}.`);
  }

  console.log('Load number index migration complete.');
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
