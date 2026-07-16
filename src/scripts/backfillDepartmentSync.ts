import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import EmployeeLocation from '../models/EmployeeLocation.model';
import { getOrgDepartments, findDepartmentEntry } from '../services/department.service';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

async function run() {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected to database. Mode: ${APPLY ? 'APPLY (writes will persist)' : 'DRY RUN (no writes)'}\n`);

  console.log('── Step 1: Ensure every organization\'s department list exists ────────');
  const crmOrgIds = await CrmUser.distinct('organizationId');
  const userOrgIds = await User.distinct('organizationId');
  const allOrgIds = Array.from(
    new Set([...crmOrgIds, ...userOrgIds].map((id) => (id ? id.toString() : 'none')))
  );
  for (const idStr of allOrgIds) {
    // getOrgDepartments auto-seeds real rows into the DB the first time it's called for an
    // org with none yet (see department.service.ts) — calling it here just makes sure that
    // happens before Step 2 relies on it, rather than waiting for the first live API request.
    const list = await getOrgDepartments(idStr === 'none' ? undefined : idStr);
    console.log(`  org=${idStr}: ${list.length} department(s) available`);
  }
  console.log('');

  console.log('── Step 2: Reconcile CrmUser <-> User department values ────────────');
  const crmUsers = await CrmUser.find({}).select('fullName email organizationId department').cursor();

  let cascaded = 0, seededFromUser = 0, noop = 0, skippedNoTwin = 0, unresolved = 0;

  for await (const crmUser of crmUsers) {
    const normalizedEmail = crmUser.email.trim().toLowerCase();
    const linkedUser = await User.findOne({ email: normalizedEmail }).select('personalInfo.department');

    if (!linkedUser) {
      if (VERBOSE) console.log(`  skip (no linked User): ${crmUser.email}`);
      skippedNoTwin++;
      continue;
    }

    const orgIdStr = crmUser.organizationId?.toString();
    const userDept = linkedUser.personalInfo?.department;

    // Only ever trust a value that matches a REAL, currently-existing department (by key or
    // current label) — never write a raw passthrough. A department that's since been renamed
    // leaves old label-text on stale records unresolvable; blindly cascading that text would
    // silently corrupt an already-correct value on the other side (exactly the bug this script
    // exists to prevent, not cause).
    const crmEntry = await findDepartmentEntry(orgIdStr, crmUser.department);
    const userEntry = await findDepartmentEntry(orgIdStr, userDept);

    if (crmEntry) {
      if (userDept === crmEntry.key) {
        noop++;
        continue;
      }
      console.log(`  CrmUser wins: ${crmUser.email} — User.personalInfo.department "${userDept ?? ''}" -> "${crmEntry.key}"`);
      cascaded++;
      if (APPLY) {
        await User.findByIdAndUpdate(linkedUser._id, { $set: { 'personalInfo.department': crmEntry.key } });
        await EmployeeLocation.updateMany(
          { userId: { $in: [linkedUser._id, crmUser._id] } },
          { $set: { department: crmEntry.key } },
        );
      }
    } else if (userEntry) {
      console.log(`  Healed CrmUser from User (CrmUser's value was stale/unresolvable): ${crmUser.email} "${crmUser.department ?? ''}" -> "${userEntry.key}"`);
      seededFromUser++;
      if (APPLY) {
        await CrmUser.findByIdAndUpdate(crmUser._id, { $set: { department: userEntry.key } });
        await EmployeeLocation.updateMany(
          { userId: { $in: [linkedUser._id, crmUser._id] } },
          { $set: { department: userEntry.key } },
        );
      }
    } else if (crmUser.department || userDept) {
      console.log(`  UNRESOLVED (neither side matches a real department, left untouched): ${crmUser.email} — CrmUser="${crmUser.department ?? ''}" User="${userDept ?? ''}"`);
      unresolved++;
    } else {
      noop++;
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Backfill complete (${APPLY ? 'applied' : 'dry-run — nothing written'}).`);
  console.log(`  CrmUser -> User cascaded : ${cascaded}`);
  console.log(`  CrmUser healed from User : ${seededFromUser}`);
  console.log(`  No-op (already in sync)  : ${noop}`);
  console.log(`  Unresolved (left alone)  : ${unresolved}`);
  console.log(`  Skipped (no linked User) : ${skippedNoTwin}`);
  console.log(`─────────────────────────────────────────\n`);

  if (!APPLY) {
    console.log('This was a dry run. Re-run with --apply to persist these changes.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
