import fs from 'fs';
import mongoose from 'mongoose';
import config from '../config';
import Organization from '../models/Organization.model';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import Department from '../models/Department.model';
import { getOrgDepartments } from '../services/department.service';
import { isLocalMongoTarget, parseMongoTarget } from '../utils/productionDbGuard.util';

const PASSWORD = 'DevPass!2026';

const USERS = [
  { username: 'DEV-0001', fullName: 'Dev Admin', role: 'admin' as const },
  { username: 'DEV-0101', fullName: 'Pilot Recon (Switching)', role: 'employee' as const, department: 'Recon' },
  { username: 'DEV-0102', fullName: 'Desk Accounting (Off)', role: 'employee' as const, department: 'Accounting' },
  { username: 'DEV-0103', fullName: 'Lot Tech (Always)', role: 'employee' as const, department: 'LotTechTeam' },
  { username: 'DEV-0104', fullName: 'Web Dev (Idle Exempt)', role: 'employee' as const, department: 'WebDevTeam' },
  { username: 'DEV-0105', fullName: 'Legacy Not Allowlisted', role: 'employee' as const, department: 'Accounting' },
];

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!isLocalMongoTarget(databaseUri)) {
    console.error('Refusing to seed: this script only writes to a database on this computer (127.0.0.1 / localhost).');
    process.exit(1);
  }
  const target = parseMongoTarget(databaseUri)!;

  await mongoose.connect(databaseUri);
  console.log(`Connected to local database "${mongoose.connection.name}" on ${target.hosts.join(',')}.`);

  let organization = await Organization.findOne({ slug: 'suprah-local-dev' });
  if (!organization) {
    organization = await Organization.create({ name: 'Suprah Local Dev', slug: 'suprah-local-dev' });
    console.log('Created organization Suprah Local Dev.');
  }

  const orgId = String(organization._id);
  await getOrgDepartments(orgId);
  await Department.updateOne({ organizationId: organization._id, key: 'Recon' }, { $set: { mobileMonitoringMode: 'switching', isMobileMonitoringDept: true } });
  await Department.updateOne({ organizationId: organization._id, key: 'LotTechTeam' }, { $set: { mobileMonitoringMode: 'always', isMobileMonitoringDept: true } });
  await CrmUser.updateMany({ organizationId: organization._id }, { $unset: { monitoringModeOverride: '' } });
  console.log('Departments configured like production: Recon = Switching, Lot Tech = Always, everything else Off.');

  const created: Array<{ username: string; fullName: string; email: string; id: string; department: string | null; password: string }> = [];
  for (const spec of USERS) {
    let user = await CrmUser.findOne({ username: spec.username, organizationId: organization._id });
    if (!user) {
      user = await CrmUser.create({
        ...spec,
        email: `${spec.username.toLowerCase()}@local.test`,
        password: PASSWORD,
        organizationId: organization._id,
        isActive: true,
      });
      console.log(`Created ${spec.username} ${spec.fullName}`);
    }
    const email = `${spec.username.toLowerCase()}@local.test`;
    const mainAccount = await User.findOne({ email });
    if (!mainAccount) {
      await User.create({
        name: spec.fullName,
        email,
        password: PASSWORD,
        emailVerified: true,
        onboardingCompleted: true,
        role: spec.role === 'admin' ? 'admin' : 'employee',
        organizationId: organization._id,
        isActive: true,
      });
      console.log(`Created main-site account for ${email}`);
    } else if (!(mainAccount as any).onboardingCompleted) {
      await User.updateOne({ _id: mainAccount._id }, { $set: { onboardingCompleted: true, emailVerified: true } });
      console.log(`Marked onboarding complete for ${email}`);
    }
    created.push({ username: spec.username, fullName: spec.fullName, email, id: String(user._id), department: (spec as any).department ?? null, password: PASSWORD });
  }

  const outFile = process.env.LOCAL_E2E_USERS_FILE;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ organizationId: String(organization._id), users: created }, null, 2));
  console.log(JSON.stringify({ organizationId: String(organization._id), users: created.map(({ password, ...rest }) => rest) }, null, 2));
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  console.error('Local dev seed failed:', err?.message ?? err);
  try {
    await mongoose.disconnect();
  } catch {
    process.exit(1);
  }
  process.exit(1);
});
