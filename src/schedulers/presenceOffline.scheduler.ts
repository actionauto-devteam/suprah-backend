import cron from 'node-cron';
import logger from '../utils/logger';
import User from '../models/User.model';
import { emitPresenceUpdate } from '../utils/socketEmitter';

// Use same 2‑minute staleness window as teamPulse.controller.ts getMembers()
// to mark heartbeat as offline; kept literal here for independence
const PRESENCE_TTL_MS = 2 * 60 * 1000;

// Sweep proactively downgrades stale heartbeats to "offline" and pushes updates,
// filling the gap for socket-only clients that miss the read-time downgrade.
export async function runPresenceOfflineSweep(): Promise<{ demoted: number }> {
  const cutoff = new Date(Date.now() - PRESENCE_TTL_MS);

  const stale = await User.find({
    onlineStatus: { $in: ['online', 'away'] },
    statusIsManual: { $ne: true },
    lastActive: { $lt: cutoff },
  })
    .select('_id organizationId email')
    .lean();

  let demoted = 0;
  for (const user of stale) {
    if (!user.organizationId) continue;

    // Atomic re-check-and-set prevents overwriting a fresh heartbeat;
    // ensures update only applies if conditions still
    const updated = await User.findOneAndUpdate(
      {
        _id: user._id,
        onlineStatus: { $in: ["online", "away"] },
        statusIsManual: { $ne: true },
        lastActive: { $lt: cutoff },
      },
      { onlineStatus: "offline" },
      { new: true },
    )
      .select("onlineStatus lastActive lastDeviceType customStatus")
      .lean();
    if (!updated) continue;

    await emitPresenceUpdate(user.organizationId.toString(), {
      userId: user._id.toString(),
      email: user.email,
      onlineStatus: "offline",
      customStatus: updated.customStatus ?? null,
      lastActive: updated.lastActive?.toISOString(),
      lastDeviceType: updated.lastDeviceType ?? null,
    });
    demoted++;
  }

  return { demoted };
}

export const initPresenceOfflineScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const { demoted } = await runPresenceOfflineSweep();
      if (demoted > 0) logger.info(`[presence-offline] Pushed offline correction for ${demoted} stale user(s)`);
    } catch (error) {
      logger.error({ error }, 'Presence-offline scheduler error');
    }
  });

  logger.info('✓ Presence-offline scheduler initialized - Runs every 1 minute');
};
