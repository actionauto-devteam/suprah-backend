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

  const notificationIndexesToDrop = [
    'createdAt_1',
    'lastOccurredAt_1',
    'createdAt_ttl_ungrouped',
    'lastOccurredAt_ttl_grouped',
  ];

  for (const indexName of notificationIndexesToDrop) {
    try {
      await mongoose.connection
        .collection('notifications')
        .dropIndex(indexName);

      console.log(`Dropped notification index: ${indexName}`);
    } catch (error: any) {
      if (error?.code === 27 || error?.codeName === 'IndexNotFound') {
        console.log(`${indexName} not found — skipping.`);
      } else {
        throw error;
      }
    }
  }

  console.log('Notification index cleanup complete.');
  console.log('Restart the backend now. Mongoose will recreate:');
  console.log('  - createdAt_ttl_ungrouped');
  console.log('  - lastOccurredAt_ttl_grouped');

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});