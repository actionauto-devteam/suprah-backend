import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';

const run = async () => {
  const nameQuery = process.argv[2];
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const user = await CrmUser.findOne({ fullName: { $regex: nameQuery, $options: 'i' } }).select('fullName email').lean();
  if (!user) { console.log('not found'); process.exit(0); }

  const hb = await AgentHeartbeat.findOne({ userId: user._id }).lean();
  console.log(`${user.fullName}:`, JSON.stringify(hb, null, 2));

  await mongoose.disconnect();
  process.exit(0);
};
run().catch((err) => { console.error('Script failed:', err); process.exit(1); });
