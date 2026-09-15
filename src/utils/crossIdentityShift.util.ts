import TimeLog from '../models/TimeLog.model';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';

const LOOKBACK_DAYS = 2;

async function getOpenShiftForUserId(userId: string): Promise<{ shiftStartedAt: Date } | null> {
  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - LOOKBACK_DAYS);
  lookbackStart.setHours(0, 0, 0, 0);

  const logs = await TimeLog.find({
    userId,
    timestamp: { $gte: lookbackStart },
  }).sort({ timestamp: 1 }).select('type timestamp').lean();

  let isOnShift = false;
  let shiftStartedAt: Date | null = null;
  for (const log of logs) {
    if (log.type === 'time-in') {
      isOnShift = true;
      shiftStartedAt = log.timestamp;
    } else if (log.type === 'time-out') {
      isOnShift = false;
      shiftStartedAt = null;
    }
  }

  return isOnShift && shiftStartedAt ? { shiftStartedAt } : null;
}

/**
 * Checks whether the same real person (matched by email — the only existing link between
 * CrmUser and User docs) already has an open shift under their OTHER identity model. Used to
 * block a second, parallel time-in before it creates a "ghost" duplicate shift that never gets
 * manually clocked out — see the Ronalyn Obeso-Joye incident: two accounts sharing one email,
 * one genuinely used and correctly closed each day, the other silently left open and force-
 * closed at midnight with a confusing "shift auto-ended" admin alert about a shift nobody
 * consciously started.
 */
export async function findOpenShiftOnOtherIdentity(
  email: string,
  ownModel: 'CrmUser' | 'User',
): Promise<{ model: 'CrmUser' | 'User'; shiftStartedAt: Date } | null> {
  if (!email) return null;

  if (ownModel === 'CrmUser') {
    const mainUser = await User.findOne({ email }).select('_id').lean();
    if (!mainUser) return null;
    const open = await getOpenShiftForUserId(mainUser._id.toString());
    return open ? { model: 'User', shiftStartedAt: open.shiftStartedAt } : null;
  }

  const crmUser = await CrmUser.findOne({ email }).select('_id').lean();
  if (!crmUser) return null;
  const open = await getOpenShiftForUserId(crmUser._id.toString());
  return open ? { model: 'CrmUser', shiftStartedAt: open.shiftStartedAt } : null;
}
