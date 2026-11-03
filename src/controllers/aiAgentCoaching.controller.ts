import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import Lead from '../models/lead.model';
import AiAgentLog from '../models/AiAgentLog.model';
import AiAgentCoachingRule from '../models/AiAgentCoachingRule.model';
import WebChatMessage from '../models/WebChatMessage.model';
import { CommunicationMessage } from '../models/communication.model';
import { submitCoachingAsProposal, trainingActor, writeTrainingAudit } from '../services/aiTraining.service';
import { strictInstructionIssues } from '../services/aiTrainingSafetyGate';
import { moneyFigures, sameMoneyFigures } from '../utils/aiMoneyAmounts';

const AI_AGENT_ACTOR_ID = 'ai-agent';
const MANAGER_ROLES = new Set(['manager', 'admin', 'super_admin']);

const actor = (req: Request) => (req as any).crmUser || (req as any).user;

const actorName = (user: any) =>
  user?.fullName ||
  user?.name ||
  [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
  user?.email ||
  'Team member';

const isManager = (user: any) => MANAGER_ROLES.has(String(user?.role || ''));

function requireAmountDecision(instruction: string, allowed: unknown): string[] {
  const amounts = moneyFigures(instruction);
  requireSafeCoaching(instruction, amounts.length > 0);
  if (amounts.length && allowed !== true) {
    throw new ApiError(400, `This coaching includes money amounts: ${amounts.join(', ')}. Confirm that the AI agent may tell customers these exact amounts.`, [
      { field: 'instruction', code: 'amounts_need_approval', message: 'Confirm the money amounts before saving.', amounts },
    ]);
  }
  return amounts;
}

const amountApprovalFor = (user: any, amounts: string[]) => ({
  amounts,
  approvedBy: user._id,
  approvedByName: actorName(user),
  approvedAt: new Date(),
});

function requireSafeCoaching(instruction: string, allowMoney = false): void {
  const blockers = strictInstructionIssues(instruction, { allowMoney });
  if (blockers.length) throw new ApiError(400, `This coaching can't be saved. ${blockers[0].message}`, blockers);
}

function requireSafeReactivation(instruction: string, approvedAmounts?: unknown): void {
  const blockers = strictInstructionIssues(instruction, { allowMoney: sameMoneyFigures(approvedAmounts, moneyFigures(instruction)) });
  if (blockers.length) {
    throw new ApiError(400, `This coaching can't be turned back on. ${blockers[0].message} It stays disabled until its text is updated.`, blockers);
  }
}

const serialize = (rule: any) => ({
  ...rule,
  id: String(rule._id),
});

const orgIdVariants = (organizationId: string) => {
  const values: any[] = [organizationId];
  if (mongoose.isValidObjectId(organizationId)) {
    values.push(new mongoose.Types.ObjectId(organizationId));
  }
  return values;
};

async function loadVerifiedAiMessage(input: {
  organizationId: string;
  leadId: string;
  channel: 'sms' | 'webchat';
  messageId: string;
}) {
  if (!mongoose.isValidObjectId(input.leadId) || !mongoose.isValidObjectId(input.messageId)) {
    throw new ApiError(400, 'Invalid lead or message id');
  }

  const lead = await Lead.findOne({ _id: input.leadId, organizationId: input.organizationId })
    .select('_id')
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  if (input.channel === 'sms') {
    const message = await CommunicationMessage.findOne({
      _id: input.messageId,
      orgId: { $in: orgIdVariants(input.organizationId) },
      leadId: input.leadId,
      direction: 'outbound',
      'sentBy.userId': AI_AGENT_ACTOR_ID,
    }).lean() as any;
    if (!message) throw new ApiError(404, 'AI Agent SMS message not found');
    return {
      message,
      sourceMessageModel: 'CommunicationMessage' as const,
      originalAiMessageSnapshot: String(message.body || '').trim(),
    };
  }

  const message = await WebChatMessage.findOne({
    _id: input.messageId,
    organizationId: input.organizationId,
    leadId: input.leadId,
    direction: 'outbound',
    'sentBy.userId': AI_AGENT_ACTOR_ID,
  }).lean() as any;
  if (!message) throw new ApiError(404, 'AI Agent webchat message not found');
  return {
    message,
    sourceMessageModel: 'WebChatMessage' as const,
    originalAiMessageSnapshot: String(message.body || '').trim(),
  };
}

export const listAiAgentCoaching = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const status = String(req.query.status || 'active');
  const allowedStatuses = ['active', 'disabled', 'deleted'];
  const filter: Record<string, any> = { organizationId: orgId };
  if (allowedStatuses.includes(status)) filter.status = status;
  else filter.status = { $ne: 'deleted' };

  const rules = await AiAgentCoachingRule.find(filter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(100)
    .lean();

  res.json(new ApiResponse(200, { data: rules.map(serialize) }, 'AI coaching rules'));
});

export const createAiAgentCoaching = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = actor(req);
  if (!user) throw new ApiError(401, 'Please authenticate');

  const instruction = String(req.body?.instruction || '').trim();
  const channel = req.body?.channel === 'webchat' ? 'webchat' : req.body?.channel === 'sms' ? 'sms' : null;
  const leadId = String(req.body?.leadId || '');
  const messageId = String(req.body?.messageId || '');
  if (!instruction) throw new ApiError(400, 'Coaching feedback is required');
  if (instruction.length > 800) throw new ApiError(400, 'Coaching feedback is too long');
  if (!channel) throw new ApiError(400, 'Channel is required');

  const verified = await loadVerifiedAiMessage({ organizationId: orgId, leadId, channel, messageId });
  const log = await AiAgentLog.findOne({
    organizationId: orgId,
    leadId,
    channel,
    messageId,
    status: { $in: ['sent', 'fallback_sent'] },
  })
    .sort({ createdAt: -1 })
    .select('_id')
    .lean();

  if (!isManager(user)) {
    const { policy, created } = await submitCoachingAsProposal({
      organizationId: orgId,
      user,
      instruction,
      channel,
      leadId,
      messageId,
      messageModel: verified.sourceMessageModel,
      aiLogId: log?._id,
      originalAiMessageSnapshot: verified.originalAiMessageSnapshot,
    });
    res.status(202).json(new ApiResponse(202, {
      pending: true,
      created,
      proposalId: String(policy._id),
      status: policy.status,
    }, 'Coaching sent to a manager for review'));
    return;
  }

  const amounts = requireAmountDecision(instruction, req.body?.allowAmounts);
  const rule = await AiAgentCoachingRule.create({
    organizationId: orgId,
    scope: 'organization',
    channel: 'all',
    instruction,
    status: 'active',
    sourceLeadId: leadId,
    sourceMessageId: messageId,
    sourceMessageModel: verified.sourceMessageModel,
    sourceAiLogId: log?._id,
    originalAiMessageSnapshot: verified.originalAiMessageSnapshot,
    createdBy: user._id,
    createdByName: actorName(user),
    ...(amounts.length ? { amountApproval: amountApprovalFor(user, amounts) } : {}),
  });
  await writeTrainingAudit({
    organizationId: orgId,
    action: 'legacy_coaching_created',
    actor: trainingActor(user),
    legacyCoachingRuleId: rule._id,
    toStatus: 'active',
  });

  res.status(201).json(new ApiResponse(201, serialize(rule.toObject()), 'AI coaching saved'));
});

export const updateAiAgentCoaching = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = actor(req);
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (!isManager(user)) throw new ApiError(403, 'Only managers or admins can manage AI coaching');
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid coaching id');

  const setValues: Record<string, any> = { updatedBy: user._id };
  const unsetValues: Record<string, ''> = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'instruction')) {
    const instruction = String(req.body?.instruction || '').trim();
    if (!instruction) throw new ApiError(400, 'Coaching feedback is required');
    if (instruction.length > 800) throw new ApiError(400, 'Coaching feedback is too long');
    const amounts = requireAmountDecision(instruction, req.body?.allowAmounts);
    setValues.instruction = instruction;
    if (amounts.length) setValues.amountApproval = amountApprovalFor(user, amounts);
    else unsetValues.amountApproval = '';
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
    const status = String(req.body?.status || '');
    if (!['active', 'disabled'].includes(status)) throw new ApiError(400, 'Invalid coaching status');
    setValues.status = status;
    if (status === 'disabled') {
      setValues.disabledAt = new Date();
      setValues.disabledBy = user._id;
    }
  }

  const filter: Record<string, any> = { _id: req.params.id, organizationId: orgId, status: { $ne: 'deleted' } };
  let guarded = false;
  if (setValues.status === 'active' && !Object.prototype.hasOwnProperty.call(setValues, 'instruction')) {
    const current = await AiAgentCoachingRule.findOne(filter).select('status instruction amountApproval').lean() as any;
    if (!current) throw new ApiError(404, 'Coaching rule not found');
    filter.status = current.status;
    if (current.status !== 'active') {
      requireSafeReactivation(String(current.instruction || ''), current.amountApproval?.amounts);
      if (current.instruction === undefined || current.instruction === null) filter.instruction = null;
      else filter.$expr = { $eq: ['$instruction', current.instruction] };
    }
    guarded = true;
  }

  const update: Record<string, any> = { $set: setValues };
  if (setValues.status === 'active') Object.assign(unsetValues, { disabledAt: '', disabledBy: '' });
  if (Object.keys(unsetValues).length) update.$unset = unsetValues;
  const rule = await AiAgentCoachingRule.findOneAndUpdate(
    filter,
    update,
    { new: true },
  ).lean();
  if (!rule) {
    const stillExists = guarded && await AiAgentCoachingRule.exists({ _id: req.params.id, organizationId: orgId, status: { $ne: 'deleted' } });
    if (stillExists) throw new ApiError(409, 'This coaching changed while you were saving. Reload it and try again.');
    throw new ApiError(404, 'Coaching rule not found');
  }
  await writeTrainingAudit({
    organizationId: orgId,
    action: 'legacy_coaching_updated',
    actor: trainingActor(user),
    legacyCoachingRuleId: (rule as any)._id,
    toStatus: (rule as any).status,
  });

  res.json(new ApiResponse(200, serialize(rule), 'AI coaching updated'));
});

export const deleteAiAgentCoaching = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = actor(req);
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (!isManager(user)) throw new ApiError(403, 'Only managers or admins can manage AI coaching');
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid coaching id');

  const rule = await AiAgentCoachingRule.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId, status: { $ne: 'deleted' } },
    {
      $set: {
        status: 'deleted',
        deletedAt: new Date(),
        deletedBy: user._id,
        updatedBy: user._id,
      },
    },
    { new: true },
  ).lean();
  if (!rule) throw new ApiError(404, 'Coaching rule not found');
  await writeTrainingAudit({
    organizationId: orgId,
    action: 'legacy_coaching_deleted',
    actor: trainingActor(user),
    legacyCoachingRuleId: (rule as any)._id,
    toStatus: 'deleted',
  });

  res.json(new ApiResponse(200, serialize(rule), 'AI coaching deleted'));
});
