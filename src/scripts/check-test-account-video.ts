import mongoose from 'mongoose';
import connectDB from '../config/db';
import CrmUser from '../models/CrmUser.model';
import { storageService, BucketType } from '../services/storage.service';
import { isIdleVideoProofEnabled } from '../config/departmentMonitoring';
import { findDepartmentEntry } from '../services/department.service';

async function main() {
  await connectDB();
  const user = await CrmUser.findOne({ email: 'cenarvaez13@gmail.com' }).lean();
  if (!user) { console.log('not found'); process.exit(1); }
  console.log(`User: ${user.fullName} <${user.email}> dept="${user.department}" org=${user.organizationId}`);

  const deptEntry = await findDepartmentEntry(user.organizationId?.toString(), user.department);
  console.log(`Resolved department entry: ${JSON.stringify(deptEntry, null, 2)}`);

  const enabled = await isIdleVideoProofEnabled(user.organizationId?.toString(), user.department);
  console.log(`isIdleVideoProofEnabled resolves to: ${enabled}`);

  const shiftDate = '2026-09-15';
  const videoPrefix = `idle-recordings/${user._id.toString()}/${shiftDate}/`;
  const videoObjects = await storageService.list(videoPrefix, BucketType.PRIVATE);
  console.log(`\nidle-recordings objects under ${videoPrefix}: ${videoObjects.length}`);
  for (const o of videoObjects) console.log(`  ${o.key} (lastModified=${o.lastModified})`);

  const ssPrefix = `screenshots/${user._id.toString()}/${shiftDate}/`;
  const ssObjects = await storageService.list(ssPrefix, BucketType.PRIVATE);
  console.log(`\nscreenshots objects under ${ssPrefix}: ${ssObjects.length}`);
  for (const o of ssObjects) console.log(`  ${o.key}`);

  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
