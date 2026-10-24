import mongoose from 'mongoose';
import { Conversation } from '../models/communication.model';
import { LIFECYCLE_TERMINAL_STATUSES } from '../constants/leadStatus';
import { emitToOrg } from './socketEmitter';

const AUTOMATED_ACTOR_IDS = ['ai-agent', 'system', 'system-webchat-ack'];

export interface SessionControlState {
  aiPausedAt?: Date | string | null;
  aiPausedBy?: { userId?: string | null; name?: string | null } | null;
  aiAutoPausedUntil?: Date | string | null;
}

export function isAutomatedActor(userId: unknown): boolean {
  return AUTOMATED_ACTOR_IDS.includes(String(userId || ''));
}

export function isStaffTakeover(state: SessionControlState): boolean {
  return Boolean(state.aiPausedAt) && Boolean(state.aiPausedBy?.userId) && !isAutomatedActor(state.aiPausedBy?.userId);
}

export function sessionControlToCarry(state: SessionControlState, now = Date.now()) {
  if (state.aiPausedAt) {
    return {
      aiPausedAt: new Date(state.aiPausedAt as any),
      aiPausedBy: state.aiPausedBy?.userId ? state.aiPausedBy : { userId: 'staff', name: 'Team member' },
    };
  }
  const autoUntil = state.aiAutoPausedUntil ? new Date(state.aiAutoPausedUntil as any).getTime() : 0;
  if (autoUntil > now) return { aiAutoPausedUntil: new Date(autoUntil) };
  return undefined;
}

async function previousLeadFinished(organizationId: string, leadId: unknown): Promise<boolean> {
  if (!leadId) return false;
  let LeadModel: mongoose.Model<any>;
  try { LeadModel = mongoose.model('Lead'); } catch { return false; }
  const previous: any = await LeadModel.findOne({ _id: leadId, organizationId }).select('status').lean();
  return Boolean(previous) && LIFECYCLE_TERMINAL_STATUSES.includes(previous.status);
}

export async function moveConversationToLead(input: {
  organizationId: unknown;
  conversationId: unknown;
  leadId: unknown;
}): Promise<{ switched: boolean; pauseCleared: boolean }> {
  const organizationId = String(input.organizationId || '');
  const orgIds = mongoose.isValidObjectId(organizationId)
    ? { $in: [organizationId, new mongoose.Types.ObjectId(organizationId)] }
    : organizationId;
  const conversation: any = await Conversation.findOne({ _id: input.conversationId, orgId: orgIds })
    .select('leadId aiPausedAt aiPausedBy aiAutoPausedUntil aiHumanAttention')
    .lean();
  if (!conversation) return { switched: false, pauseCleared: false };
  if (conversation.leadId && String(conversation.leadId) === String(input.leadId)) return { switched: false, pauseCleared: false };

  const clearPause = isStaffTakeover(conversation)
    && !conversation.aiHumanAttention
    && (await previousLeadFinished(organizationId, conversation.leadId));

  const result = await Conversation.updateOne(
    { _id: conversation._id, leadId: conversation.leadId ?? null },
    {
      $set: { leadId: input.leadId },
      ...(clearPause ? { $unset: { aiPausedAt: '', aiPausedBy: '' } } : {}),
    },
  );
  if (!result.modifiedCount) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { leadId: input.leadId } });
    return { switched: true, pauseCleared: false };
  }
  if (clearPause) {
    emitToOrg(organizationId, 'comm:ai_paused', {
      conversationId: String(conversation._id),
      leadId: String(input.leadId),
      paused: false,
    });
  }
  return { switched: true, pauseCleared: clearPause };
}
