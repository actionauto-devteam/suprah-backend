import { Conversation } from '../models/communication.model';
import WebChatSession from '../models/WebChatSession.model';
import { resolveAiAgentSettings } from '../services/aiAgent.service';
import { emitToOrg } from './socketEmitter';
import logger from './logger';

const AI_AGENT_AUTO_PAUSE_MINUTES = parseInt(process.env.AI_AGENT_AUTO_PAUSE_MINUTES || '30', 10);
export const AI_AGENT_AUTO_PAUSE_MS = AI_AGENT_AUTO_PAUSE_MINUTES * 60_000;

export interface RecordHumanTakeoverInput {
  kind: 'sms' | 'webchat';
  organizationId: any;
  conversationId?: any;
  sessionId?: any;
  leadId?: any;
  pausedBy?: { userId: string; name?: string };
}

export async function recordHumanTakeover(input: RecordHumanTakeoverInput): Promise<void> {
  try {
    if (input.kind === 'webchat') {
      if (!input.sessionId) return;
      const pausedBy = {
        userId: String(input.pausedBy?.userId || 'staff'),
        name: input.pausedBy?.name || 'Team member',
      };
      const result = await WebChatSession.updateOne(
        { _id: input.sessionId, organizationId: String(input.organizationId), aiPausedAt: null },
        {
          $set: { aiPausedAt: new Date(), aiPausedBy: pausedBy },
          $unset: { aiAutoPausedUntil: '' },
          $inc: { aiResponseVersion: 1 },
        },
      );
      if (result.modifiedCount) {
        emitToOrg(String(input.organizationId), 'webchat:ai_paused', {
          leadId: input.leadId ? String(input.leadId) : undefined,
          paused: true,
          pausedBy: pausedBy.name,
        });
      }
      return;
    }

    const { enabled } = await resolveAiAgentSettings(String(input.organizationId));
    if (!enabled) return;

    const until = new Date(Date.now() + AI_AGENT_AUTO_PAUSE_MS);

    if (input.kind === 'sms') {
      if (!input.conversationId) return;
      const result = await Conversation.updateOne(
        { _id: input.conversationId, aiPausedAt: null },
        { $set: { aiAutoPausedUntil: until } },
      );
      if (result.modifiedCount) {
        emitToOrg(String(input.organizationId), 'comm:ai_paused', {
          conversationId: String(input.conversationId),
          leadId: input.leadId ? String(input.leadId) : undefined,
          paused: false,
          autoPausedUntil: until.toISOString(),
        });
      }
    }
  } catch (err) {
    logger.error({ err }, '[AiAutoPause] Failed to record human takeover');
  }
}
