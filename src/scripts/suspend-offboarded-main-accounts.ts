import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import Organization from '../models/Organization.model';
import { suspendLinkedMainAccount } from '../services/offboardMainAccount.service';

const APPLY = process.argv.includes('--apply');

async function preview(crmUser: { email?: string; organizationId?: mongoose.Types.ObjectId }) {
  if (!crmUser.email) return 'no Suprah AI account';
  const mainUser = await User.findOne({ email: crmUser.email.trim().toLowerCase() }).lean();
  if (!mainUser) return 'no Suprah AI account';
  if (mainUser.organizationId && String(mainUser.organizationId) !== String(crmUser.organizationId)) return 'SKIP — belongs to another organization';
  if (mainUser.role === 'super_admin' || mainUser.organizationRole === 'owner') return 'SKIP — super admin / owner';
  const org = mainUser.organizationId ? await Organization.findById(mainUser.organizationId).select('ownerId').lean() : null;
  if (org?.ownerId && String(org.ownerId) === String(mainUser._id)) return 'SKIP — organization owner';
  if (!mainUser.isActive) return mainUser.suspendedByOffboard ? 'already locked by offboarding' : 'already suspended';
  return 'WILL LOCK';
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log(`Connected to MongoDB — ${APPLY ? 'APPLY mode' : 'DRY RUN (add --apply to lock)'}`);

  const offboarded = await CrmUser.find({ isOffboarded: true, isSystem: { $ne: true } })
    .select('fullName email organizationId')
    .lean();
  console.log(`Found ${offboarded.length} offboarded CRM users (system accounts excluded)\n`);

  const counts: Record<string, number> = {};
  for (const u of offboarded) {
    const result = APPLY ? await suspendLinkedMainAccount(u) : await preview(u);
    counts[result] = (counts[result] ?? 0) + 1;
    console.log(`${u.fullName} (${u.email}) — ${result}`);
  }

  console.log('\nTotals:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
