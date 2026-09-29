import AiAgentTask, { AiAgentTaskChannel } from '../models/AiAgentTask.model';
import { notifyUsers, notifyOrgAdmins } from './safeNotification';
import { notificationTemplates } from './notificationTemplates';
import logger from './logger';

/** Creates the task record behind an Alex handoff and notifies whoever should
 *  act on it — the lead's assigned rep if one exists, else org admins. Both
 *  `webchat.controller.ts` and `communication.service.ts` call this from
 *  inside their existing `notifyHandoff` callback instead of independently
 *  duplicating the same assignee-resolution branch. */
export async function createAiAgentTaskAndNotify(opts: {
  organizationId: string;
  leadId: string;
  channel: AiAgentTaskChannel;
  question: string | undefined;
  agentName: string;
  customerName: string;
  assignedTo?: string | null;
}): Promise<void> {
  const question = opts.question || 'Needs human follow-up';
  const assigneeIds = opts.assignedTo ? [opts.assignedTo] : [];

  try {
    await AiAgentTask.create({
      organizationId: opts.organizationId,
      leadId: opts.leadId,
      channel: opts.channel,
      question,
      assigneeIds,
      status: 'pending',
      waitingSince: new Date(),
    });
  } catch (err) {
    logger.error({ err }, '[AiAgentTask] Failed to create task record');
  }

  const { title, message } = notificationTemplates.ai_agent_handoff_needed({
    customerName: opts.customerName,
    agentName: opts.agentName,
    reason: opts.question,
  });
  const metadata = { leadId: opts.leadId, route: `/crm/leads?leadId=${opts.leadId}` };

  if (assigneeIds.length > 0) {
    await notifyUsers(assigneeIds, opts.organizationId, 'ai_agent_handoff_needed', title, message, metadata);
  } else {
    await notifyOrgAdmins(opts.organizationId, 'ai_agent_handoff_needed', title, message, metadata);
  }
}
