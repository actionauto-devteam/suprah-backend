const mockNotifyUsers = jest.fn().mockResolvedValue(undefined);
const mockNotifyOrgAdmins = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/utils/safeNotification', () => ({
  notifyUsers: (...args: unknown[]) => mockNotifyUsers(...args),
  notifyOrgAdmins: (...args: unknown[]) => mockNotifyOrgAdmins(...args),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLeadGroup from '../src/models/CrmLeadGroup.model';
import Lead from '../src/models/lead.model';
import { notifyLeadPeople } from '../src/services/leadNoticeRouting.service';

const orgId = new mongoose.Types.ObjectId();
const bareOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const BARE = String(bareOrgId);
const mary = new mongoose.Types.ObjectId();
const olive = new mongoose.Types.ObjectId();
const owen = new mongoose.Types.ObjectId();
const sam = new mongoose.Types.ObjectId();
const fran = new mongoose.Types.ObjectId();
const maryCrm = new mongoose.Types.ObjectId();
const oliveCrm = new mongoose.Types.ObjectId();
const onlineTeam = new mongoose.Types.ObjectId();
const salesTeam = new mongoose.Types.ObjectId();
const fallbackTeam = new mongoose.Types.ObjectId();
const assignedLead = new mongoose.Types.ObjectId();
const openLead = new mongoose.Types.ObjectId();
const quietLead = new mongoose.Types.ObjectId();
const goneRepLead = new mongoose.Types.ObjectId();
const bareLead = new mongoose.Types.ObjectId();

const notice = (type: string, extra: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  type,
  title: 'Title',
  message: 'Message',
  metadata: { tag: type },
  ...extra,
});

async function notesOf(leadId: mongoose.Types.ObjectId) {
  const lead: any = await Lead.findById(leadId).lean();
  return lead?.notes || [];
}

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: { $in: [orgId, bareOrgId] } }),
    User.collection.deleteMany({ organizationId: { $in: [orgId, bareOrgId] } }),
    CrmUser.collection.deleteMany({ organizationId: { $in: [orgId, bareOrgId] } }),
    CrmLeadGroup.collection.deleteMany({ organizationId: { $in: [orgId, bareOrgId] } }),
    Lead.collection.deleteMany({ organizationId: { $in: [orgId, bareOrgId] } }),
  ]);
}

describe('Real-DB: who gets a lead notice (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Organization.collection.insertMany([
      {
        _id: orgId,
        name: 'Notice Motors',
        slug: `notice-${orgId}`,
        status: 'active',
        metadata: {
          aiAgentName: 'Anna',
          aiHandoffTopicTeams: { availability: String(onlineTeam), appointment: String(salesTeam) },
          aiHandoffFallbackGroupId: String(fallbackTeam),
        },
      },
      { _id: bareOrgId, name: 'Bare Motors', slug: `bare-${bareOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: mary, organizationId: orgId, name: 'Mary Cruz', email: 'mary@notice.test', role: 'employee', isActive: true },
      { _id: olive, organizationId: orgId, name: 'Olive Online', email: 'olive@notice.test', role: 'employee', isActive: true },
      { _id: owen, organizationId: orgId, name: 'Owen Gone', email: 'owen@notice.test', role: 'employee', isActive: false },
      { _id: sam, organizationId: orgId, name: 'Sam Sales', email: 'sam@notice.test', role: 'employee', isActive: true },
      { _id: fran, organizationId: orgId, name: 'Fran Fallback', email: 'fran@notice.test', role: 'employee', isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: maryCrm, organizationId: orgId, username: `mary-${maryCrm}`, fullName: 'Mary Cruz', email: 'mary@notice.test', isActive: true },
      { _id: oliveCrm, organizationId: orgId, username: `olive-${oliveCrm}`, fullName: 'Olive Online', email: 'olive@notice.test', isActive: true },
    ] as any[]);
    await CrmLeadGroup.collection.insertMany([
      { _id: onlineTeam, organizationId: orgId, name: 'Online Team', memberIds: [olive, owen], isActive: true, roundRobinCursor: 0 },
      { _id: salesTeam, organizationId: orgId, name: 'Sales Team', memberIds: [sam], isActive: true, roundRobinCursor: 0 },
      { _id: fallbackTeam, organizationId: orgId, name: 'Fallback Team', memberIds: [fran], isActive: true, roundRobinCursor: 0 },
    ] as any[]);
    const base = { organizationId: orgId, createdBy: mary, status: 'New', source: 'Website', channel: 'sms', createdAt: new Date(), updatedAt: new Date() };
    await Lead.collection.insertMany([
      { ...base, _id: assignedLead, firstName: 'Tina', lastName: 'Tacoma', phone: '+18015556101', assignedTo: mary },
      { ...base, _id: openLead, firstName: 'Ulysses', lastName: 'Open', phone: '+18015556102', comments: 'Is the 2021 Tacoma still available?' },
      { ...base, _id: quietLead, firstName: 'Quinn', lastName: 'Quiet', phone: '+18015556103' },
      { ...base, _id: goneRepLead, firstName: 'Gina', lastName: 'Gone', phone: '+18015556104', assignedTo: owen },
      { ...base, _id: bareLead, organizationId: bareOrgId, firstName: 'Bea', lastName: 'Bare', phone: '+18015556105' },
    ] as any[]);
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(cleanup);

  it('1. an assigned lead: only the assigned rep is told, on their CRM account, and no admins', async () => {
    const audience = await notifyLeadPeople(notice('lead_message', { leadId: assignedLead, topicText: 'Is it still there?' }));
    expect(audience).toBe('owner');
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(maryCrm)], ORG, 'lead_message', 'Title', 'Message', { tag: 'lead_message' });
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
    expect(await notesOf(assignedLead)).toHaveLength(0);
  });

  it('2. a new unassigned lead: the AI tags the topic team in a note and only that team is told', async () => {
    const audience = await notifyLeadPeople(notice('new_lead', {
      leadId: openLead,
      message: 'New lead from Ulysses Open via Website Chat',
      topicText: 'Is the 2021 Tacoma still available?',
    }));
    expect(audience).toBe('team');
    const notes = await notesOf(openLead);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('@Online Team, New lead from Ulysses Open via Website Chat. Topic: Vehicle availability.');
    expect(notes[0]).toMatchObject({ authorType: 'ai', authorName: 'Anna' });
    expect(notes[0].mentionedGroupIds.map(String)).toEqual([String(onlineTeam)]);
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(oliveCrm)], ORG, 'new_lead', 'Title', 'New lead from Ulysses Open via Website Chat', { tag: 'new_lead' });
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('3. later new inquiries go to the same tagged team, with no second tag note', async () => {
    const audience = await notifyLeadPeople(notice('lead_new_inquiry', { leadId: openLead, topicText: 'Can I get financing?', tagText: 'New inquiry from Ulysses Open' }));
    expect(audience).toBe('team');
    expect(await notesOf(openLead)).toHaveLength(1);
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(oliveCrm)], ORG, 'lead_new_inquiry', 'Title', 'Message', expect.any(Object));
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('4. a topic with no team uses the fallback team; a lead whose rep left counts as unassigned', async () => {
    const audience = await notifyLeadPeople(notice('lead_new_inquiry', { leadId: goneRepLead, topicText: 'What APR can I get on a loan?', tagText: 'New inquiry from Gina Gone' }));
    expect(audience).toBe('team');
    const notes = await notesOf(goneRepLead);
    expect(notes[0].text).toBe('@Fallback Team, New inquiry from Gina Gone. Topic: Financing and credit.');
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(fran)], ORG, 'lead_new_inquiry', 'Title', 'Message', expect.any(Object));
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('5. a missed call: the assigned rep only; when unassigned, the team the line rang for, with no tag note', async () => {
    const ringTeamIds = [String(sam), String(fran)];
    expect(await notifyLeadPeople(notice('missed_call', { leadId: assignedLead, ringTeamIds }))).toBe('owner');
    expect(mockNotifyUsers).toHaveBeenLastCalledWith([String(maryCrm)], ORG, 'missed_call', 'Title', 'Message', expect.any(Object));
    expect(await notifyLeadPeople(notice('missed_call', { leadId: quietLead, ringTeamIds }))).toBe('ring_team');
    expect(mockNotifyUsers).toHaveBeenLastCalledWith([String(sam), String(fran)], ORG, 'missed_call', 'Title', 'Message', expect.any(Object));
    expect(await notesOf(quietLead)).toHaveLength(0);
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('6. an appointment: its salesperson first, and nobody is told about their own change', async () => {
    expect(await notifyLeadPeople(notice('appointment_updated', { leadId: assignedLead, ownerIds: [sam] }))).toBe('owner');
    expect(mockNotifyUsers).toHaveBeenLastCalledWith([String(sam)], ORG, 'appointment_updated', 'Title', 'Message', expect.any(Object));
    jest.clearAllMocks();
    expect(await notifyLeadPeople(notice('appointment_updated', { leadId: assignedLead, excludeUserId: mary }))).toBe('nobody');
    expect(await notifyLeadPeople(notice('appointment_updated', { leadId: assignedLead, excludeUserId: maryCrm }))).toBe('nobody');
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('7. no team set up, or no lead at all: admins and managers, as before', async () => {
    expect(await notifyLeadPeople(notice('new_lead', { organizationId: BARE, leadId: bareLead, topicText: 'Is it available?' }))).toBe('admins');
    expect(mockNotifyOrgAdmins).toHaveBeenLastCalledWith(BARE, 'new_lead', 'Title', 'Message', { tag: 'new_lead' });
    expect(await notesOf(bareLead)).toHaveLength(0);
    expect(await notifyLeadPeople(notice('appointment_created', { excludeUserId: mary }))).toBe('admins');
    expect(mockNotifyOrgAdmins).toHaveBeenLastCalledWith(ORG, 'appointment_created', 'Title', 'Message', { tag: 'appointment_created' }, [String(mary), String(maryCrm)]);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });

  it('a customer reply on an unassigned lead goes to the team already tagged on it, never to a stale owner or the ringing team, with no new note', async () => {
    const before = await notesOf(openLead);
    expect(await notifyLeadPeople(notice('lead_message', {
      leadId: openLead, ownerIds: [sam], ringTeamIds: [String(fran)], topicText: 'Can I get financing?',
    }))).toBe('team');
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(oliveCrm)], ORG, 'lead_message', 'Title', 'Message', expect.any(Object));
    expect(await notesOf(openLead)).toEqual(before);
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('a customer reply on a lead nobody was tagged for goes to the topic or fallback team, without adding a note', async () => {
    expect(await notifyLeadPeople(notice('lead_message', {
      leadId: quietLead, ownerIds: [sam], ringTeamIds: [String(sam)], topicText: 'Can I get financing?',
    }))).toBe('team');
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(fran)], ORG, 'lead_message', 'Title', 'Message', expect.any(Object));
    expect(await notesOf(quietLead)).toHaveLength(0);
    jest.clearAllMocks();
    expect(await notifyLeadPeople(notice('lead_message', { leadId: goneRepLead, topicText: 'Hello?' }))).toBe('team');
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(fran)], ORG, 'lead_message', 'Title', 'Message', expect.any(Object));
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('a customer reply on an unassigned lead goes to admins and managers when no team is set up', async () => {
    expect(await notifyLeadPeople(notice('lead_message', { organizationId: BARE, leadId: bareLead, topicText: 'Still there?' }))).toBe('admins');
    expect(mockNotifyOrgAdmins).toHaveBeenCalledWith(BARE, 'lead_message', 'Title', 'Message', { tag: 'lead_message' });
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(await notesOf(bareLead)).toHaveLength(0);
  });

  it('a customer reply on an unassigned card in Others reaches nobody', async () => {
    const othersLead = new mongoose.Types.ObjectId();
    await Lead.collection.insertOne({ _id: othersLead, organizationId: orgId, createdBy: mary, status: 'Not a Lead', source: 'Email Inquiry', channel: 'email', firstName: 'Vendor', createdAt: new Date(), updatedAt: new Date() } as any);
    expect(await notifyLeadPeople(notice('lead_message', { leadId: othersLead, topicText: 'Our new pricing sheet' }))).toBe('nobody');
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('customer replies use the current database assignment instead of a stale sender snapshot', async () => {
    await Lead.updateOne({ _id: assignedLead }, { $set: { assignedTo: sam } });
    try {
      expect(await notifyLeadPeople(notice('lead_message', { leadId: assignedLead, ownerIds: [mary] }))).toBe('owner');
      expect(mockNotifyUsers).toHaveBeenCalledWith([String(sam)], ORG, 'lead_message', 'Title', 'Message', expect.any(Object));
      expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
    } finally {
      await Lead.updateOne({ _id: assignedLead }, { $set: { assignedTo: mary } });
    }
  });

  it('conversation-only intake notices enforce the assigned owner without changing their notification type', async () => {
    expect(await notifyLeadPeople(notice('lead_new_inquiry', {
      leadId: assignedLead, assignedOwnerOnly: true, ownerIds: [sam],
    }))).toBe('owner');
    expect(mockNotifyUsers).toHaveBeenLastCalledWith([String(maryCrm)], ORG, 'lead_new_inquiry', 'Title', 'Message', expect.any(Object));
    expect(await notifyLeadPeople(notice('lead_new_inquiry', { leadId: quietLead, assignedOwnerOnly: true }))).toBe('team');
    expect(mockNotifyUsers).toHaveBeenLastCalledWith([String(fran)], ORG, 'lead_new_inquiry', 'Title', 'Message', expect.any(Object));
    expect(await notesOf(quietLead)).toHaveLength(0);
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('a customer reply cannot target a lead in another organization or an unsaved lead', async () => {
    for (const leadId of [assignedLead, new mongoose.Types.ObjectId()]) {
      expect(await notifyLeadPeople(notice('lead_message', { organizationId: BARE, leadId, ownerIds: [fran] }))).toBe('nobody');
    }
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('recipient lookup failure never broadcasts customer replies to administrators', async () => {
    const lookup = jest.spyOn(Lead, 'findOne').mockImplementationOnce(() => { throw new Error('lookup unavailable'); });
    try {
      await expect(notifyLeadPeople(notice('lead_message', { leadId: assignedLead }))).rejects.toThrow('lookup unavailable');
      expect(mockNotifyUsers).not.toHaveBeenCalled();
      expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });
});
