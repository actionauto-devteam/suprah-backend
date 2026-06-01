import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';
import Deal, { DealStage } from '../models/Deal.model';
import { emitToOrg } from '../utils/socketEmitter';

const STAGES: DealStage[] = ['lead', 'contacted', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

const getDeals = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const deals = await Deal.find({ organizationId: orgId })
        .sort({ stage: 1, sortOrder: 1, createdAt: -1 })
        .lean();
    res.json(new ApiResponse(200, deals, 'Deals fetched'));
});

const createDeal = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { title, company, contactName, value, currency, stage, probability, assignedTo, assignedName, assignedAvatar, expectedCloseDate, note, tags } = req.body;

    if (!title?.trim()) throw new ApiError(400, 'title is required');

    const deal = await Deal.create({
        organizationId: orgId,
        title: title.trim(),
        company: company?.trim(),
        contactName: contactName?.trim(),
        value: value != null ? Number(value) : null,
        currency: currency || 'USD',
        stage: STAGES.includes(stage) ? stage : 'lead',
        probability: probability != null ? Number(probability) : null,
        assignedTo: assignedTo || null,
        assignedName: assignedName?.trim() || null,
        assignedAvatar: assignedAvatar || null,
        expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : null,
        note: note?.trim(),
        tags: Array.isArray(tags) ? tags : [],
        createdBy: user._id,
        createdByName: user.name,
    });

    emitToOrg(orgId, 'deal:created', { _id: deal._id, title: deal.title, stage: deal.stage });
    res.status(201).json(new ApiResponse(201, deal, 'Deal created'));
});

const updateDeal = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { title, company, contactName, value, currency, stage, probability, assignedTo, assignedName, assignedAvatar, expectedCloseDate, note, tags } = req.body;

    const deal = await Deal.findOne({ _id: id, organizationId: orgId });
    if (!deal) throw new ApiError(404, 'Deal not found');

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    const isOwner = deal.createdBy.toString() === user._id.toString();
    if (!isAdmin && !isOwner) throw new ApiError(403, 'Not authorized');

    if (title?.trim()) deal.title = title.trim();
    if (company !== undefined) deal.company = company?.trim();
    if (contactName !== undefined) deal.contactName = contactName?.trim();
    if (value !== undefined) deal.value = value != null ? Number(value) : null;
    if (currency) deal.currency = currency;
    if (stage && STAGES.includes(stage)) deal.stage = stage;
    if (probability !== undefined) deal.probability = probability != null ? Number(probability) : null;
    if (assignedTo !== undefined) deal.assignedTo = assignedTo || null;
    if (assignedName !== undefined) deal.assignedName = assignedName?.trim() || null;
    if (assignedAvatar !== undefined) deal.assignedAvatar = assignedAvatar || null;
    if (expectedCloseDate !== undefined) deal.expectedCloseDate = expectedCloseDate ? new Date(expectedCloseDate) : null;
    if (note !== undefined) deal.note = note?.trim();
    if (Array.isArray(tags)) deal.tags = tags;

    await deal.save();
    emitToOrg(orgId, 'deal:updated', { _id: deal._id, stage: deal.stage });
    res.json(new ApiResponse(200, deal, 'Deal updated'));
});

const moveDeal = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { stage, sortOrder } = req.body;

    if (!STAGES.includes(stage)) throw new ApiError(400, 'Invalid stage');

    const deal = await Deal.findOne({ _id: id, organizationId: orgId });
    if (!deal) throw new ApiError(404, 'Deal not found');

    deal.stage = stage;
    if (sortOrder != null) deal.sortOrder = Number(sortOrder);
    await deal.save();

    emitToOrg(orgId, 'deal:moved', { _id: deal._id, stage, sortOrder: deal.sortOrder });
    res.json(new ApiResponse(200, deal, 'Deal moved'));
});

const reorderDeals = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { orderedIds } = req.body as { orderedIds: string[] };

    if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedIds must be an array');

    await Promise.all(orderedIds.map((dealId, index) =>
        Deal.updateOne({ _id: dealId, organizationId: orgId }, { sortOrder: index })
    ));

    res.json(new ApiResponse(200, null, 'Order updated'));
});

const deleteDeal = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;

    const deal = await Deal.findOne({ _id: id, organizationId: orgId });
    if (!deal) throw new ApiError(404, 'Deal not found');

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    const isOwner = deal.createdBy.toString() === user._id.toString();
    if (!isAdmin && !isOwner) throw new ApiError(403, 'Not authorized');

    await deal.deleteOne();
    emitToOrg(orgId, 'deal:deleted', { _id: id });
    res.json(new ApiResponse(200, null, 'Deal deleted'));
});

export default { getDeals, createDeal, updateDeal, moveDeal, reorderDeals, deleteDeal };
