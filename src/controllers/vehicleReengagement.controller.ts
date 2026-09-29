import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import VehicleReengagementLog from '../models/VehicleReengagementLog.model';
import { sendStaffAttributedSms } from '../services/communication.service';
import Lead from '../models/lead.model';

const STATUSES = ['blocked', 'sent', 'failed', 'skipped'];

const serialize = (log: any) => ({
  ...log,
  id: String(log._id),
});

export const listReengagementLogs = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { status } = req.query;

  const filter: Record<string, any> = { organizationId: orgId };
  if (status && STATUSES.includes(status as string)) {
    filter.status = status;
  }

  const [logs, grouped] = await Promise.all([
    VehicleReengagementLog.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
    VehicleReengagementLog.aggregate([
      { $match: { organizationId: orgId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const counts: Record<string, number> = { ALL: 0 };
  for (const s of STATUSES) counts[s] = 0;
  for (const g of grouped) {
    counts[g._id] = g.count;
    counts.ALL += g.count;
  }

  res.json(new ApiResponse(200, { counts, data: logs.map(serialize) }, 'Re-engagement logs'));
});

export const getReengagementLog = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const log = await VehicleReengagementLog.findOne({ _id: req.params.id, organizationId: orgId }).lean();
  if (!log) throw new ApiError(404, 'Re-engagement log not found');
  res.json(new ApiResponse(200, serialize(log), 'Re-engagement log'));
});

export const sendAnyway = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can override a blocked message');

  const log = await VehicleReengagementLog.findOne({ _id: req.params.id, organizationId: orgId });
  if (!log) throw new ApiError(404, 'Re-engagement log not found');
  if (log.status !== 'blocked') throw new ApiError(409, 'This message is no longer blocked');
  if (!log.finalMessage) throw new ApiError(400, 'No message text to send');

  const sent = await sendStaffAttributedSms({
    orgId,
    toPhone: log.leadPhone,
    body: log.finalMessage,
    leadId: log.leadId,
    actor: { userId: String(user._id), name: user.fullName || 'Staff' },
  });

  if (!sent) {
    throw new ApiError(409, 'This customer has opted out of SMS and cannot be messaged');
  }

  const now = new Date();
  log.status = 'sent';
  log.sentAt = now;
  log.overriddenBy = user._id;
  log.overriddenAt = now;
  await log.save();

  await Lead.updateOne(
    { _id: log.leadId },
    {
      $set: { 'followUp.lastReengagementAt': now },
      $inc: { 'followUp.reengagementCount': 1 },
    },
  );

  res.json(new ApiResponse(200, serialize(log.toObject()), 'Message sent'));
});
