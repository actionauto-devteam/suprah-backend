/**
 * One-off diagnostic: lists the exact capturedAt (MDT) time of every screenshot
 * for a given CrmUser on a specific shiftDate — used to spot gaps in capture
 * coverage during a specific window (e.g. is there a stretch with no captures
 * at all, suggesting the tray was disconnected/unresponsive during that time).
 *
 * Usage: npx ts-node src/scripts/check-user-screenshot-times.ts "<name>" <YYYY-MM-DD>
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import { storageService, BucketType } from '../services/storage.service';

const MDT_OFFSET_MS = -6 * 60 * 60 * 1000;

const run = async () => {
  const nameQuery = process.argv[2];
  const date = process.argv[3];
  if (!nameQuery || !date) {
    console.error('Usage: npx ts-node src/scripts/check-user-screenshot-times.ts "<name>" <YYYY-MM-DD>');
    process.exit(1);
  }

  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) { console.error('ERROR: Database URI not found.'); process.exit(1); }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const users = await CrmUser.find({
    $or: [
      { fullName: { $regex: nameQuery, $options: 'i' } },
      { email: { $regex: nameQuery, $options: 'i' } },
    ],
  }).select('fullName email').lean();

  for (const user of users) {
    console.log(`\n=== ${user.fullName} <${user.email}> ===`);
    const prefix = `screenshots/${user._id.toString()}/${date}/`;
    const objects = await storageService.list(prefix, BucketType.PRIVATE);

    const times = objects.map((obj) => {
      const tail = obj.key.slice(prefix.length).replace(/\.jpg$/i, '');
      const dashIdx = tail.lastIndexOf('-');
      const ms = dashIdx >= 0 ? parseInt(tail.slice(0, dashIdx), 10) : NaN;
      const flag = dashIdx >= 0 ? tail.slice(dashIdx + 1) : '?';
      return { ms, flag };
    }).filter((x) => Number.isFinite(x.ms)).sort((a, b) => a.ms - b.ms);

    if (times.length === 0) { console.log('  No screenshots found for this date.'); continue; }

    for (const t of times) {
      const mdt = new Date(t.ms + MDT_OFFSET_MS);
      const timeStr = mdt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'UTC' });
      console.log(`  ${timeStr} (${t.flag})`);
    }
    console.log(`  Total: ${times.length}`);

    // Flag any gap wider than 15 minutes (expected interval is 10 min)
    console.log('\n  Gaps > 15 min:');
    let foundGap = false;
    for (let i = 1; i < times.length; i++) {
      const gapMin = (times[i].ms - times[i - 1].ms) / 60000;
      if (gapMin > 15) {
        foundGap = true;
        const startMdt = new Date(times[i - 1].ms + MDT_OFFSET_MS).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' });
        const endMdt = new Date(times[i].ms + MDT_OFFSET_MS).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' });
        console.log(`    ${startMdt} -> ${endMdt}  (${gapMin.toFixed(0)} min gap)`);
      }
    }
    if (!foundGap) console.log('    None.');
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => { console.error('Script failed:', err); process.exit(1); });
