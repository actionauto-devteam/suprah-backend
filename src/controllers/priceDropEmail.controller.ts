import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import PriceDropEmailLog from '../models/PriceDropEmailLog.model';

const STATUSES = ['sent', 'skipped', 'failed'];

const serialize = (log: any) => ({
  ...log,
  id: String(log._id),
});

export const listPriceDropLogs = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { status } = req.query;

  const filter: Record<string, any> = { organizationId: orgId };
  if (status && STATUSES.includes(status as string)) {
    filter.status = status;
  }

  const [logs, grouped] = await Promise.all([
    PriceDropEmailLog.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
    PriceDropEmailLog.aggregate([
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

  res.json(new ApiResponse(200, { counts, data: logs.map(serialize) }, 'Price drop email logs'));
});

export const getPriceDropLog = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const log = await PriceDropEmailLog.findOne({ _id: req.params.id, organizationId: orgId }).lean();
  if (!log) throw new ApiError(404, 'Price drop email log not found');
  res.json(new ApiResponse(200, serialize(log), 'Price drop email log'));
});
