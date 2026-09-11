import mongoose from 'mongoose';
import config from '../config';
import { SystemLog } from '../models/SystemLog.model';

const STABILITY_EVENTS = [
  'main_thread_stall',
  'main_uncaught_exception',
  'main_unhandled_rejection',
  'render_process_gone',
  'child_process_gone',
  'status_window_unresponsive',
  'status_window_responsive',
  'interval_error',
  'capture_timeout',
  'user_present_cleared_idle',
  'resume_from_suspend',
];

const run = async () => {
  const daysBack = parseInt(process.argv[2] || '3', 10);

  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  const logs = await SystemLog.find({
    context: 'tray-client-diagnostic',
    event: { $in: STABILITY_EVENTS },
    timestamp: { $gte: since },
  }).sort({ timestamp: 1 }).select('timestamp event message meta req').lean();

  console.log(`\nWindow: last ${daysBack} day(s), since ${since.toISOString()}`);
  console.log(`Total stability diagnostic entries: ${logs.length}\n`);

  if (logs.length === 0) {
    console.log('No stability diagnostics reported yet.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const countsByEvent = new Map<string, number>();
  const usersByEvent = new Map<string, Set<string>>();
  for (const log of logs) {
    const event = log.event || '(unknown)';
    countsByEvent.set(event, (countsByEvent.get(event) || 0) + 1);
    const userId = log.req?.userId || '(unknown)';
    if (!usersByEvent.has(event)) usersByEvent.set(event, new Set());
    usersByEvent.get(event)!.add(userId);
  }

  console.log('By event type:');
  for (const event of STABILITY_EVENTS) {
    const count = countsByEvent.get(event) || 0;
    if (count === 0) continue;
    const userCount = usersByEvent.get(event)?.size || 0;
    console.log(`  ${event}: ${count} occurrence(s) across ${userCount} user(s)`);
  }

  const stalls = logs.filter((l) => l.event === 'main_thread_stall');
  if (stalls.length > 0) {
    const blockedMsValues = stalls.map((l) => Number(l.meta?.blockedMs) || 0);
    const total = blockedMsValues.reduce((sum, v) => sum + v, 0);
    const max = Math.max(...blockedMsValues);
    const avg = Math.round(total / blockedMsValues.length);
    console.log(`\nMain-thread stalls: ${stalls.length} — avg ${avg}ms, max ${max}ms, total blocked ${Math.round(total / 1000)}s`);
    const worst = [...stalls].sort((a, b) => (Number(b.meta?.blockedMs) || 0) - (Number(a.meta?.blockedMs) || 0)).slice(0, 10);
    console.log('Worst 10 stalls:');
    for (const l of worst) {
      console.log(`  [${new Date(l.timestamp).toISOString()}] userId=${l.req?.userId || '?'} blockedMs=${l.meta?.blockedMs} platform=${l.meta?.platform}`);
    }
  }

  const crashLike = logs.filter((l) =>
    ['main_uncaught_exception', 'main_unhandled_rejection', 'render_process_gone', 'child_process_gone', 'interval_error'].includes(l.event || '')
  );
  if (crashLike.length > 0) {
    console.log(`\nCrash-like events: ${crashLike.length}`);
    for (const l of crashLike) {
      console.log(`  [${new Date(l.timestamp).toISOString()}] ${l.event} userId=${l.req?.userId || '?'} — ${l.message}`);
    }
  }

  const captureTimeouts = logs.filter((l) => l.event === 'capture_timeout');
  if (captureTimeouts.length > 0) {
    console.log(`\nCapture timeouts: ${captureTimeouts.length}`);
  }

  const clearedIdle = logs.filter((l) => l.event === 'user_present_cleared_idle');
  if (clearedIdle.length > 0) {
    console.log(`\nFalse-idle self-corrections: ${clearedIdle.length}`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
