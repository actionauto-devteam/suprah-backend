import mongoose from 'mongoose';
import config from '../config';
import { SystemLog } from '../models/SystemLog.model';

const run = async () => {
  const userId = process.argv[2];
  const event = process.argv[3];
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const logs = await SystemLog.find({ context: 'tray-client-diagnostic', 'req.userId': userId, event }).sort({ timestamp: 1 }).limit(5).lean();
  for (const l of logs) {
    console.log(JSON.stringify(l, null, 2));
  }
  await mongoose.disconnect();
  process.exit(0);
};
run().catch((err) => { console.error('Script failed:', err); process.exit(1); });
