import TimeLog from '../models/TimeLog.model';
import { getSocketIO } from '../utils/socketEmitter';
import { fireShiftAlert } from './shiftAlerts.service';
import logger from '../utils/logger';

/**
 * Writes the auto-clockout TimeLog entry AND pushes a live 'time-out' socket event to the
 * user's own room so the tray finds out immediately instead of waiting for its next
 * syncShiftState poll — the same shape resumeShift already uses for 'time-in'
 * (crmTimeproof.controller.ts) and the tray's socket.ts already listens for. Then fires the
 * admin+employee+Shift-Alerts-channel notification via fireShiftAlert.
 *
 * staleShiftAutoClockout.scheduler.ts's own two closures are structurally similar (TimeLog
 * write for a silence-based close) but are left as-is — that scheduler's behavior is proven
 * and unrelated to this feature; this helper exists for the new staged-idle-escalation close
 * (and its tray-local last-resort fallback), not to replace the scheduler's own writes.
 */
export async function closeShiftForInactivity(params: {
  userId: string;
  userModel: 'CrmUser' | 'User';
  organizationId: string;
  displayName: string;
  closeNote: string;
  chatMessage: string;
  notifyTitle: string;
  notifyBody: string;
  adminNotifyBody: string;
  adminNotifyType?: string;
  notifyTag: string;
  closeAt?: Date;
}): Promise<void> {
  const {
    userId, userModel, organizationId, closeNote, chatMessage,
    notifyTitle, notifyBody, adminNotifyBody, adminNotifyType, notifyTag, closeAt,
  } = params;

  const log = await TimeLog.create({
    userId,
    userModel,
    type: 'time-out',
    timestamp: closeAt ?? new Date(),
    note: closeNote,
  });

  try {
    getSocketIO()?.to(`user:${userId}`).emit('time-out', {
      _id: log._id,
      type: 'time-out',
      timestamp: log.timestamp,
    });
  } catch (err) {
    logger.error({ err, userId }, '[autoClockout] Failed to push live time-out socket event');
  }

  await fireShiftAlert({
    organizationId,
    targetUserId: userId,
    targetUserModel: userModel,
    chatMessage,
    notifyTitle,
    notifyBody,
    adminNotifyBody,
    adminNotifyType,
    notifyTag,
    url: '/crm/timeproof-clock',
  });
}
