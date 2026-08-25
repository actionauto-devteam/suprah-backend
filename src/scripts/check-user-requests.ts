/**
 * One-off diagnostic: shows the raw HTTP request log (from SystemLog, populated
 * by the pino http logger) for a given CrmUser within a time window — used to see
 * whether the tray app was actually reaching the backend (heartbeat, screenshots,
 * break/clock actions) during a specific stretch, independent of the
 * tray-client-diagnostic self-reports (which require a working token to send at all).
 *
 * Usage: npx ts-node src/scripts/check-user-requests.ts "<name>" <startISO> <endISO> [urlFilter]
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import { SystemLog } from '../models/SystemLog.model';

const run = async () => {
  const nameQuery = process.argv[2];
  const startISO = process.argv[3];
  const endISO = process.argv[4];
  const urlFilter = process.argv[5];
  if (!nameQuery || !startISO || !endISO) {
    console.error('Usage: npx ts-node src/scripts/check-user-requests.ts "<name>" <startISO> <endISO> [urlFilter]');
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

  if (users.length === 0) { console.log(`No CrmUser matched "${nameQuery}".`); process.exit(0); }

  for (const user of users) {
    console.log(`\n=== ${user.fullName} <${user.email}> (${user._id}) ===`);
    const query: Record<string, unknown> = {
      'req.userId': user._id.toString(),
      timestamp: { $gte: new Date(startISO), $lte: new Date(endISO) },
    };
    if (urlFilter) query['req.url'] = { $regex: urlFilter };

    const logs = await SystemLog.find(query).sort({ timestamp: 1 })
      .select('timestamp req.method req.url res.statusCode').lean();

    if (logs.length === 0) {
      console.log(`  No requests logged in this window${urlFilter ? ` matching "${urlFilter}"` : ''}.`);
      continue;
    }

    for (const log of logs) {
      console.log(`  [${new Date(log.timestamp).toISOString()}] ${log.req?.method} ${log.req?.url} -> ${log.res?.statusCode ?? '?'}`);
    }
    console.log(`  Total: ${logs.length} request(s)`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => { console.error('Script failed:', err); process.exit(1); });
