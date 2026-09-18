import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import TimeLog from '../models/TimeLog.model';
import { SystemLog } from '../models/SystemLog.model';
import { storageService, BucketType } from '../services/storage.service';

const NAMES = ['Krizza Pepito', 'Marielle Babano', 'Charmi Rimando', 'Sheryl Rose Bompat'];

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  await mongoose.connect(databaseUri);
  console.log('Connected.\n');

  const dayStart = new Date('2026-09-17T00:00:00.000Z');
  const dayEnd = new Date('2026-09-18T00:00:00.000Z');

  for (const name of NAMES) {
    const user = await CrmUser.findOne({ fullName: name }).select('_id fullName email').lean();
    console.log(`\n========== ${name} ==========`);
    if (!user) {
      console.log('  NOT FOUND as CrmUser.');
      continue;
    }
    const userId = user._id.toString();
    console.log(`  userId=${userId}`);

    const hb = await AgentHeartbeat.findOne({ userId: user._id }).lean();
    console.log('\n  --- Current AgentHeartbeat ---');
    console.log('  ', JSON.stringify(hb, null, 2));

    const logs = await TimeLog.find({ userId: user._id, timestamp: { $gte: dayStart, $lt: dayEnd } })
      .sort({ timestamp: 1 }).select('type timestamp note').lean();
    console.log('\n  --- TimeLog entries today ---');
    for (const l of logs) console.log(`    [${new Date(l.timestamp).toISOString()}] ${l.type} — ${l.note || ''}`);

    const diagLogs = await SystemLog.find({
      context: 'tray-client-diagnostic',
      'req.userId': userId,
      timestamp: { $gte: dayStart, $lt: dayEnd },
    }).sort({ timestamp: 1 }).select('timestamp event message meta').lean();
    console.log(`\n  --- tray-client-diagnostic entries today (${diagLogs.length}) ---`);
    for (const d of diagLogs) {
      console.log(`    [${new Date(d.timestamp).toISOString()}] ${d.event ?? '(no event)'} — ${d.message}`);
      if (d.meta && Object.keys(d.meta).length) console.log(`      meta: ${JSON.stringify(d.meta)}`);
    }

    try {
      const prefix = `idle-recordings/${userId}/2026-09-17/`;
      const objs = await storageService.list(prefix, BucketType.PRIVATE);
      console.log(`\n  --- R2 idle-recordings objects for 2026-09-17 (${objs.length}) ---`);
      for (const o of objs) console.log(`    ${o.key}  (modified ${o.lastModified ?? '?'})`);
    } catch (err) {
      console.log('  --- R2 listing failed:', err);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
