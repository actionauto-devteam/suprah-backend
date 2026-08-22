/**
 * One-off diagnostic: lists every screenshot R2 key stored for a given CrmUser
 * (by full name, case-insensitive partial match), grouped by shiftDate folder.
 * Screenshots have no MongoDB row (see crmTimeproof.controller.ts submitScreenshot) —
 * this is the only way to check what actually exists in storage for a user/date,
 * independent of whatever the gallery UI does or doesn't show.
 *
 * Usage: npx ts-node src/scripts/check-user-screenshots.ts "RJ Turingan"
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import { storageService, BucketType } from '../services/storage.service';

const run = async () => {
  const nameQuery = process.argv[2];
  if (!nameQuery) {
    console.error('Usage: npx ts-node src/scripts/check-user-screenshots.ts "<full name or email>"');
    process.exit(1);
  }

  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const users = await CrmUser.find({
    $or: [
      { fullName: { $regex: nameQuery, $options: 'i' } },
      { email: { $regex: nameQuery, $options: 'i' } },
    ],
  }).select('fullName email').lean();

  if (users.length === 0) {
    console.log(`No CrmUser matched "${nameQuery}".`);
    process.exit(0);
  }

  for (const user of users) {
    console.log(`\n=== ${user.fullName} <${user.email}> (${user._id}) ===`);
    const prefix = `screenshots/${user._id.toString()}/`;
    const objects = await storageService.list(prefix, BucketType.PRIVATE);

    if (objects.length === 0) {
      console.log('  No screenshot objects found in R2 for this user AT ALL.');
      continue;
    }

    const byDate = new Map<string, number>();
    for (const obj of objects) {
      const parts = obj.key.split('/');
      const dateFolder = parts[2] ?? '(unparseable)';
      byDate.set(dateFolder, (byDate.get(dateFolder) ?? 0) + 1);
    }

    const sortedDates = Array.from(byDate.keys()).sort();
    for (const date of sortedDates) {
      console.log(`  ${date}: ${byDate.get(date)} screenshot(s)`);
    }
    console.log(`  Total: ${objects.length} object(s) across ${sortedDates.length} date(s)`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
