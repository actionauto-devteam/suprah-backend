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
}

/** Called right after a real staff member's message successfully sends.
 *  Starts/extends a sliding auto-pause window so Alex goes quiet without
 *  touching the separate, indefinite manual-pause field. No-ops if Alex
 *  isn't enabled for the org, or if the conversation is already manually
 *  paused (no point starting a timer under an indefinite pause). */
export async function recordHumanTakeover(input: RecordHumanTakeoverInput): Promise<void> {
  try {
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
    } else {
      if (!input.sessionId) return;
      const result = await WebChatSession.updateOne(
        { _id: input.sessionId, aiPausedAt: { $exists: false } },
        { $set: { aiAutoPausedUntil: until } },
      );
      if (result.modifiedCount) {
        emitToOrg(String(input.organizationId), 'webchat:ai_paused', {
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
