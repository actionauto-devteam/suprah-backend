import mongoose from 'mongoose';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import { AiAgentTaskChannel } from '../models/AiAgentTask.model';
import { addLeadNoteAndNotify, resolveGroupMemberIds } from '../utils/leadNote';
import { createAiAgentTaskAndNotify } from '../utils/aiAgentTask';
import { crmNotificationRecipients } from '../utils/crmNotificationRecipients';
import logger from '../utils/logger';
import {
  AiHandoffTopic,
  aiHandoffTopicLabel,
  cleanAiHandoffTopicTeams,
  guessAiHandoffTopic,
} from '../constants/aiHandoffTopics';

export interface AiHandoffRouting {
  topic: AiHandoffTopic | null;
  topicLabel: string | null;
  rep: { id: string; name: string; active: boolean } | null;
  team: { id: string; name: string } | null;
  mentionedUserIds: string[];
  mentionedGroupIds: string[];
  mentionPrefix: string;
  assigneeIds: string[];
}

export async function resolveAiHandoffRouting(input: {
  organizationId: string;
  assignedTo?: unknown;
  topic?: AiHandoffTopic | null;
}): Promise<AiHandoffRouting> {
  const organizationId = String(input.organizationId);
  const topic = input.topic || null;
  const assignedId = input.assignedTo ? String(input.assignedTo) : '';

  let rep: AiHandoffRouting['rep'] = null;
  if (assignedId && mongoose.isValidObjectId(assignedId)) {
    const filter = { _id: assignedId, organizationId };
    const person: any = (await User.findOne(filter).select('fullName name isActive').lean())
      || (await CrmUser.findOne(filter).select('fullName name isActive').lean());
    if (person) {
      rep = { id: assignedId, name: String(person.fullName || person.name || 'Assigned rep').trim(), active: person.isActive !== false };
    }
  }

  const org: any = await Organization.findById(organizationId).select('metadata').lean();
  const metadata = org?.metadata || {};
  const topicTeams = cleanAiHandoffTopicTeams(metadata.aiHandoffTopicTeams);
  const candidates: string[] = [];
  if (topic && topicTeams[topic]) candidates.push(topicTeams[topic]);
  if (!rep && metadata.aiHandoffFallbackGroupId) candidates.push(String(metadata.aiHandoffFallbackGroupId));

  let team: AiHandoffRouting['team'] = null;
  for (const groupId of candidates) {
    if (!mongoose.isValidObjectId(groupId)) continue;
    const group: any = await CrmLeadGroup.findOne({ _id: groupId, organizationId, isActive: true }).select('name').lean();
    if (group) {
      team = { id: groupId, name: String(group.name || 'Team').trim() };
      break;
    }
  }

  const teamMemberIds = team ? await resolveGroupMemberIds(organizationId, [team.id]) : [];
  const mentions = [...(team ? [`@${team.name}`] : []), ...(rep ? [`@${rep.name}`] : [])];

  return {
    topic,
    topicLabel: aiHandoffTopicLabel(topic),
    rep,
    team,
    mentionedUserIds: rep ? [rep.id] : [],
    mentionedGroupIds: team ? [team.id] : [],
    mentionPrefix: mentions.length ? `${mentions.join(', ')}, ` : '',
    assigneeIds: Array.from(new Set([...(rep?.active ? [rep.id] : []), ...teamMemberIds])),
  };
}

export function aiHandoffSentence(text: unknown): string {
  const trimmed = String(text ?? '').trim() || 'Needs human follow-up';
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function aiHandoffNoteText(
  routing: Pick<AiHandoffRouting, 'mentionPrefix' | 'topicLabel'>,
  reason: unknown,
  suffix = '',
): string {
  const topic = routing.topicLabel ? ` Topic: ${routing.topicLabel}.` : '';
  return `${routing.mentionPrefix}${aiHandoffSentence(reason)}${topic}${suffix ? ` ${suffix}` : ''}`;
}

export async function writeAiHandoff(input: {
  organizationId: string;
  leadId: string;
  channel: AiAgentTaskChannel;
  reason?: string;
  topic?: AiHandoffTopic | null;
  agentName: string;
  customerName: string;
  assignedTo?: unknown;
  noteSuffix?: string;
}): Promise<AiHandoffRouting | null> {
  const reason = String(input.reason || '').trim() || 'Needs human follow-up';
  let routing: AiHandoffRouting;
  try {
    routing = await resolveAiHandoffRouting({
      organizationId: input.organizationId,
      assignedTo: input.assignedTo,
      topic: input.topic || guessAiHandoffTopic(reason),
    });
  } catch (err) {
    logger.error({ err, leadId: input.leadId }, '[AiHandoff] Could not work out who to tag');
    return null;
  }

  const notifyUserIds = await crmNotificationRecipients(input.organizationId, routing.assigneeIds).catch(() => routing.assigneeIds);
  const taskResult = await createAiAgentTaskAndNotify({
    organizationId: input.organizationId,
    leadId: input.leadId,
    channel: input.channel,
    question: reason,
    agentName: input.agentName,
    customerName: input.customerName,
    assigneeIds: routing.assigneeIds,
    notifyUserIds,
  }).catch(() => null);

  try {
    await addLeadNoteAndNotify({
      organizationId: input.organizationId,
      leadId: input.leadId,
      text: aiHandoffNoteText(routing, reason, input.noteSuffix),
      authorType: 'ai',
      authorName: input.agentName,
      mentionedUserIds: routing.mentionedUserIds,
      mentionedGroupIds: routing.mentionedGroupIds,
      suppressNotification: routing.assigneeIds.length > 0 && Boolean(taskResult?.notified),
    });
  } catch (err) {
    logger.error({ err, leadId: input.leadId }, '[AiHandoff] Handoff note failed');
  }
  return routing;
}
