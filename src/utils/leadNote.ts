import Lead from '../models/lead.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import User from '../models/User.model';
import activityService from '../services/activity.service';
import { getSocketIO } from '../utils/socketEmitter';
import { notifyUsers } from './safeNotification';
import { notificationTemplates } from './notificationTemplates';
import logger from './logger';

export interface AddLeadNoteInput {
  organizationId: string;
  leadId: string;
  text: string;
  authorType: 'user' | 'ai';
  createdBy?: string;
  authorName: string;
  mentionedUserIds?: string[];
  mentionedGroupIds?: string[];
  milestone?: boolean;
  suppressNotification?: boolean;
  sourceTaskId?: string;
}

export function shouldSuppressHandoffNoteNotification(
  assignedTo: string | null | undefined,
  taskNotificationSucceeded: boolean,
): boolean {
  return Boolean(assignedTo) && taskNotificationSucceeded;
}

export async function resolveGroupMemberIds(organizationId: string, groupIds: string[]): Promise<string[]> {
  if (groupIds.length === 0) return [];

  const groups = await CrmLeadGroup.find({
    _id: { $in: groupIds },
    organizationId,
    isActive: true,
  })
    .select('memberIds')
    .lean();

  const memberIds = groups.flatMap((group) => (group.memberIds || []).map((id) => String(id)));
  if (memberIds.length === 0) return [];

  const activeMembers = await User.find({
    _id: { $in: memberIds },
    organizationId,
    isActive: true,
  })
    .select('_id')
    .lean();

  return activeMembers.map((member) => String(member._id));
}

export async function addLeadNoteAndNotify(input: AddLeadNoteInput) {
  const text = input.text.trim();
  if (!text) {
    throw new Error('Note text is required');
  }
  if (text.length > 5000) {
    throw new Error('Note cannot exceed 5000 characters');
  }

  const lead = await Lead.findOne({
    _id: input.leadId,
    organizationId: input.organizationId,
  });

  if (!lead) {
    throw new Error('Lead not found');
  }

  const mentionedUserIds = Array.from(new Set((input.mentionedUserIds || []).map(String)));
  const mentionedGroupIds = Array.from(new Set((input.mentionedGroupIds || []).map(String)));

  const expandedGroupMemberIds = await resolveGroupMemberIds(input.organizationId, mentionedGroupIds);

  lead.notes = lead.notes || [];
  lead.notes.push({
    text,
    createdAt: new Date(),
    createdBy: input.createdBy as any,
    authorType: input.authorType,
    authorName: input.authorName,
    mentionedUserIds: mentionedUserIds as any,
    mentionedGroupIds: mentionedGroupIds as any,
    milestone: input.milestone || false,
    sourceTaskId: input.sourceTaskId as any,
  });

  await lead.save();

  const note = lead.notes[lead.notes.length - 1];

  if (input.createdBy) {
    await activityService.createActivity({
      userId: input.createdBy,
      organizationId: input.organizationId,
      type: 'other',
      title: 'Note added',
      description: text,
      metadata: {
        leadId: lead._id.toString(),
        activityKind: 'lead_note',
        note: text,
        mentionCount: mentionedUserIds.length + expandedGroupMemberIds.length,
      },
    });
  }

  const io = getSocketIO();
  if (io) {
    io.to(`org:${input.organizationId}`).emit('lead:update', lead);
  }

  const recipientIds = Array.from(new Set([...mentionedUserIds, ...expandedGroupMemberIds])).filter(
    (id) => id && id !== input.createdBy,
  );

  if (recipientIds.length > 0 && !input.suppressNotification) {
    const { title, message } = notificationTemplates.lead_note_mention({
      authorName: input.authorName,
      customerName: `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'this lead',
    });

    notifyUsers(
      recipientIds,
      input.organizationId,
      'lead_note_mention',
      title,
      message,
      { leadId: String(lead._id), noteId: String((note as any)._id), route: `/crm/leads?leadId=${lead._id}` },
    ).catch((err) => logger.error({ err }, '[LeadNote] Failed to notify mentioned users'));
  }

  return { lead, note };
}
