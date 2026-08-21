// One-off backfill: CrmUser.username doubles as the displayed "Employee ID"
// (format "YYYY-00001"). Accounts auto-provisioned via SupraSpace used to get
// an email-derived slug (e.g. "jasonberry.actionauto-ffd13d45") instead, which
// is what shows up wrong in User Management. This reassigns a proper
// sequential employee ID to every non-system CrmUser whose username doesn't
// already match the "YYYY-00001" format. Run manually, not on app boot.

import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';

const EMPLOYEE_ID_RE = /^\d{4}-\d{5}$/;

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const year = new Date().getFullYear();

  const lastCorrect = await CrmUser.findOne(
    { username: new RegExp(`^${year}-`) },
    { username: 1 },
    { sort: { username: -1 } },
  );
  let nextSeq = lastCorrect ? parseInt(lastCorrect.username.split('-')[1], 10) + 1 : 1;

  const toFix = await CrmUser.find({ isSystem: { $ne: true } })
    .select('fullName email username')
    .sort({ createdAt: 1 });

  let fixed = 0;
  for (const user of toFix) {
    if (EMPLOYEE_ID_RE.test(user.username)) continue;

    const newId = `${year}-${String(nextSeq).padStart(5, '0')}`;
    nextSeq++;

    await CrmUser.updateOne({ _id: user._id }, { $set: { username: newId } });
    console.log(`✓  ${user.fullName} (${user.email}) → ${user.username} → ${newId}`);
    fixed++;
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Backfill complete. Fixed ${fixed} user(s).`);
  console.log(`─────────────────────────────────────────\n`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
