import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import TimeproofArchive from '../models/TimeproofArchive.model';

async function report() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log('Connected to MongoDB');

  const archives = await TimeproofArchive.find({}).sort({ offboardedAt: 1 }).lean();
  const now = Date.now();
  const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

  for (const a of archives) {
    const ageDays = Math.floor((now - new Date(a.offboardedAt).getTime()) / 86_400_000);
    const pastThreeMonths = (now - new Date(a.offboardedAt).getTime()) > THREE_MONTHS_MS;
    console.log(
      `${a.fullName} (${a.email}) — offboarded ${new Date(a.offboardedAt).toISOString().split('T')[0]}, ${ageDays} days ago${pastThreeMonths ? '  [PAST 3 MONTHS]' : ''}`,
    );
  }

  const pastCount = archives.filter((a) => (now - new Date(a.offboardedAt).getTime()) > THREE_MONTHS_MS).length;
  console.log(`\n${pastCount} of ${archives.length} already past the 3-month mark as of today.`);

  await mongoose.disconnect();
}

report().catch((err) => { console.error(err); process.exit(1); });
