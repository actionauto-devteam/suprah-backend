import mongoose from 'mongoose';
import config from '../config';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  try {
    await mongoose.connection.collection('notifications').dropIndex('createdAt_1');
    console.log('Dropped old createdAt_1 TTL index.');
  } catch {
    console.log('createdAt_1 index not found — already removed or never existed, skipping.');
  }

  // lastOccurredAt_1 (auto-named, no partialFilterExpression) was created by
  // an earlier version of this same migration before it had an explicit
  // partialFilterExpression — same IndexOptionsConflict applies to it too,
  // confirmed by directly inspecting the live collection's indexes: renaming
  // alone (without dropping first) does NOT let the new spec through.
  try {
    await mongoose.connection.collection('notifications').dropIndex('lastOccurredAt_1');
    console.log('Dropped old lastOccurredAt_1 index.');
  } catch {
    console.log('lastOccurredAt_1 index not found — already removed or never existed, skipping.');
  }

  console.log('Run this BEFORE deploying the new backend build — on next boot, Mongoose');
  console.log('will create createdAt_ttl_ungrouped and lastOccurredAt_ttl_grouped in their place.');

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
