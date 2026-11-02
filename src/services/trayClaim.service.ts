import { Request, Response } from 'express';
import mongoose from 'mongoose';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import TimeLog from '../models/TimeLog.model';
import { fireShiftAlert } from './shiftAlerts.service';
import logger from '../utils/logger';

export const TRAY_ACTIVE_ELSEWHERE = 'TRAY_ACTIVE_ELSEWHERE';

const TRAY_ID_HEADER = 'x-tray-id';
const TRAY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const CLAIM_MAX_INPUT_AGE_SEC = 120;

export function readTrayId(req: Request): string | null {
  const raw = req.headers[TRAY_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && TRAY_ID_PATTERN.test(value) ? value : null;
}

async function currentTrackingSegmentId(userId: mongoose.Types.ObjectId | string): Promise<string | null> {
  const last = await TimeLog.findOne({ userId }).sort({ timestamp: -1 }).select('_id type').lean();
  return last && (last.type === 'time-in' || last.type === 'break-out') ? String(last._id) : null;
}

async function claimForSegment(
  userId: mongoose.Types.ObjectId | string,
  segmentId: string,
  trayId: string,
): Promise<boolean> {
  try {
    const doc = await AgentHeartbeat.findOneAndUpdate(
      {
        userId,
        $or: [
          { activeTraySegmentId: { $ne: segmentId } },
          { activeTrayId: null },
          { activeTrayId: trayId },
        ],
      },
      { $set: { activeTrayId: trayId, activeTraySegmentId: segmentId } },
      { new: true, upsert: true },
    ).select('activeTrayId').lean();
    return doc?.activeTrayId === trayId;
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const current = await AgentHeartbeat.findOne({ userId }).select('activeTrayId activeTraySegmentId').lean();
    return current?.activeTraySegmentId === segmentId && current?.activeTrayId === trayId;
  }
}

async function alertSecondComputer(params: TrayAccessParams, segmentId: string, trayId: string): Promise<void> {
  if (!params.organizationId) return;
  const key = `${segmentId}:${trayId}`;
  const res = await AgentHeartbeat.updateOne(
    { userId: params.userId, standbyAlertKey: { $ne: key } },
    { $set: { standbyAlertKey: key } },
  );
  if (!res.modifiedCount) return;
  await fireShiftAlert({
    organizationId: params.organizationId,
    targetUserId: String(params.userId),
    targetUserModel: params.userModel,
    chatMessage: `🖥️ ${params.displayName} opened Timeproof on a second computer while it is running on another one. The second computer is on standby — no screenshots or idle tracking there.`,
    notifyTitle: '🖥️ Timeproof Is Running on Another Computer',
    notifyBody: 'Timeproof is already running on your other computer, so this one is on standby. To switch, take a break or end your shift there, then continue here.',
    adminNotifyBody: `${params.displayName} opened Timeproof on a second computer. That computer is on standby while the first one keeps tracking.`,
    notifyTag: `shift-alert-second-computer-${params.userId}`,
    url: `/crm/timeproof/users/${params.userId}`,
  });
}

interface TrayAccessParams {
  req: Request;
  userId: mongoose.Types.ObjectId | string;
  userModel: 'CrmUser' | 'User';
  organizationId?: string | null;
  displayName: string;
  inputAgeSec?: unknown;
}

export async function checkTrayAccess(params: TrayAccessParams): Promise<boolean> {
  const trayId = readTrayId(params.req);
  if (!trayId) return true;

  const segmentId = await currentTrackingSegmentId(params.userId);
  if (!segmentId) return true;

  const heartbeat = await AgentHeartbeat.findOne({ userId: params.userId })
    .select('activeTrayId activeTraySegmentId')
    .lean();

  if (heartbeat?.activeTrayId && heartbeat.activeTraySegmentId === segmentId) {
    if (heartbeat.activeTrayId === trayId) return true;
    alertSecondComputer(params, segmentId, trayId).catch((err) => {
      logger.error({ err, userId: String(params.userId) }, '[trayClaim] Failed to send second-computer alert');
    });
    return false;
  }

  const inputAgeSec = typeof params.inputAgeSec === 'number' ? params.inputAgeSec : Number.NaN;
  const hasRecentInput = Number.isFinite(inputAgeSec) && inputAgeSec >= 0 && inputAgeSec <= CLAIM_MAX_INPUT_AGE_SEC;
  if (!hasRecentInput) return true;

  const claimed = await claimForSegment(params.userId, segmentId, trayId);
  if (!claimed) {
    alertSecondComputer(params, segmentId, trayId).catch((err) => {
      logger.error({ err, userId: String(params.userId) }, '[trayClaim] Failed to send second-computer alert');
    });
  }
  return claimed;
}

export function sendTrayActiveElsewhere(res: Response): void {
  res.status(409).json({
    statusCode: 409,
    success: false,
    code: TRAY_ACTIVE_ELSEWHERE,
    message: 'Timeproof is already running on another computer.',
  });
}
