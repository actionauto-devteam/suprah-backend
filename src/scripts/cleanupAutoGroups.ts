import 'dotenv/config';
import mongoose from 'mongoose';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';

async function run() {
  const names = (process.env.DEPRECATED_AUTO_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!names.length) {
    console.log('Set DEPRECATED_AUTO_GROUPS to the group names to deactivate. Nothing to do.');
    process.exit(0);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI (or MONGO_URI) is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const res = await SupraSpaceConversation.updateMany(
    { type: 'group', name: { $in: names }, isActive: true },
    { $set: { isActive: false, deletedAt: new Date() } }
  );

  console.log(`Deactivated ${res.modifiedCount} deprecated auto group(s): ${names.join(', ')}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
