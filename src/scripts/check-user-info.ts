/**
 * One-off diagnostic: prints a CrmUser's department and relevant TimeProof-related flags.
 * Usage: npx ts-node src/scripts/check-user-info.ts "<name>"
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';

const run = async () => {
  const nameQuery = process.argv[2];
  if (!nameQuery) { console.error('Usage: npx ts-node src/scripts/check-user-info.ts "<name>"'); process.exit(1); }

  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) { console.error('ERROR: Database URI not found.'); process.exit(1); }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const users = await CrmUser.find({
    $or: [
      { fullName: { $regex: nameQuery, $options: 'i' } },
      { email: { $regex: nameQuery, $options: 'i' } },
    ],
  }).select('fullName email department role screenshotExempt mainMonitorOnly').lean();

  for (const u of users) {
    console.log(JSON.stringify(u, null, 2));
  }
  if (users.length === 0) console.log(`No CrmUser matched "${nameQuery}".`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => { console.error('Script failed:', err); process.exit(1); });
