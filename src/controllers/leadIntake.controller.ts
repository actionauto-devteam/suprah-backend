import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { isOrganizationAdmin } from '../services/contactRestriction.service';
import { getLeadIntakeControl, setLeadIntakeMode } from '../services/leadIntakeControl.service';
import {
  canResolveLeadReviews,
  countPendingLeadReviews,
  findActiveLeadForClosedLead,
  linkUnverifiedLead,
  listLeadReviews,
  resolveLeadReview,
  startFreshLeadFromClosedLead,
} from '../services/leadIntakeReview.service';

function staffOf(req: Request) {
  const user: any = (req as any).user || (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  return {
    user,
    actor: { userId: user._id ? String(user._id) : null, name: user.fullName || user.name || user.email || null },
  };
}

export const getIntakeControl = asyncHandler(async (req: Request, res: Response) => {
  const { user } = staffOf(req);
  const orgId = String((req as any).orgId || '');
  const control = await getLeadIntakeControl(orgId);
  const canManage = await isOrganizationAdmin(user, orgId);
  res.json(new ApiResponse(200, { ...control, canManage }, 'Lead intake setting'));
});

export const updateIntakeControl = asyncHandler(async (req: Request, res: Response) => {
  const { user, actor } = staffOf(req);
  const orgId = String((req as any).orgId || '');
  if (!(await isOrganizationAdmin(user, orgId))) {
    throw new ApiError(403, 'Only an organization admin can change lead intake.');
  }
  const result = await setLeadIntakeMode({ organizationId: orgId, mode: req.body?.mode, reason: req.body?.reason, actor });
  const control = await getLeadIntakeControl(orgId);
  res.json(new ApiResponse(200, { ...control, previousMode: result.previousMode, canManage: true }, 'Lead intake updated'));
});

async function requireReviewer(req: Request) {
  const { user, actor } = staffOf(req);
  const orgId = String((req as any).orgId || '');
  if (!(await canResolveLeadReviews(user, orgId))) {
    throw new ApiError(403, 'Only an organization admin or an authorized manager can do this.');
  }
  return { orgId, actor };
}

export const getLeadReviews = asyncHandler(async (req: Request, res: Response) => {
  const { user } = staffOf(req);
  const orgId = String((req as any).orgId || '');
  const [items, pending, canResolve] = await Promise.all([
    listLeadReviews(orgId, {
      state: String(req.query.state || 'pending'),
      limit: Number(req.query.limit) || undefined,
      before: req.query.before ? String(req.query.before) : undefined,
    }),
    countPendingLeadReviews(orgId),
    canResolveLeadReviews(user, orgId),
  ]);
  res.json(new ApiResponse(200, { items, pending, canResolve }, 'Leads that need review'));
});

export const getLeadReviewCount = asyncHandler(async (req: Request, res: Response) => {
  const { user } = staffOf(req);
  const orgId = String((req as any).orgId || '');
  const [pending, canResolve, control] = await Promise.all([
    countPendingLeadReviews(orgId),
    canResolveLeadReviews(user, orgId),
    getLeadIntakeControl(orgId),
  ]);
  res.json(new ApiResponse(200, { pending, canResolve, intakeMode: control.mode }, 'Leads that need review'));
});

export const resolveReview = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = await requireReviewer(req);
  const result = await resolveLeadReview({
    organizationId: orgId,
    inquiryId: String(req.params.inquiryId),
    resolution: req.body?.resolution,
    leadId: req.body?.leadId ? String(req.body.leadId) : null,
    note: req.body?.note ? String(req.body.note) : null,
    actor,
  });
  res.json(new ApiResponse(200, result, 'Review saved'));
});

export const linkLead = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = await requireReviewer(req);
  const result = await linkUnverifiedLead({
    organizationId: orgId,
    leadId: String(req.params.leadId),
    targetLeadId: String(req.body?.targetLeadId || ''),
    note: req.body?.note ? String(req.body.note) : null,
    actor,
  });
  res.json(new ApiResponse(200, result, 'Chat linked to the lead'));
});

export const getActiveLead = asyncHandler(async (req: Request, res: Response) => {
  staffOf(req);
  const orgId = String((req as any).orgId || '');
  res.json(new ApiResponse(200, await findActiveLeadForClosedLead(orgId, String(req.params.leadId)), 'Active lead'));
});

export const startFreshLead = asyncHandler(async (req: Request, res: Response) => {
  const { actor } = staffOf(req);
  const orgId = String((req as any).orgId || '');
  const result = await startFreshLeadFromClosedLead({
    organizationId: orgId,
    leadId: String(req.params.leadId),
    note: req.body?.note ? String(req.body.note) : null,
    actor,
  });
  const leadId = result.status === 'associated' || result.status === 'duplicate' ? result.leadId : null;
  res.status(leadId ? 201 : 202).json(new ApiResponse(leadId ? 201 : 202, { ...result, leadId }, leadId ? 'Lead ready' : 'Sent for review'));
});
