import mongoose from 'mongoose';
import config from '../config';
import { ensureTrayDeviceIndexes } from '../utils/initTrayDeviceAuth';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  const create = process.argv.includes('--create');
  await mongoose.connect(databaseUri);
  console.log(
    `Connected to database "${mongoose.connection.name}" (${create ? 'creating any missing indexes, then verifying' : 'read-only verification, nothing is created'}).`,
  );

  const problems = await ensureTrayDeviceIndexes({ create });
  await mongoose.disconnect();

  if (problems.length > 0) {
    console.error('Tray device index check FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    if (!create) console.error('Run again with --create to create the missing indexes, then verify.');
    process.exit(1);
  }
  console.log('Tray device indexes OK: traydevices (deviceId unique) and traybootstrapcodes (codeHash unique, expiresAt TTL 0).');
  process.exit(0);
};

run().catch(async (err) => {
  console.error('Tray device index check failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    process.exit(1);
  }
  process.exit(1);
});
