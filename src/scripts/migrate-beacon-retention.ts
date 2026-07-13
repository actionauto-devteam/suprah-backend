import mongoose from 'mongoose';
import config from '../config';

const NINETY_DAYS_SEC = 60 * 60 * 24 * 90;

const migrateBeaconRetention = async () => {
  try {
    console.log('🔄 Raising Beacon TTL indexes to 90 days...');

    const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
    if (!databaseUri) {
      throw new Error('Database URI not found in config or environment variables');
    }

    await mongoose.connect(databaseUri);
    console.log('Connected to database');
    const db = mongoose.connection.db!;

    const targets: { collection: string; keyPattern: Record<string, 1> }[] = [
      { collection: 'presenceevents', keyPattern: { createdAt: 1 } },
      { collection: 'locationhistories', keyPattern: { recordedAt: 1 } },
    ];

    for (const { collection, keyPattern } of targets) {
      await db.command({
        collMod: collection,
        index: { keyPattern, expireAfterSeconds: NINETY_DAYS_SEC },
      });
      console.log(`${collection}: TTL updated to 90 days`);
    }

    console.log('\nMigration completed successfully');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

migrateBeaconRetention();
