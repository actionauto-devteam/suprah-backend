import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import Notification from '../models/Notification.model';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found.');
    process.exit(1);
  }
  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('Usage: npx ts-node src/scripts/check-idle-alerts-sent.ts "Name One" "Name Two" ...');
    process.exit(1);
  }

  for (const name of names) {
    const user = await CrmUser.findOne({ fullName: name }).select('_id fullName').lean();
    if (!user) {
      console.log(`\n=== ${name} — NOT FOUND ===`);
      continue;
    }
    console.log(`\n=== ${name} (${user._id}) ===`);
    const notifs = await Notification.find({
      userId: user._id,
      $or: [{ title: { $regex: 'idle', $options: 'i' } }, { message: { $regex: 'idle', $options: 'i' } }],
    }).sort({ createdAt: 1 }).select('title message createdAt').lean();
    if (notifs.length === 0) {
      console.log('  No idle-related notifications found.');
      continue;
    }
    for (const n of notifs) {
      console.log(`  [${new Date((n as any).createdAt).toISOString()}] ${n.title} — ${n.message}`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
