import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import Lead from '../models/lead.model';
import { buildLeadTimeline } from './communication.controller';
import { generateLeadSummary } from '../services/leadAiSummary.service';

export const getLeadAiSummary = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { id } = req.params;

  const lead = await Lead.findOne({ _id: id, organizationId: orgId })
    .select('aiSummary aiSummaryGeneratedAt')
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  res.json(
    new ApiResponse(
      200,
      { summary: lead.aiSummary || null, generatedAt: lead.aiSummaryGeneratedAt || null },
      'Lead AI summary',
    ),
  );
});

export const regenerateLeadAiSummary = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { id } = req.params;

  const lead = await Lead.findOne({ _id: id, organizationId: orgId });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const timeline = await buildLeadTimeline(orgId, id, { limit: 100 });
  const result = await generateLeadSummary(lead.toObject(), timeline.items);

  if (!result.summary) {
    throw new ApiError(502, result.error || 'Could not generate a summary right now.');
  }

  const now = new Date();
  lead.aiSummary = result.summary;
  lead.aiSummaryGeneratedAt = now;
  await lead.save();

  res.json(new ApiResponse(200, { summary: result.summary, generatedAt: now }, 'Summary regenerated'));
});
