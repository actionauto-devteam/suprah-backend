
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  try {
    await mongoose.connection.collection('crmusers').dropIndex('username_1');
    console.log('Dropped old username_1 unique index.');
  } catch {
    console.log('username_1 index not found — already removed or never existed, skipping.');
  }

  const resetResult = await CrmUser.updateMany(
    {},
    { $unset: { organizationId: '' } }
  );
  console.log(`Reset ${resetResult.modifiedCount} CrmUser record(s) — cleared existing organizationId values.`);

  // Step 2: Find all CrmUsers
  const crmUsers = await CrmUser.find({}).select('fullName email username');
  console.log(`\nFound ${crmUsers.length} CrmUser record(s) to process.\n`);

  let matched = 0;
  let unmatched = 0;

  for (const crmUser of crmUsers) {
    // Find the main User account with the same email
    const mainUser = await User.findOne({ email: crmUser.email }).select('organizationId');

    if (mainUser?.organizationId) {
      await CrmUser.updateOne(
        { _id: crmUser._id },
        { $set: { organizationId: mainUser.organizationId } }
      );
      console.log(`✓  ${crmUser.fullName} (${crmUser.email}) → org: ${mainUser.organizationId}`);
      matched++;
    } else {
      console.log(`✗  ${crmUser.fullName} (${crmUser.email}) → no matching User or org found — skipped`);
      unmatched++;
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Migration complete.`);
  console.log(`  Matched & updated : ${matched}`);
  console.log(`  Skipped (no match) : ${unmatched}`);
  console.log(`─────────────────────────────────────────\n`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
