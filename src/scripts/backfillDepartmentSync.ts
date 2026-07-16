import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import Department from '../models/Department.model';
import EmployeeLocation from '../models/EmployeeLocation.model';
import { normalizeDepartmentValue, invalidateOrgDepartmentCache } from '../services/department.service';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

const LEGACY_DEPARTMENTS = [
  { key: 'SalesAndFinance', label: 'Sales & Finance', color: 'emerald', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 0 },
  { key: 'Accounting', label: 'Accounting', color: 'sky', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 1 },
  { key: 'Recon', label: 'Recon', color: 'amber', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 2 },
  { key: 'Marketing', label: 'Marketing', color: 'pink', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 3 },
  { key: 'OnlineTeam', label: 'Online Team', color: 'violet', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 4 },
  { key: 'WebDevTeam', label: 'Web Dev', color: 'blue', isMobileMonitoringDept: false, isTimeEditExempt: true, isMandatoryLocationDept: false, sortOrder: 5 },
  { key: 'WholesaleTeam', label: 'Wholesale', color: 'orange', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 6 },
  { key: 'BuyingTeam', label: 'Buying', color: 'teal', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 7 },
  { key: 'OperationsTeam', label: 'Operations', color: 'rose', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 8 },
  { key: 'LotTechTeam', label: 'Lot Tech', color: 'indigo', isMobileMonitoringDept: true, isTimeEditExempt: false, isMandatoryLocationDept: true, sortOrder: 9 },
  { key: 'FundingTeam', label: 'Funding', color: 'lime', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 10 },
  { key: 'ProspectsTeam', label: 'Prospects', color: 'cyan', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 11 },
  { key: 'PriceCheckTeam', label: 'Price Check', color: 'fuchsia', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 12 },
];

async function seedDepartmentsForOrg(organizationId: mongoose.Types.ObjectId | undefined) {
  const query = organizationId ? { organizationId } : { organizationId: { $exists: false } };
  const existingCount = await Department.countDocuments(query);
  if (existingCount > 0) return 0;

  console.log(`  Seeding ${LEGACY_DEPARTMENTS.length} default departments for org=${organizationId ?? '(none)'}${APPLY ? '' : ' [dry-run]'}`);
  if (APPLY) {
    await Department.insertMany(
      LEGACY_DEPARTMENTS.map((d) => ({ ...d, organizationId, isActive: true }))
    );
    invalidateOrgDepartmentCache(organizationId?.toString());
  }
  return LEGACY_DEPARTMENTS.length;
}

async function run() {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected to database. Mode: ${APPLY ? 'APPLY (writes will persist)' : 'DRY RUN (no writes)'}\n`);

  console.log('── Step 1: Seed default departments per organization ──────────────');
  const crmOrgIds = await CrmUser.distinct('organizationId');
  const userOrgIds = await User.distinct('organizationId');
  const allOrgIds = Array.from(
    new Set([...crmOrgIds, ...userOrgIds].map((id) => (id ? id.toString() : 'none')))
  );
  let seededOrgs = 0;
  for (const idStr of allOrgIds) {
    const orgId = idStr === 'none' ? undefined : new mongoose.Types.ObjectId(idStr);
    const seeded = await seedDepartmentsForOrg(orgId);
    if (seeded > 0) seededOrgs++;
  }
  console.log(`Seeded departments for ${seededOrgs} organization(s) (of ${allOrgIds.length} total).\n`);

  console.log('── Step 2: Reconcile CrmUser <-> User department values ────────────');
  const crmUsers = await CrmUser.find({}).select('fullName email organizationId department').cursor();

  let cascaded = 0, seededFromUser = 0, noop = 0, skippedNoTwin = 0;

  for await (const crmUser of crmUsers) {
    const normalizedEmail = crmUser.email.trim().toLowerCase();
    const linkedUser = await User.findOne({ email: normalizedEmail }).select('personalInfo.department');

    if (!linkedUser) {
      if (VERBOSE) console.log(`  skip (no linked User): ${crmUser.email}`);
      skippedNoTwin++;
      continue;
    }

    const orgIdStr = crmUser.organizationId?.toString();
    const crmDept = await normalizeDepartmentValue(orgIdStr, crmUser.department);
    const userDept = linkedUser.personalInfo?.department;

    if (crmDept) {
      if (userDept === crmDept) {
        noop++;
        continue;
      }
      console.log(`  CrmUser wins: ${crmUser.email} — User.personalInfo.department "${userDept ?? ''}" -> "${crmDept}"`);
      cascaded++;
      if (APPLY) {
        await User.findByIdAndUpdate(linkedUser._id, { $set: { 'personalInfo.department': crmDept } });
        await EmployeeLocation.updateMany(
          { userId: { $in: [linkedUser._id, crmUser._id] } },
          { $set: { department: crmDept } },
        );
      }
    } else if (userDept) {
      const seededDept = await normalizeDepartmentValue(orgIdStr, userDept);
      console.log(`  Seeded CrmUser from User: ${crmUser.email} -> "${seededDept}"`);
      seededFromUser++;
      if (APPLY) {
        await CrmUser.findByIdAndUpdate(crmUser._id, { $set: { department: seededDept } });
        await EmployeeLocation.updateMany(
          { userId: { $in: [linkedUser._id, crmUser._id] } },
          { $set: { department: seededDept } },
        );
      }
    } else {
      noop++;
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Backfill complete (${APPLY ? 'applied' : 'dry-run — nothing written'}).`);
  console.log(`  CrmUser -> User cascaded : ${cascaded}`);
  console.log(`  CrmUser seeded from User : ${seededFromUser}`);
  console.log(`  No-op (already in sync)  : ${noop}`);
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
