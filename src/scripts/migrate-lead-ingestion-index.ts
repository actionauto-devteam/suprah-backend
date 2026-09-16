import mongoose from 'mongoose';
import config from '../config';
import Lead from '../models/lead.model';

async function run() {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI;

  if (!databaseUri) {
    throw new Error('Database URI not found in config or environment variables.');
  }

  await mongoose.connect(databaseUri);
  await Lead.createIndexes();
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('Lead ingestion index migration failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
