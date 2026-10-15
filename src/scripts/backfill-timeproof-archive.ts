import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import CrmUser from '../models/CrmUser.model';
import TimeproofArchive from '../models/TimeproofArchive.model';

async function backfill() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log('Connected to MongoDB');

  const offboardedUsers = await CrmUser.find({ isOffboarded: true });
  console.log(`Found ${offboardedUsers.length} offboarded CrmUser accounts`);

  let created = 0;
  let skipped = 0;

  for (const user of offboardedUsers) {
    const existing = await TimeproofArchive.findById(user._id).select('_id').lean();
    if (existing) {
      skipped++;
      continue;
    }

    await TimeproofArchive.create({
      _id: user._id,
      organizationId: user.organizationId,
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
      role: user.role,
      department: user.department,
      hireDate: user.hireDate,
      offboardedAt: user.offboardedAt ?? new Date(),
    });
    created++;
    console.log(`Archived: ${user.fullName} (${user.email})`);
  }

  console.log(`Done. Created ${created}, already archived ${skipped}.`);
  await mongoose.disconnect();
}

backfill().catch((err) => { console.error(err); process.exit(1); });
