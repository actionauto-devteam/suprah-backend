import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import EotmTeam from '../models/EotmTeam.model';
import EmployeeOfMonth from '../models/EmployeeOfMonth.model';

const APPLY = process.argv.includes('--apply');

const LEGACY_TEAM_NAMES = ['Philippines', 'Utah'];

async function run() {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected to database. Mode: ${APPLY ? 'APPLY (writes will persist)' : 'DRY RUN (no writes)'}\n`);

  // Only orgs still on the pre-EotmTeam schema have a raw `team` string field
  // left over on their EmployeeOfMonth docs (Mongoose strips the old `team`
  // key from new writes once the schema no longer declares it, so this only
  // ever matches genuinely un-migrated legacy documents).
  const legacyDocs = await mongoose.connection.collection('employeeofmonths').find({
    team: { $exists: true },
  }).toArray();

  const orgIds = Array.from(new Set(legacyDocs.map((d: any) => d.organizationId.toString())));
  console.log(`Found ${orgIds.length} organization(s) with legacy Employee of the Month records.\n`);

  let teamsCreated = 0;
  let docsMigrated = 0;

  for (const orgIdStr of orgIds) {
    const orgId = new mongoose.Types.ObjectId(orgIdStr);
    const teamIdByName = new Map<string, mongoose.Types.ObjectId>();

    for (const name of LEGACY_TEAM_NAMES) {
      let team = await EotmTeam.findOne({ organizationId: orgId, name });
      if (!team) {
        const members = await CrmUser.find({ organizationId: orgId, payrollLocation: name }).select('_id');
        console.log(
          `  org=${orgIdStr}: creating team "${name}" with ${members.length} member(s) snapshotted from payrollLocation`,
        );
        teamsCreated++;
        if (APPLY) {
          team = await EotmTeam.create({
            organizationId: orgId,
            name,
            color: name === 'Philippines' ? 'sky' : 'amber',
            memberIds: members.map((m) => m._id),
            createdBy: members[0]?._id || undefined,
          });
        }
      }
      if (team) teamIdByName.set(name, team._id as mongoose.Types.ObjectId);
    }

    const docsForOrg = legacyDocs.filter((d: any) => d.organizationId.toString() === orgIdStr);
    for (const doc of docsForOrg) {
      const teamId = teamIdByName.get(doc.team);
      if (!teamId) {
        console.log(`  UNRESOLVED: org=${orgIdStr} doc=${doc._id} has unknown team "${doc.team}", left untouched`);
        continue;
      }
      console.log(`  org=${orgIdStr}: migrating doc ${doc._id} (${doc.month}, "${doc.team}") -> teamId=${teamId}`);
      docsMigrated++;
      if (APPLY) {
        await EmployeeOfMonth.updateOne({ _id: doc._id }, { $set: { teamId }, $unset: { team: '' } });
      }
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Backfill complete (${APPLY ? 'applied' : 'dry-run — nothing written'}).`);
  console.log(`  Teams created  : ${teamsCreated}`);
  console.log(`  Docs migrated  : ${docsMigrated}`);
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
