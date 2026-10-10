import mongoose from 'mongoose';
import Organization from './src/models/Organization.model';
import User from './src/models/User.model';

async function main() {
  const uri = process.env.MONGODB_URI || '';
  if (!uri.startsWith('mongodb://127.0.0.1:27018/')) {
    throw new Error(`Refusing to seed: MONGODB_URI is not the isolated local dev DB (got: ${uri})`);
  }
  await mongoose.connect(uri);

  const existingOrg = await Organization.findOne({ slug: 'demo-org-permanent' });
  const org = existingOrg || await Organization.create({
    name: 'Demo Org (Permanent)',
    slug: 'demo-org-permanent',
    status: 'active',
    metadata: { physicalMailingAddress: '123 Demo St, Salt Lake City, UT 84101' },
  });

  const ADMIN_EMAIL = 'demo-admin@local.test';
  const EMPLOYEE_EMAIL = 'demo-employee@local.test';
  const PASSWORD = 'DemoPass!2026';

  let admin = await User.findOne({ email: ADMIN_EMAIL });
  if (!admin) {
    admin = await User.create({
      email: ADMIN_EMAIL,
      password: PASSWORD,
      name: 'Demo Admin',
      role: 'admin',
      organizationId: org._id,
      organizationRole: 'admin',
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
  }

  let employee = await User.findOne({ email: EMPLOYEE_EMAIL });
  if (!employee) {
    employee = await User.create({
      email: EMPLOYEE_EMAIL,
      password: PASSWORD,
      name: 'Demo Employee',
      role: 'employee',
      organizationId: org._id,
      organizationRole: 'employee',
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
  }

  console.log(JSON.stringify({
    orgId: String(org._id),
    orgSlug: org.slug,
    adminEmail: ADMIN_EMAIL,
    employeeEmail: EMPLOYEE_EMAIL,
    password: PASSWORD,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
