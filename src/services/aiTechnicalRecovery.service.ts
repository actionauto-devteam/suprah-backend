import mongoose from 'mongoose';
import AiAgentTask from '../models/AiAgentTask.model';
import Lead from '../models/lead.model';
import Organization from '../models/Organization.model';
import WebChatSession from '../models/WebChatSession.model';
import WebChatMessage from '../models/WebChatMessage.model';
import { Conversation, CommunicationMessage } from '../models/communication.model';
import { AiHumanAttention, attentionKindOf } from '../models/aiHumanAttention';
import { attentionOrgIds } from './aiHumanAttention.service';
import { isSmsOptedOut } from './communication.service';
import { isEmailOptedOut } from './email.service';
import { canReviewTraining, trainingRole } from './aiTraining.service';
import { addLeadNoteAndNotify } from '../utils/leadNote';
import { emitToOrg } from '../utils/socketEmitter';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';

export type RecoveryBlocker =
  | 'task_not_pending'
  | 'not_technical'
  | 'unverified_legacy_pause'
  | 'already_resumed'
  | 'paused_for_other_reason'
  | 'paused_before_incident'
  | 'screening_in_progress'
  | 'sms_opted_out'
  | 'email_opted_out'
  | 'do_not_contact'
  | 'conversation_missing';

export const RECOVERY_BLOCKER_MESSAGES: Record<RecoveryBlocker, string> = {
  task_not_pending: 'This task is already resolved or dismissed.',
  not_technical: 'This task is not a technical safety-check failure. Use the normal Resume control.',
  unverified_legacy_pause: 'This pause was recorded before Suprah could confirm it was technical-only. Review the conversation and use the normal Resume control.',
  already_resumed: 'The conversation is no longer paused by this technical failure.',
  paused_for_other_reason: 'The conversation is paused for another reason. Use the normal Resume control after reviewing it.',
  paused_before_incident: 'The conversation was already paused before the safety check failed. Use the normal Resume control after reviewing it.',
  screening_in_progress: 'A new customer message is being checked right now. Try again in a moment.',
  sms_opted_out: 'This customer opted out of texts.',
  email_opted_out: 'This customer opted out of automated emails.',
  do_not_contact: 'This lead is marked Do Not Contact.',
  conversation_missing: 'The conversation for this task could not be found.',
};

export interface TechnicalRecoveryPreview {
  taskId: string;
  leadId: string;
  channel: 'sms' | 'webchat' | 'email';
  reason: string;
  code?: string;
  detectedAt?: Date;
  canRecover: boolean;
  eligible: boolean;
  blockers: Array<{ code: RecoveryBlocker; message: string }>;
  messagesSinceIncident: number | null;
  requiresEmailThreadReview: boolean;
}

interface RecoveryContext {
  task: any;
  model: any;
  scope: Record<string, any> | null;
  state: any;
  lead: any;
}

function canRecover(user: any): boolean {
  return canReviewTraining(trainingRole(user));
}

function actorOf(user: any) {
  const name = user?.fullName || user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Team member';
  return { userId: String(user?._id || ''), name: String(name).slice(0, 120), role: trainingRole(user) };
}

function targetFor(task: any, organizationId: string): { model: any; scope: Record<string, any> | null } {
  if (task.channel === 'sms') {
    return task.conversationId
      ? { model: Conversation, scope: { _id: task.conversationId, orgId: { $in: attentionOrgIds(organizationId) }, leadId: task.leadId } }
      : { model: Conversation, scope: null };
  }
  if (task.channel === 'webchat') {
    return task.sessionId
      ? { model: WebChatSession, scope: { _id: task.sessionId, organizationId, leadId: task.leadId } }
      : { model: WebChatSession, scope: null };
  }
  return { model: Lead, scope: { _id: task.leadId, organizationId } };
}

async function loadContext(organizationId: string, taskId: string): Promise<RecoveryContext> {
  if (!mongoose.isValidObjectId(taskId)) throw new ApiError(404, 'Task not found');
  const task = await AiAgentTask.findOne({ _id: taskId, organizationId }).lean();
  if (!task) throw new ApiError(404, 'Task not found');
  const { model, scope } = targetFor(task, organizationId);
  const [state, lead] = await Promise.all([
    scope ? model.findOne(scope).lean() : null,
    Lead.findOne({ _id: task.leadId, organizationId }).select('status email phone firstName lastName').lean(),
  ]);
  return { task, model, scope, state, lead };
}

function autoPausedNow(state: any): boolean {
  return Boolean(state?.aiAutoPausedUntil && new Date(state.aiAutoPausedUntil) > new Date());
}

async function blockersFor(organizationId: string, ctx: RecoveryContext): Promise<RecoveryBlocker[]> {
  const { task, state, lead } = ctx;
  const blockers: RecoveryBlocker[] = [];
  if (task.status !== 'pending') blockers.push('task_not_pending');
  if (attentionKindOf({ kind: task.attentionKind, reason: task.question }) !== 'technical') {
    blockers.push('not_technical');
    return blockers;
  }
  if (!state || !lead) {
    blockers.push('conversation_missing');
    return blockers;
  }
  const attention: AiHumanAttention | undefined = state.aiHumanAttention;
  if (!attention || String(attention.taskId) !== String(task._id)) {
    blockers.push(attention ? 'paused_for_other_reason' : 'already_resumed');
    return blockers;
  }
  if (attentionKindOf(attention) !== 'technical') blockers.push('paused_for_other_reason');
  if (task.attentionKind !== 'technical' || attention.kind !== 'technical' || attention.priorPauseChecked !== true) {
    blockers.push('unverified_legacy_pause');
  }
  if (attention.pausedBeforeAttention) blockers.push('paused_before_incident');
  if (state.aiPausedBy?.userId !== 'system' || state.aiPausedBy?.name !== attention.reason || autoPausedNow(state)) {
    blockers.push('paused_for_other_reason');
  }
  if (state.aiAttentionPendingIds?.length) blockers.push('screening_in_progress');
  if (lead.status === 'Do Not Contact') blockers.push('do_not_contact');
  if (task.channel === 'sms' && state.customerPhone && await isSmsOptedOut(organizationId, state.customerPhone)) blockers.push('sms_opted_out');
  if (task.channel === 'email' && lead.email && await isEmailOptedOut(organizationId, lead.email)) blockers.push('email_opted_out');
  return [...new Set(blockers)];
}

async function messagesSinceIncident(organizationId: string, ctx: RecoveryContext): Promise<number | null> {
  const attention: AiHumanAttention | undefined = ctx.state?.aiHumanAttention;
  if (!attention || ctx.task.channel === 'email') return null;
  const messageId = mongoose.isValidObjectId(attention.messageId) ? attention.messageId : null;
  if (ctx.task.channel === 'sms') {
    const orgId = { $in: attentionOrgIds(organizationId) };
    const original: any = messageId ? await CommunicationMessage.findOne({ _id: messageId, orgId }).select('createdAt').lean() : null;
    return CommunicationMessage.countDocuments({ conversationId: ctx.state._id, orgId, direction: 'inbound',
      createdAt: { $gte: original?.createdAt || attention.detectedAt } });
  }
  const original: any = messageId ? await WebChatMessage.findOne({ _id: messageId, organizationId }).select('createdAt').lean() : null;
  return WebChatMessage.countDocuments({ sessionId: ctx.state._id, organizationId, direction: 'inbound',
    createdAt: { $gte: original?.createdAt || attention.detectedAt } });
}

export async function previewTechnicalRecovery(organizationId: string, taskId: string, user: any): Promise<TechnicalRecoveryPreview> {
  const ctx = await loadContext(organizationId, taskId);
  const blockers = await blockersFor(organizationId, ctx);
  const attention: AiHumanAttention | undefined = ctx.state?.aiHumanAttention;
  return {
    taskId: String(ctx.task._id),
    leadId: String(ctx.task.leadId),
    channel: ctx.task.channel,
    reason: ctx.task.question,
    code: ctx.task.attentionCode,
    detectedAt: attention?.detectedAt,
    canRecover: canRecover(user),
    eligible: blockers.length === 0,
    blockers: blockers.map(code => ({ code, message: RECOVERY_BLOCKER_MESSAGES[code] })),
    messagesSinceIncident: blockers.length ? null : await messagesSinceIncident(organizationId, ctx),
    requiresEmailThreadReview: ctx.task.channel === 'email',
  };
}

function emitResumed(organizationId: string, task: any, state: any): void {
  const event = task.channel === 'sms' ? 'comm:ai_paused' : task.channel === 'webchat' ? 'webchat:ai_paused' : 'email:ai_paused';
  emitToOrg(organizationId, event, {
    leadId: String(task.leadId),
    ...(task.channel === 'sms' ? { conversationId: String(state._id) } : {}),
    paused: false,
  });
}

export async function recoverTechnicalPause(input: {
  organizationId: string;
  taskId: string;
  user: any;
  acknowledged?: unknown;
  acknowledgedMessageCount?: unknown;
  emailThreadReviewed?: unknown;
}): Promise<{ recovered: true; channel: string; leadId: string; messagesSinceIncident: number | null }> {
  if (!canRecover(input.user)) throw new ApiError(403, 'Only managers and admins can resume a conversation after a technical failure');
  const ctx = await loadContext(input.organizationId, input.taskId);
  const blockers = await blockersFor(input.organizationId, ctx);
  if (blockers.length) {
    throw new ApiError(409, RECOVERY_BLOCKER_MESSAGES[blockers[0]], blockers.map(code => ({ code, message: RECOVERY_BLOCKER_MESSAGES[code] })));
  }
  if (input.acknowledged !== true) throw new ApiError(400, 'Confirm you reviewed the messages received during the pause');
  if (ctx.task.channel === 'email' && input.emailThreadReviewed !== true) {
    throw new ApiError(400, 'Open the latest email thread and confirm you reviewed it yourself. Suprah does not check email threads for new replies.');
  }
  const waiting = await messagesSinceIncident(input.organizationId, ctx);
  if (waiting !== null && Number(input.acknowledgedMessageCount) !== waiting) {
    throw new ApiError(409, 'New customer messages arrived since you opened this. Review them and try again.', [{ code: 'messages_changed', count: waiting }]);
  }

  const attention: AiHumanAttention = ctx.state.aiHumanAttention;
  const now = new Date();
  const actor = actorOf(input.user);
  const updated = await ctx.model.findOneAndUpdate({
    ...ctx.scope,
    'aiHumanAttention.taskId': attention.taskId,
    'aiHumanAttention.pausedBeforeAttention': { $exists: false },
    'aiHumanAttention.kind': 'technical',
    'aiHumanAttention.priorPauseChecked': true,
    'aiPausedBy.userId': 'system',
    'aiPausedBy.name': attention.reason,
    $and: [
      { $or: [{ aiAttentionPendingIds: { $size: 0 } }, { aiAttentionPendingIds: { $exists: false } }] },
      { $or: [{ aiAutoPausedUntil: null }, { aiAutoPausedUntil: { $lte: now } }] },
    ],
  }, {
    $unset: { aiPausedAt: '', aiPausedBy: '', aiHumanAttention: '', aiAutoPausedUntil: '' },
    $inc: { aiResponseVersion: 1 },
    $set: { aiLastTechnicalRecovery: { taskId: attention.taskId, recoveredAt: now, recoveredBy: actor, reason: attention.reason } },
  }, { new: true }).lean();
  if (!updated) throw new ApiError(409, 'This conversation changed while you were reviewing it. Refresh and try again.');

  await AiAgentTask.updateOne({ _id: ctx.task._id, organizationId: input.organizationId }, {
    $set: {
      status: 'resolved',
      resolvedAt: now,
      ...(mongoose.isValidObjectId(actor.userId) ? { resolvedBy: actor.userId } : {}),
      resolutionNote: 'Resumed after a technical safety-check failure',
      resolutionType: 'technical_recovery',
      recoveredByName: actor.name,
    },
  });

  try {
    const org: any = await Organization.findById(input.organizationId).select('metadata.aiAgentName').lean();
    const agentName = String(org?.metadata?.aiAgentName || 'Alex');
    const waitingText = waiting === null
      ? `${agentName} did not reply to the message that failed the check. Staff confirmed a manual review of the email thread; Suprah did not check it for new replies.`
      : `${agentName} did not reply to the ${waiting} customer message${waiting === 1 ? '' : 's'} received while paused.`;
    await addLeadNoteAndNotify({
      organizationId: input.organizationId,
      leadId: String(ctx.task.leadId),
      text: `${actor.name} resumed ${agentName} after a technical safety-check failure (${attention.reason}). ${waitingText} ${agentName} will only respond to new messages.`,
      authorType: 'user',
      ...(mongoose.isValidObjectId(actor.userId) ? { createdBy: actor.userId } : {}),
      authorName: actor.name,
    });
  } catch (err: any) {
    logger.warn({ organizationId: input.organizationId, taskId: String(ctx.task._id), errorName: err?.name },
      '[AiTechnicalRecovery] Could not write the recovery note');
  }

  emitResumed(input.organizationId, ctx.task, updated);
  logger.info({ organizationId: input.organizationId, taskId: String(ctx.task._id), channel: ctx.task.channel, recoveredBy: actor.userId, role: actor.role },
    '[AiTechnicalRecovery] Conversation resumed after a technical failure');
  return { recovered: true, channel: ctx.task.channel, leadId: String(ctx.task.leadId), messagesSinceIncident: waiting };
}
