import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import { notifyOrgAdmins, notifyUsers } from '../utils/safeNotification';
import { crmNotificationRecipients } from '../utils/crmNotificationRecipients';
import { addLeadNoteAndNotify, resolveGroupMemberIds } from '../utils/leadNote';
import { identityFromMetadata } from '../utils/aiAgentIdentity';
import { aiHandoffTopicLabel, cleanAiHandoffTopicTeams, guessAiHandoffTopic } from '../constants/aiHandoffTopics';
import { aiHandoffNoteText } from './aiHandoffRouting.service';
import logger from '../utils/logger';

export type LeadNoticeAudience = 'owner' | 'ring_team' | 'team' | 'admins' | 'nobody';

export interface LeadNoticeInput {
  organizationId: unknown;
  leadId?: unknown;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  ownerIds?: unknown[];
  assignedOwnerOnly?: boolean;
  ringTeamIds?: string[];
  excludeUserId?: unknown;
  topicText?: string;
  tagText?: string;
}

interface LeadTeam {
  id: string;
  name: string;
  memberIds: string[];
}

const validId = (value: unknown): string => {
  const id = value ? String((value as any)?._id ?? value) : '';
  return mongoose.isValidObjectId(id) ? id : '';
};

async function firstActiveOwner(organizationId: string, ids: unknown[]): Promise<string> {
  for (const raw of ids) {
    const id = validId(raw);
    if (!id) continue;
    if (await User.exists({ _id: id, organizationId, isActive: { $ne: false } })) return id;
    if (await CrmUser.exists({ _id: id, organizationId, isActive: true, isOffboarded: { $ne: true } })) return id;
  }
  return '';
}

async function teamWithMembers(organizationId: string, groupId: unknown): Promise<LeadTeam | null> {
  const id = validId(groupId);
  if (!id) return null;
  const group: any = await CrmLeadGroup.findOne({ _id: id, organizationId, isActive: true }).select('name').lean();
  if (!group) return null;
  const memberIds = await resolveGroupMemberIds(organizationId, [id]);
  return memberIds.length ? { id, name: String(group.name || 'Team').trim(), memberIds } : null;
}

export function lastAiTaggedTeamIds(lead: any): string[] {
  const notes = Array.isArray(lead?.notes) ? lead.notes : [];
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index];
    if (note?.authorType === 'ai' && Array.isArray(note.mentionedGroupIds) && note.mentionedGroupIds.length) {
      return note.mentionedGroupIds.map(String);
    }
  }
  return [];
}

async function tagLeadTeam(organizationId: string, lead: any, input: LeadNoticeInput): Promise<LeadTeam | null> {
  for (const groupId of lastAiTaggedTeamIds(lead)) {
    const team = await teamWithMembers(organizationId, groupId);
    if (team) return team;
  }

  const org: any = await Organization.findById(organizationId).select('metadata').lean();
  const metadata = org?.metadata || {};
  let topic = guessAiHandoffTopic(input.topicText || '');
  if (topic === 'other' && lead?.comments) topic = guessAiHandoffTopic(lead.comments);
  const topicTeams = cleanAiHandoffTopicTeams(metadata.aiHandoffTopicTeams);

  let team: LeadTeam | null = null;
  for (const groupId of [topicTeams[topic], metadata.aiHandoffFallbackGroupId]) {
    team = await teamWithMembers(organizationId, groupId);
    if (team) break;
  }
  if (!team) return null;

  try {
    await addLeadNoteAndNotify({
      organizationId,
      leadId: String(lead._id),
      text: aiHandoffNoteText({ mentionPrefix: `@${team.name}, `, topicLabel: aiHandoffTopicLabel(topic) }, input.tagText || input.message),
      authorType: 'ai',
      authorName: identityFromMetadata(metadata).displayName,
      mentionedGroupIds: [team.id],
      suppressNotification: true,
    });
  } catch (err) {
    logger.warn({ err, leadId: String(lead._id) }, '[LeadNotice] Could not add the team tag');
  }
  return team;
}

async function pickLeadNoticePeople(
  organizationId: string,
  input: LeadNoticeInput,
): Promise<{ audience: Exclude<LeadNoticeAudience, 'admins' | 'nobody'>; ids: string[] } | null> {
  const leadId = validId(input.leadId);
  const lead: any = leadId
    ? await Lead.findOne({ _id: leadId, organizationId }).select('assignedTo comments notes.authorType notes.mentionedGroupIds').lean()
    : null;

  const assignedOwnerOnly = input.assignedOwnerOnly || input.type === 'lead_message';
  const owner = await firstActiveOwner(organizationId, assignedOwnerOnly ? [lead?.assignedTo] : [...(input.ownerIds || []), lead?.assignedTo]);
  if (owner) return { audience: 'owner', ids: [owner] };
  if (assignedOwnerOnly) return { audience: 'owner', ids: [] };
  if (input.ringTeamIds?.length) return { audience: 'ring_team', ids: input.ringTeamIds };
  if (!lead) return null;
  const team = await tagLeadTeam(organizationId, lead, input);
  return team ? { audience: 'team', ids: team.memberIds } : null;
}

async function samePersonIds(organizationId: string, id: string): Promise<string[]> {
  if (!id) return [];
  const person: any = (await User.findOne({ _id: id, organizationId }).select('email').lean())
    || (await CrmUser.findOne({ _id: id, organizationId }).select('email').lean());
  const email = String(person?.email || '').trim().toLowerCase();
  if (!email) return [id];
  const [mainUsers, crmUsers] = await Promise.all([
    User.find({ organizationId, email }).select('_id').lean(),
    CrmUser.find({ organizationId, email }).select('_id').lean(),
  ]);
  return [...new Set([id, ...[...mainUsers, ...crmUsers].map((row: any) => String(row._id))])];
}

export async function notifyLeadPeople(input: LeadNoticeInput): Promise<LeadNoticeAudience> {
  const organizationId = String(input.organizationId || '');
  const excluded = validId(input.excludeUserId);
  const excludedIds = excluded ? await samePersonIds(organizationId, excluded).catch(() => [excluded]) : [];

  const picked = await pickLeadNoticePeople(organizationId, input).catch((err) => {
    if (input.assignedOwnerOnly || input.type === 'lead_message') throw err;
    logger.warn({ err, type: input.type }, '[LeadNotice] Could not pick who to notify, sending to admins');
    return null;
  });

  if (picked) {
    const people = [...new Set(picked.ids.map(String).filter((id) => id && !excludedIds.includes(id)))];
    if (!people.length) return 'nobody';
    const recipients = await crmNotificationRecipients(organizationId, people).catch(() => people);
    await notifyUsers(recipients, organizationId, input.type, input.title, input.message, input.metadata);
    return picked.audience;
  }

  if (excludedIds.length) await notifyOrgAdmins(organizationId, input.type, input.title, input.message, input.metadata, excludedIds);
  else await notifyOrgAdmins(organizationId, input.type, input.title, input.message, input.metadata);
  return 'admins';
}
