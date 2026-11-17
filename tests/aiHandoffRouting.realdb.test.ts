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
import AiAgentTask from '../src/models/AiAgentTask.model';
import Notification from '../src/models/Notification.model';
import { resolveAiHandoffRouting, writeAiHandoff } from '../src/services/aiHandoffRouting.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
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
const oldTeam = new mongoose.Types.ObjectId();
const assignedLead = new mongoose.Types.ObjectId();
const openLead = new mongoose.Types.ObjectId();

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: orgId }),
    User.collection.deleteMany({ organizationId: orgId }),
    CrmUser.collection.deleteMany({ organizationId: orgId }),
    CrmLeadGroup.collection.deleteMany({ organizationId: orgId }),
    Lead.collection.deleteMany({ organizationId: orgId }),
    AiAgentTask.collection.deleteMany({ organizationId: { $in: [orgId, ORG] } }),
    Notification.collection.deleteMany({ organizationId: { $in: [orgId, ORG] } }),
  ]);
}

describe('Real-DB: who the AI tags on a handoff (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Organization.collection.insertOne({
      _id: orgId,
      name: 'Tagging Motors',
      slug: `tagging-${orgId}`,
      status: 'active',
      metadata: {
        aiHandoffTopicTeams: { availability: String(onlineTeam), appointment: String(salesTeam), pricing: String(oldTeam) },
        aiHandoffFallbackGroupId: String(fallbackTeam),
      },
    } as any);
    await User.collection.insertMany([
      { _id: mary, organizationId: orgId, name: 'Mary Cruz', email: 'mary@tag.test', role: 'employee', isActive: true },
      { _id: olive, organizationId: orgId, name: 'Olive Online', email: 'olive@tag.test', role: 'employee', isActive: true },
      { _id: owen, organizationId: orgId, name: 'Owen Gone', email: 'owen@tag.test', role: 'employee', isActive: false },
      { _id: sam, organizationId: orgId, name: 'Sam Sales', email: 'sam@tag.test', role: 'employee', isActive: true },
      { _id: fran, organizationId: orgId, name: 'Fran Fallback', email: 'fran@tag.test', role: 'employee', isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: maryCrm, organizationId: orgId, fullName: 'Mary Cruz', email: 'mary@tag.test', isActive: true },
      { _id: oliveCrm, organizationId: orgId, fullName: 'Olive Online', email: 'olive@tag.test', isActive: true },
    ] as any[]);
    await CrmLeadGroup.collection.insertMany([
      { _id: onlineTeam, organizationId: orgId, name: 'Online Team', memberIds: [olive, owen], isActive: true, roundRobinCursor: 0 },
      { _id: salesTeam, organizationId: orgId, name: 'Sales Team', memberIds: [sam], isActive: true, roundRobinCursor: 0 },
      { _id: fallbackTeam, organizationId: orgId, name: 'Fallback Team', memberIds: [fran], isActive: true, roundRobinCursor: 0 },
      { _id: oldTeam, organizationId: orgId, name: 'Old Team', memberIds: [sam], isActive: false, roundRobinCursor: 0 },
    ] as any[]);
    await Lead.collection.insertMany([
      { _id: assignedLead, organizationId: orgId, createdBy: mary, firstName: 'Tina', lastName: 'Tacoma', phone: '+18015556001', status: 'Contacted', source: 'Website', channel: 'sms', assignedTo: mary, createdAt: new Date(), updatedAt: new Date() },
      { _id: openLead, organizationId: orgId, createdBy: mary, firstName: 'Ulysses', lastName: 'Open', phone: '+18015556002', status: 'New', source: 'Website', channel: 'sms', createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);
  });

  afterAll(cleanup);

  it('1. assigned lead + availability: tags the Online Team and the rep, and both get the task', async () => {
    const routing = await resolveAiHandoffRouting({ organizationId: ORG, assignedTo: mary, topic: 'availability' });
    expect(routing.team).toMatchObject({ id: String(onlineTeam), name: 'Online Team' });
    expect(routing.rep).toMatchObject({ id: String(mary), name: 'Mary Cruz' });
    expect(routing.mentionPrefix).toBe('@Online Team, @Mary Cruz, ');
    expect(routing.mentionedUserIds).toEqual([String(mary)]);
    expect(routing.mentionedGroupIds).toEqual([String(onlineTeam)]);
    expect(routing.assigneeIds.sort()).toEqual([String(mary), String(olive)].sort());
  });

  it('2. topics without a team: the rep alone when assigned, the fallback team when nobody is assigned', async () => {
    const assigned = await resolveAiHandoffRouting({ organizationId: ORG, assignedTo: mary, topic: 'financing' });
    expect(assigned.team).toBeNull();
    expect(assigned.mentionPrefix).toBe('@Mary Cruz, ');
    const unassigned = await resolveAiHandoffRouting({ organizationId: ORG, topic: 'financing' });
    expect(unassigned.team).toMatchObject({ name: 'Fallback Team' });
    expect(unassigned.assigneeIds).toEqual([String(fran)]);
    const sales = await resolveAiHandoffRouting({ organizationId: ORG, topic: 'appointment' });
    expect(sales.mentionPrefix).toBe('@Sales Team, ');
  });

  it('3. a team that was turned off is skipped', async () => {
    const assigned = await resolveAiHandoffRouting({ organizationId: ORG, assignedTo: mary, topic: 'pricing' });
    expect(assigned.team).toBeNull();
    const unassigned = await resolveAiHandoffRouting({ organizationId: ORG, topic: 'pricing' });
    expect(unassigned.team).toMatchObject({ name: 'Fallback Team' });
  });

  it('4. the AI note starts with the tags, then the concern and topic; the task and CRM bell notices reach the team and rep', async () => {
    await writeAiHandoff({
      organizationId: ORG,
      leadId: String(assignedLead),
      channel: 'sms',
      reason: 'Customer wants to confirm the 2021 Tacoma is still on the lot',
      topic: 'availability',
      agentName: 'Anna',
      customerName: 'Tina Tacoma',
      assignedTo: mary,
    });
    const lead: any = await Lead.findById(assignedLead).lean();
    const note = lead.notes[lead.notes.length - 1];
    expect(note.text).toBe('@Online Team, @Mary Cruz, Customer wants to confirm the 2021 Tacoma is still on the lot. Topic: Vehicle availability.');
    expect(note).toMatchObject({ authorType: 'ai', authorName: 'Anna' });
    expect(note.mentionedUserIds.map(String)).toEqual([String(mary)]);
    expect(note.mentionedGroupIds.map(String)).toEqual([String(onlineTeam)]);

    const task: any = await AiAgentTask.findOne({ leadId: assignedLead }).lean();
    expect(task.assigneeIds.map(String).sort()).toEqual([String(mary), String(olive)].sort());

    const notices = await Notification.find({ type: 'ai_agent_handoff_needed', 'metadata.leadId': String(assignedLead) }).lean();
    expect(notices.map((n: any) => String(n.userId)).sort()).toEqual([String(maryCrm), String(oliveCrm)].sort());
    expect(notices.some((n: any) => String(n.userId) === String(owen))).toBe(false);
    expect(await Notification.countDocuments({ type: 'lead_note_mention', 'metadata.leadId': String(assignedLead) })).toBe(0);
  });

  it('5. with no topic from the AI, the words decide; nobody assigned and no team for it uses the fallback team', async () => {
    await writeAiHandoff({
      organizationId: ORG,
      leadId: String(openLead),
      channel: 'webchat',
      reason: 'please call me back after 5',
      agentName: 'Anna',
      customerName: 'Ulysses Open',
    });
    const lead: any = await Lead.findById(openLead).lean();
    const note = lead.notes[lead.notes.length - 1];
    expect(note.text).toBe('@Fallback Team, Please call me back after 5. Topic: Wants a call or a person.');
    const notices = await Notification.find({ type: 'ai_agent_handoff_needed', 'metadata.leadId': String(openLead) }).lean();
    expect(notices.map((n: any) => String(n.userId))).toEqual([String(fran)]);
  });

  it('6. a note suffix stays at the end and a handoff with no one to tag still writes a plain note', async () => {
    await Organization.updateOne({ _id: orgId }, { $unset: { 'metadata.aiHandoffFallbackGroupId': '' } });
    await writeAiHandoff({
      organizationId: ORG,
      leadId: String(openLead),
      channel: 'webchat',
      reason: 'needs a shipping quote to Texas.',
      agentName: 'Anna',
      customerName: 'Ulysses Open',
      noteSuffix: '(Do not text this customer.)',
    });
    const lead: any = await Lead.findById(openLead).lean();
    const note = lead.notes[lead.notes.length - 1];
    expect(note.text).toBe('Needs a shipping quote to Texas. Topic: Shipping and delivery. (Do not text this customer.)');
    expect(note.mentionedGroupIds).toEqual([]);
  });
});
