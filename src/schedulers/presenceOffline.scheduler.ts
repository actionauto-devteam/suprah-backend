import cron from 'node-cron';
import logger from '../utils/logger';
import User from '../models/User.model';
import { emitPresenceUpdate } from '../utils/socketEmitter';

/**
 * Same 2-minute staleness window teamPulse.controller.ts's getMembers() already uses to
 * downgrade a stale heartbeat to "offline" for display — kept as a literal here (not
 * imported) since that value isn't exported and the two are allowed to drift independently
 * later. Must stay small: this is the gap between someone's tab/app actually going away and
 * every other connected client finding out.
 */
const PRESENCE_TTL_MS = 2 * 60 * 1000;

/**
 * getMembers() only ever computes "offline" for a stale heartbeat at READ time — a client
 * relying purely on the `presence_update` socket feed (see usePresenceSocket.ts) never
 * receives that downgrade, because nothing proactively emits it: online→away and any
 * manual change are pushed live via heartbeat/profile updates, but online/away→offline
 * had no equivalent push. A user whose tab/app simply goes away (closed, crashed, device
 * slept, connection dropped) keeps reading as their last known status on every socket-only
 * client until that client's own next REST poll happens to catch it — which can lag well
 * behind 2 minutes if that tab is backgrounded (TanStack Query pauses refetchInterval
 * off-screen by default). This sweep closes that gap by actively finding newly-stale users
 * and pushing the same "offline" correction everyone would eventually get from a fetch.
 */
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

    // Re-check-and-set in one atomic op, still scoped to the same conditions as the find()
    // above — guards against a heartbeat landing between the find() and this update (which
    // would otherwise stomp a status the user just legitimately refreshed).
    const updated = await User.findOneAndUpdate(
      {
        _id: user._id,
        onlineStatus: { $in: ['online', 'away'] },
        statusIsManual: { $ne: true },
        lastActive: { $lt: cutoff },
      },
      { onlineStatus: 'offline' },
      { new: true },
    ).select('onlineStatus lastActive lastDeviceType customStatus').lean();
    if (!updated) continue;

    await emitPresenceUpdate(user.organizationId.toString(), {
      userId: user._id.toString(),
      email: user.email,
      onlineStatus: 'offline',
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
