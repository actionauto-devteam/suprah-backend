import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';

const run = async () => {
  const username = process.argv[2];
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const user = await CrmUser.findOne({ username }).select('fullName email username role department screenshotBlurUntilPayout').lean();
  console.log(user ? JSON.stringify(user, null, 2) : `No CrmUser with username "${username}"`);

  await mongoose.disconnect();
  process.exit(0);
};
run().catch((err) => { console.error('Script failed:', err); process.exit(1); });
