import mongoose from 'mongoose';
import config from '../config';
import Vehicle from '../models/Vehicle.model';

const APPLY = process.argv.includes('--apply');

async function run() {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected to database. Mode: ${APPLY ? 'APPLY (writes will persist)' : 'DRY RUN (no writes)'}\n`);

  const missing = await Vehicle.find({
    $or: [
      { reengagementSweptAt: null },
      { reengagementSweptAt: { $exists: false } },
    ],
  }).select('_id vin status organizationId').lean();

  console.log(`Found ${missing.length} vehicle(s) missing reengagementSweptAt.\n`);

  if (APPLY && missing.length > 0) {
    const now = new Date();
    const result = await Vehicle.updateMany(
      {
        $or: [
          { reengagementSweptAt: null },
          { reengagementSweptAt: { $exists: false } },
        ],
      },
      { $set: { reengagementSweptAt: now } },
    );
    console.log(`Updated ${result.modifiedCount} vehicle(s).`);
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Backfill complete (${APPLY ? 'applied' : 'dry-run — nothing written'}).`);
  console.log(`  Vehicles found  : ${missing.length}`);
  console.log(`─────────────────────────────────────────\n`);

  if (!APPLY) {
    console.log('This was a dry run. Re-run with --apply to persist these changes.');
    console.log('Run this to completion BEFORE ever setting VEHICLE_REENGAGEMENT_ENABLED=true.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
