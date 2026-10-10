import request from 'supertest';
import app from '../src/server';
import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';

describe('AI agent coaching routes', () => {
  let org: any;
  let employee: any;
  let manager: any;
  let lead: any;
  let conversation: any;
  let aiMessage: any;
  let employeeToken: string;
  let managerToken: string;

  beforeAll(async () => {
    jest.setTimeout(30000);

    org = await Organization.create({
      name: 'AI Coaching Test Org',
      slug: `ai-coaching-test-${Date.now()}`,
      status: 'active',
    });

    employee = await CrmUser.create({
      organizationId: org._id,
      fullName: 'Rep User',
      username: `rep-${Date.now()}`,
      email: `rep-${Date.now()}@example.com`,
      password: 'Password123!',
      role: 'employee',
      isActive: true,
    });

    manager = await CrmUser.create({
      organizationId: org._id,
      fullName: 'Manager User',
      username: `manager-${Date.now()}`,
      email: `manager-${Date.now()}@example.com`,
      password: 'Password123!',
      role: 'manager',
      isActive: true,
    });

    employeeToken = generateCrmToken(String(employee._id));
    managerToken = generateCrmToken(String(manager._id));

    lead = await Lead.create({
      organizationId: org._id,
      createdBy: employee._id,
      firstName: 'Coach',
      lastName: 'Customer',
      phone: '+18015550123',
      source: 'Manual Entry',
      channel: 'sms',
      status: 'New',
      vehicle: {},
      comments: '',
    });

    conversation = await Conversation.create({
      orgId: String(org._id),
      leadId: lead._id,
      customerPhone: '+18015550123',
      messageCount: 1,
    });

    aiMessage = await CommunicationMessage.create({
      orgId: String(org._id),
      conversationId: conversation._id,
      leadId: lead._id,
      direction: 'outbound',
      body: 'Thanks! What time works best for you?',
      from: '+18015550000',
      to: '+18015550123',
      status: 'sent',
      sentBy: { userId: 'ai-agent', name: 'Alex' },
    });
  });

  afterAll(async () => {
    await Promise.all([
      AiAgentCoachingRule.deleteMany({ organizationId: String(org?._id) }),
      CommunicationMessage.deleteMany({ conversationId: conversation?._id }),
      Conversation.deleteMany({ _id: conversation?._id }),
      Lead.deleteMany({ _id: lead?._id }),
      CrmUser.deleteMany({ _id: { $in: [employee?._id, manager?._id].filter(Boolean) } }),
      Organization.deleteMany({ _id: org?._id }),
    ]);
  });

  it('lets regular CRM staff submit coaching tied to a verified Alex SMS message', async () => {
    const res = await request(app)
      .post('/api/crm/ai-coaching')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leadId: String(lead._id),
        messageId: String(aiMessage._id),
        channel: 'sms',
        instruction: "Ask for the customer's preferred appointment time first.",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.instruction).toContain('preferred appointment time');
    expect(res.body.data.sourceMessageModel).toBe('CommunicationMessage');
    expect(res.body.data.originalAiMessageSnapshot).toContain('What time works best');

    const saved = await AiAgentCoachingRule.findById(res.body.data.id).lean();
    expect(saved?.organizationId).toBe(String(org._id));
    expect(saved?.createdByName).toBe('Rep User');
  });

  it('rejects coaching for non-Alex messages', async () => {
    const staffMessage = await CommunicationMessage.create({
      orgId: String(org._id),
      conversationId: conversation._id,
      leadId: lead._id,
      direction: 'outbound',
      body: 'Staff reply',
      from: '+18015550000',
      to: '+18015550123',
      status: 'sent',
      sentBy: { userId: String(employee._id), name: 'Rep User' },
    });

    const res = await request(app)
      .post('/api/crm/ai-coaching')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leadId: String(lead._id),
        messageId: String(staffMessage._id),
        channel: 'sms',
        instruction: 'This should not be accepted.',
      });

    expect(res.status).toBe(404);
  });

  it('allows managers to disable organization-wide coaching', async () => {
    const rule = await AiAgentCoachingRule.create({
      organizationId: String(org._id),
      scope: 'organization',
      channel: 'all',
      instruction: 'Prefer newest instruction.',
      status: 'active',
      sourceLeadId: lead._id,
      sourceMessageId: aiMessage._id,
      sourceMessageModel: 'CommunicationMessage',
      originalAiMessageSnapshot: aiMessage.body,
      createdBy: employee._id,
      createdByName: 'Rep User',
    });

    const res = await request(app)
      .patch(`/api/crm/ai-coaching/${rule._id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ status: 'disabled' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('disabled');
  });

  it('prevents regular employees from disabling coaching', async () => {
    const rule = await AiAgentCoachingRule.create({
      organizationId: String(org._id),
      scope: 'organization',
      channel: 'all',
      instruction: 'Only management can disable this.',
      status: 'active',
      sourceLeadId: lead._id,
      sourceMessageId: aiMessage._id,
      sourceMessageModel: 'CommunicationMessage',
      originalAiMessageSnapshot: aiMessage.body,
      createdBy: employee._id,
      createdByName: 'Rep User',
    });

    const res = await request(app)
      .patch(`/api/crm/ai-coaching/${rule._id}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ status: 'disabled' });

    expect(res.status).toBe(403);
  });
});
