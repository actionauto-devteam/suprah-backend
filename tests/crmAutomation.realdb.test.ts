import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import CrmUser from '../src/models/CrmUser.model';
import User from '../src/models/User.model';
import CrmLocation from '../src/models/CrmLocation.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmDataSync from '../src/models/CrmDataSync.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import crmAutomationRoute from '../src/routes/crmAutomation.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/automations', crmAutomationRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const users = {
  employee: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  inactive: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const locations = {
  orem: new mongoose.Types.ObjectId(),
  lehi: new mongoose.Types.ObjectId(),
  archived: new mongoose.Types.ObjectId(),
  otherOrg: new mongoose.Types.ObjectId(),
};

const as = (who: keyof typeof users) => ({ Authorization: `Bearer ${tokens[who]}` });
const base = '/api/crm/automations';

const draft = (overrides: Record<string, unknown> = {}) => ({
  name: 'Contact form welcome',
  locations: { mode: 'specific', ids: [String(locations.orem)] },
  trigger: {
    source: 'suprah_leads',
    event: 'website_form_lead',
    filters: [
      { field: 'channel', operator: 'is', value: 'web' },
      { field: 'after_hours', operator: 'is_true', value: 'ignored' },
      { field: 'location', operator: 'is', value: String(locations.orem) },
      { field: 'assigned_to', operator: 'is_not', value: String(users.admin) },
      { field: 'lead_tags', operator: 'not_present' },
      { field: 'vehicle_make', operator: 'contains', value: ' Toyota ' },
    ],
    repeat: { mode: 'once_per_days', days: 30, per: ['customer_phone', 'customer_email', 'customer_phone'] },
    sendingHours: 'any_time',
    stopOnReply: true,
    aiContinuesOnReply: true,
  },
  steps: [
    { id: 'step-1', type: 'send_message', config: { body: 'Hi {first_name}, this is {agent_name} from {dealership_name}. Thanks for reaching out!', assignTo: 'ai_agent', timing: { when: 'after', amount: 2, unit: 'hours' } } },
    { id: 'step-2', type: 'wait', config: { amount: 2, unit: 'days' } },
    { id: 'step-3', type: 'send_notification', config: { recipients: 'people', userIds: [String(users.manager)], message: '{first_name} got the welcome text.' } },
    { id: 'step-4', type: 'assign_team_member', config: { userId: String(users.admin) } },
    { id: 'step-5', type: 'send_review_invitation', config: {} },
    { id: 'step-6', type: 'send_email', config: { subject: 'Your {vehicle}', body: 'Hi {first_name}, here are the details.', assignTo: String(users.manager) } },
    { id: 'step-7', type: 'send_appointment_confirmation', config: { ignored: true } },
    { id: 'step-8', type: 'unassign_team_member', config: {} },
    { id: 'step-9', type: 'send_ai_follow_up', config: { instructions: ' Offer a new test drive time. ' } },
    { id: 'step-10', type: 'create_task', config: { recipients: 'assigned', userIds: [String(users.manager)], task: 'Call {first_name} back today.' } },
    { id: 'step-11', type: 'update_lead_status', config: { status: 'Contacted' } },
  ],
  ...overrides,
});

describe('Real-DB proof: Automation builder endpoints (local dev MongoDB only)', () => {
  beforeAll(async () => {
    const member = (id: any, org: any, role: string, isActive = true) => ({ _id: id, organizationId: org, fullName: `Auto ${role}`, username: `auto-${id}`, email: `auto-${id}@example.com`, role, isActive, password: 'x' });
    await CrmUser.collection.insertMany([
      member(users.employee, orgA, 'employee'),
      member(users.manager, orgA, 'manager'),
      member(users.admin, orgA, 'admin'),
      member(users.inactive, orgA, 'employee', false),
      member(users.otherAdmin, orgB, 'admin'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    const person = (id: any, org: any, role: string, isActive = true) => ({ _id: id, organizationId: org, name: `Main ${role}`, email: `main-${id}@example.com`, role, isActive });
    await User.collection.insertMany([
      person(users.employee, orgA, 'employee'),
      person(users.manager, orgA, 'employee'),
      person(users.admin, orgA, 'admin'),
      person(users.inactive, orgA, 'employee', false),
      person(users.otherAdmin, orgB, 'admin'),
    ] as any[]);
    const location = (id: any, org: any, name: string, status = 'active') => ({ _id: id, organizationId: String(org), code: `c${String(id).slice(-6)}`, name, aliases: [], aliasKeys: [name.toLowerCase()], status, archivedAt: null, createdAt: new Date(), updatedAt: new Date() });
    await CrmLocation.collection.insertMany([
      location(locations.orem, orgA, 'Action Auto - Orem'),
      location(locations.lehi, orgA, 'Action Auto - Lehi'),
      location(locations.archived, orgA, 'Old Lot', 'archived'),
      location(locations.otherOrg, orgB, 'Other Dealer Lot'),
    ] as any[]);
  });

  afterAll(async () => {
    const both = [orgA, orgB, String(orgA), String(orgB)];
    await CrmUser.collection.deleteMany({ organizationId: { $in: both } });
    await User.collection.deleteMany({ organizationId: { $in: both } });
    await CrmLocation.collection.deleteMany({ organizationId: { $in: both } });
    await CrmAutomation.collection.deleteMany({ organizationId: { $in: both } });
    await CrmDataSync.collection.deleteMany({ organizationId: { $in: both } });
  });

  it('1. managers can view, only admins can change, employees are blocked', async () => {
    expect((await request(app).get(base).set(as('employee'))).status).toBe(403);
    const managerList = await request(app).get(base).set(as('manager'));
    expect(managerList.status).toBe(200);
    expect(managerList.body.data).toEqual({ items: [], canEdit: false });
    expect((await request(app).post(base).set(as('manager')).send(draft())).status).toBe(403);
    expect((await request(app).get(base).set(as('admin'))).body.data.canEdit).toBe(true);
  });

  it('2. options list Suprah sources, actions, the active locations, and active team members of this dealership only', async () => {
    const res = await request(app).get(`${base}/options`).set(as('manager'));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.sources.map((source: any) => source.label)).toEqual(['Suprah Leads', 'Suprah', 'ADF Lead Delivery', 'Inventory', 'On a Date']);
    expect(JSON.stringify(data)).not.toMatch(/podium/i);
    expect(data.sources.find((source: any) => source.key === 'on_a_date').groups).toEqual([]);
    expect(data.actions.map((action: any) => action.label)).toEqual(['Send a Review Invitation', 'Send a Message', 'Send an Appointment Confirmation', 'Branch', 'Send an Email', 'Send Notification', 'Assign to a team member', 'Remove the assigned team member', 'Send AI Follow-up Message', 'Create a Task for the Team', 'Update Lead Status', 'Wait']);
    const fields = Object.fromEntries(data.audienceFields.map((field: any) => [field.key, field]));
    expect(data.audienceFields.map((field: any) => field.label)).toEqual(['After hours', 'New contact', 'Channel', 'Lead source', 'Lead status', 'Lead tags', 'Assigned to', 'Location', 'Customer name', 'Customer email', 'Customer phone number', 'Vehicle make', 'Vehicle model', 'Vehicle condition']);
    expect(fields.location.choices.map((choice: any) => choice.label)).toEqual(['Action Auto - Lehi', 'Action Auto - Orem']);
    expect(fields.assigned_to.choices.map((choice: any) => choice.value).sort()).toEqual([String(users.admin), String(users.employee), String(users.manager)].sort());
    expect(fields.lead_source.choices.map((choice: any) => choice.value)).not.toContain('Demo');
    expect(fields.lead_status.choices.map((choice: any) => choice.value)).toContain('Appointment Set');
    expect(data.audienceOperators.boolean.map((op: any) => op.label)).toEqual(['is true', 'is false', 'is not present']);
    expect(fields.location.choicesFrom).toBeUndefined();
    expect(data.agentName).toBe('AI Agent');
    expect(data.locations.map((item: any) => item.name)).toEqual(['Action Auto - Lehi', 'Action Auto - Orem']);
    expect(data.team.map((item: any) => item.id).sort()).toEqual([String(users.admin), String(users.employee), String(users.manager)].sort());
  });

  it('3. an admin saves a full automation as a draft, and it comes back exactly', async () => {
    const created = await request(app).post(base).set(as('admin')).send(draft());
    expect(created.status).toBe(201);
    const automation = created.body.data.automation;
    expect(automation).toMatchObject({
      name: 'Contact form welcome',
      status: 'draft',
      locations: { mode: 'specific', ids: [String(locations.orem)] },
      trigger: {
        source: 'suprah_leads',
        event: 'website_form_lead',
        date: null,
        time: null,
        filters: [
          { field: 'channel', operator: 'is', value: 'web' },
          { field: 'after_hours', operator: 'is_true', value: null },
          { field: 'location', operator: 'is', value: String(locations.orem) },
          { field: 'assigned_to', operator: 'is_not', value: String(users.admin) },
          { field: 'lead_tags', operator: 'not_present', value: null },
          { field: 'vehicle_make', operator: 'contains', value: 'Toyota' },
        ],
        repeat: { mode: 'once_per_days', days: 30, per: ['customer_phone', 'customer_email'] },
        sendingHours: 'any_time',
        stopOnReply: true,
        cancelFirstOnReply: true,
        aiContinuesOnReply: true,
        stopOnFailure: false,
      },
      createdBy: { userId: String(users.admin), name: 'Auto admin' },
    });
    expect(automation.steps.map((step: any) => step.type)).toEqual(['send_message', 'wait', 'send_notification', 'assign_team_member', 'send_review_invitation', 'send_email', 'send_appointment_confirmation', 'unassign_team_member', 'send_ai_follow_up', 'create_task', 'update_lead_status']);
    const on = { when: 'on', amount: null, unit: null };
    expect(automation.steps[0].config).toEqual({ body: 'Hi {first_name}, this is {agent_name} from {dealership_name}. Thanks for reaching out!', timing: { when: 'after', amount: 2, unit: 'hours' }, assignTo: 'ai_agent' });
    expect(automation.steps[4].config).toEqual({ timing: on, assignTo: null });
    expect(automation.steps[1].config).toEqual({ amount: 2, unit: 'days' });
    expect(automation.steps.slice(5).map((step: any) => step.config)).toEqual([
      { subject: 'Your {vehicle}', body: 'Hi {first_name}, here are the details.', timing: on, assignTo: String(users.manager) },
      { timing: on, assignTo: null },
      {},
      { instructions: 'Offer a new test drive time.', timing: on },
      { recipients: 'assigned', userIds: [], task: 'Call {first_name} back today.' },
      { status: 'Contacted' },
    ]);

    const fetched = await request(app).get(`${base}/${automation.id}`).set(as('manager'));
    expect(fetched.body.data.automation).toEqual(automation);
    expect(fetched.body.data.canEdit).toBe(false);

    const minimal = await request(app).post(base).set(as('admin')).send({ name: 'Just a name' });
    expect(minimal.status).toBe(201);
    expect(minimal.body.data.automation).toMatchObject({ locations: { mode: 'all', ids: [] }, trigger: null, steps: [], status: 'draft' });
    const defaults = await request(app).post(base).set(as('admin')).send({ name: 'Defaults', trigger: { source: 'suprah', event: 'call_missed', stopOnReply: false, cancelFirstOnReply: true } });
    expect(defaults.body.data.automation.trigger).toMatchObject({ filters: [], repeat: { mode: 'once_per_days', days: 365, per: ['customer_phone'] }, sendingHours: 'sending_hours', stopOnReply: false, cancelFirstOnReply: false, aiContinuesOnReply: false, stopOnFailure: false });
    const everyTime = await request(app).post(base).set(as('admin')).send({ name: 'Every time', trigger: { source: 'suprah', event: 'call_missed', repeat: { mode: 'every_time', days: 9, per: ['x'] } } });
    expect(everyTime.body.data.automation.trigger.repeat).toEqual({ mode: 'every_time', days: null, per: [] });
  });

  it('3b. a Branch saves If paths with their own audience, repeat and steps, an Else, and nested branches, with plain rules', async () => {
    const branch = {
      id: 'b1',
      type: 'branch',
      config: {
        timing: { when: 'after', amount: 1, unit: 'days' },
        paths: [
          { id: 'p1', filters: [{ field: 'channel', operator: 'is', value: 'web' }], repeat: { mode: 'every_time' }, steps: [{ id: 'in1', type: 'send_message', config: { body: 'Web lead' } }] },
          { id: 'p2', filters: [], steps: [{ id: 'nested', type: 'branch', config: { paths: [{ id: 'np', filters: [], steps: [{ id: 'deep', type: 'wait', config: { amount: 1, unit: 'hours' } }] }], else: { doNothing: true, steps: [{ id: 'ignored', type: 'wait', config: { amount: 1, unit: 'hours' } }] } } }] },
        ],
        else: { doNothing: false, steps: [{ id: 'e1', type: 'send_notification', config: { recipients: 'admins', message: 'No match' } }] },
      },
    };
    const created = await request(app).post(base).set(as('admin')).send({ name: 'Branched', trigger: { source: 'suprah_leads', event: 'website_form_lead' }, steps: [{ id: 's0', type: 'send_message', config: { body: 'Hi' } }, branch] });
    expect(created.status).toBe(201);
    const saved = created.body.data.automation.steps[1];
    expect(saved.config.timing).toEqual({ when: 'after', amount: 1, unit: 'days' });
    expect(saved.config.paths[0]).toMatchObject({ id: 'p1', filters: [{ field: 'channel', operator: 'is', value: 'web' }], repeat: { mode: 'every_time', days: null, per: [] } });
    expect(saved.config.paths[1].repeat).toEqual({ mode: 'once_per_days', days: 365, per: ['customer_phone'] });
    expect(saved.config.paths[1].steps[0].config.else).toEqual({ doNothing: true, steps: [] });
    expect(saved.config.else.steps[0]).toMatchObject({ id: 'e1', type: 'send_notification' });
    const tries: Array<[any[], RegExp]> = [
      [[branch, { id: 'after', type: 'wait', config: { amount: 1, unit: 'days' } }], /must be the last step/],
      [[{ id: 'x1', type: 'branch', config: { paths: [{ id: 'a', steps: [{ id: 'x2', type: 'branch', config: { paths: [{ id: 'b', steps: [{ id: 'x3', type: 'branch', config: { paths: [{ id: 'c', steps: [{ id: 'x4', type: 'branch', config: {} }] }] } }] }] } }] }] } }], /3 levels deep/],
      [[{ id: 'd1', type: 'branch', config: { paths: [{ id: 'q', steps: [{ id: 'same', type: 'wait', config: { amount: 1, unit: 'days' } }] }], else: { steps: [{ id: 'same', type: 'wait', config: { amount: 1, unit: 'days' } }] } } }], /same id/],
      [[{ id: 'f1', type: 'branch', config: { paths: [{ id: 'q', filters: [{ field: 'channel', operator: 'contains', value: 'x' }] }] } }], /Pick an operation/],
    ];
    for (const [steps, message] of tries) {
      const res = await request(app).post(base).set(as('admin')).send({ name: 'Bad branch', steps });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    }
    const beforeInside = await request(app).post(base).set(as('admin')).send({ name: 'Before', trigger: { source: 'suprah', event: 'call_missed' }, steps: [{ id: 'b', type: 'branch', config: { paths: [{ id: 'p', steps: [{ id: 'm', type: 'send_message', config: { body: 'x', timing: { when: 'before', amount: 1, unit: 'days' } } }] }] } }] });
    expect(beforeInside.body.message).toMatch(/only works with appointment or On a Date triggers/);
    const empty = await request(app).post(base).set(as('admin')).send({ name: 'Empty branch', trigger: { source: 'suprah_leads', event: 'lead_created' }, steps: [{ id: 'm', type: 'send_message', config: { body: 'x' } }, { id: 'b', type: 'branch', config: { paths: [] } }] });
    expect(empty.status).toBe(201);
    const turnOn = await request(app).post(`${base}/${empty.body.data.automation.id}/status`).set(as('admin')).send({ status: 'active' });
    expect(turnOn.status).toBe(400);
    expect(turnOn.body.message).toMatch(/Each Branch needs at least one If condition/);
  });

  it('4. bad input is refused with a plain message', async () => {
    const tries: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: '   ' }, /name/],
      [{ locations: { mode: 'specific', ids: [] } }, /at least one location/],
      [{ locations: { mode: 'specific', ids: [String(locations.archived)] } }, /archived or does not exist/],
      [{ locations: { mode: 'specific', ids: [String(locations.otherOrg)] } }, /archived or does not exist/],
      [{ trigger: { source: 'podium', event: 'x' } }, /trigger source/],
      [{ trigger: { source: 'suprah', event: 'payment_settled' } }, /Choose a trigger/],
      [{ trigger: { source: 'on_a_date', date: '2026-02-30' } }, /valid date/],
      [{ trigger: { source: 'suprah', event: 'call_missed', repeat: { mode: 'once_per_days', days: 0 } } }, /between 1 and 365/],
      [{ trigger: { source: 'suprah', event: 'call_missed', filters: [{ field: 'birthday', operator: 'is_true' }] } }, /Pick a field/],
      [{ trigger: { source: 'suprah', event: 'call_missed', repeat: { mode: 'once' } } }, /how often it can repeat/],
      [{ trigger: { source: 'suprah', event: 'call_missed', repeat: { mode: 'once_per_days', days: 30, per: [] } } }, /at least one field the repeat/],
      [{ trigger: { source: 'suprah', event: 'call_missed', repeat: { mode: 'once_per_days', days: 30, per: ['contact_uid'] } } }, /repeat fields is not valid/],
      [{ trigger: { source: 'suprah', event: 'call_missed', sendingHours: 'night_only' } }, /when messages can be sent/],
      [{ steps: [{ type: 'send_email', config: { subject: '', body: 'Hi' } }] }, /email subject/],
      [{ steps: [{ type: 'send_email', config: { subject: 'Hi {nickname}', body: 'Hi' } }] }, /not a variable/],
      [{ steps: [{ type: 'update_lead_status', config: { status: 'Opportunity Won' } }] }, /new lead status/],
      [{ steps: [{ type: 'create_task', config: { recipients: 'people', userIds: [], task: 'x' } }] }, /at least one person for the task/],
      [{ steps: [{ type: 'send_ai_follow_up', config: { instructions: 'x'.repeat(501) } }] }, /AI instructions/],
      [{ steps: [{ type: 'send_message', config: { body: 'Hi', timing: { when: 'later' } } }] }, /Step 1: choose when it is delivered/],
      [{ steps: [{ type: 'send_message', config: { body: 'Hi', timing: { when: 'after', amount: 0, unit: 'days' } } }] }, /Step 1: the timing must be between 1 and 365 days/],
      [{ steps: [{ type: 'send_message', config: { body: 'Hi', timing: { when: 'after', amount: 3, unit: 'weeks' } } }] }, /Step 1: choose minutes, hours, or days/],
      [{ trigger: { source: 'suprah', event: 'call_missed' }, steps: [{ type: 'send_message', config: { body: 'Hi', timing: { when: 'before', amount: 1, unit: 'days' } } }] }, /only works with appointment or On a Date triggers/],
      [{ steps: [{ type: 'send_message', config: { body: 'Hi', assignTo: 'nobody' } }] }, /team members is not valid/],
      [{ steps: [{ type: 'send_message', config: { body: 'Hi', assignTo: String(users.inactive) } }] }, /inactive or not on this team/],
      [{ trigger: { source: 'suprah', event: 'call_missed', filters: [{ field: 'channel', operator: 'contains', value: 'sms' }] } }, /Pick an operation for "Channel"/],
      [{ trigger: { source: 'suprah', event: 'call_missed', filters: [{ field: 'customer_name', operator: 'is', value: '  ' }] } }, /Enter a value for "Customer name"/],
      [{ trigger: { source: 'suprah', event: 'call_missed', filters: [{ field: 'lead_status', operator: 'is', value: 'Podium Status' }] } }, /not a lead status option/],
      [{ trigger: { source: 'suprah', event: 'call_missed', filters: [{ field: 'location', operator: 'is', value: String(locations.archived) }] } }, /location in the audience/],
      [{ trigger: { source: 'suprah', event: 'call_missed', filters: [{ field: 'assigned_to', operator: 'is', value: String(users.otherAdmin) }] } }, /team member in the audience/],
      [{ trigger: { source: 'suprah', event: 'call_missed', filters: Array.from({ length: 11 }, () => ({ field: 'after_hours', operator: 'is_true' })) } }, /up to 10 filters/],
      [{ steps: [{ type: 'send_message', config: { body: 'Hi {firstname}' } }] }, /not a variable/],
      [{ steps: [{ type: 'send_payment_request', config: {} }] }, /not a supported action/],
      [{ steps: [{ type: 'wait', config: { amount: 400, unit: 'days' } }] }, /between 1 and 365 days/],
      [{ steps: [{ type: 'assign_team_member', config: { userId: String(users.inactive) } }] }, /inactive or not on this team/],
      [{ steps: [{ type: 'send_notification', config: { recipients: 'people', userIds: [String(users.otherAdmin)], message: 'x' } }] }, /inactive or not on this team/],
    ];
    for (const [patch, message] of tries) {
      const res = await request(app).post(base).set(as('admin')).send(draft(patch));
      expect({ patch, status: res.status }).toEqual({ patch, status: 400 });
      expect(res.body.message).toMatch(message);
    }
  });

  it('5b. deliver before trigger works for appointment and date triggers, and a trigger change that breaks it is refused', async () => {
    const before = { id: 'remind', type: 'send_message', config: { body: 'See you soon, {first_name}!', timing: { when: 'before', amount: 1, unit: 'days' } } };
    const booked = await request(app).post(base).set(as('admin')).send({ name: 'Day before', trigger: { source: 'suprah', event: 'appointment_booked' }, steps: [before] });
    expect(booked.status).toBe(201);
    expect(booked.body.data.automation.steps[0].config.timing).toEqual({ when: 'before', amount: 1, unit: 'days' });
    const dated = await request(app).post(base).set(as('admin')).send({ name: 'Date', trigger: { source: 'on_a_date', date: '2026-12-24', time: '09:00' }, steps: [before] });
    expect(dated.status).toBe(201);
    const broken = await request(app).patch(`${base}/${booked.body.data.automation.id}`).set(as('admin')).send({ trigger: { source: 'suprah', event: 'call_missed' } });
    expect(broken.status).toBe(400);
    expect(broken.body.message).toMatch(/only works with appointment or On a Date triggers/);
    const stillBooked = await request(app).get(`${base}/${booked.body.data.automation.id}`).set(as('admin'));
    expect(stillBooked.body.data.automation.trigger.event).toBe('appointment_booked');
  });

  it('5. on a date keeps a date and time and has no event', async () => {
    const res = await request(app).post(base).set(as('admin')).send(draft({ name: 'Holiday hours', trigger: { source: 'on_a_date', event: 'ignored', date: '2026-12-24', time: '09:00' } }));
    expect(res.status).toBe(201);
    expect(res.body.data.automation.trigger).toMatchObject({ source: 'on_a_date', event: null, date: '2026-12-24', time: '09:00', repeat: { mode: 'once_per_days', days: 365 } });
  });

  it('6b. alerts are saved only by admins, need someone to send to, and stay in range', async () => {
    const created = (await request(app).post(base).set(as('admin')).send({ name: 'Alerted' })).body.data.automation;
    expect(created.alerts).toMatchObject({ enabled: false, condition: 'min_events', minEvents: 1, days: 7, dropPercent: 50, userIds: [] });
    expect((await request(app).patch(`${base}/${created.id}/alerts`).set(as('manager')).send({ enabled: false })).status).toBe(403);
    const noOne = await request(app).patch(`${base}/${created.id}/alerts`).set(as('admin')).send({ enabled: true, userIds: [] });
    expect(noOne.status).toBe(400);
    expect(noOne.body.message).toMatch(/at least one person/);
    expect((await request(app).patch(`${base}/${created.id}/alerts`).set(as('admin')).send({ enabled: true, days: 0, userIds: [String(users.admin)] })).body.message).toMatch(/Days must be between 1 and 90/);
    expect((await request(app).patch(`${base}/${created.id}/alerts`).set(as('admin')).send({ enabled: true, userIds: [String(users.inactive)] })).body.message).toMatch(/inactive or not on this team/);
    const saved = await request(app).patch(`${base}/${created.id}/alerts`).set(as('admin')).send({ enabled: true, condition: 'percentage_drop', dropPercent: 40, days: 14, userIds: [String(users.admin), String(users.employee), String(users.admin)] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.automation.alerts).toMatchObject({ enabled: true, condition: 'percentage_drop', dropPercent: 40, days: 14, minEvents: 1, userIds: [String(users.admin), String(users.employee)] });
    const options = await request(app).get(`${base}/options`).set(as('admin'));
    expect(options.body.data.team.find((member: any) => member.id === String(users.admin)).email).toBe(`main-${users.admin}@example.com`);
  });

  it('6c. data syncs: admins add an appointment sync with name, status and locations; it stays unfinished and inside the dealership', async () => {
    const syncs = `${base}/syncs`;
    expect((await request(app).get(syncs).set(as('employee'))).status).toBe(403);
    expect((await request(app).get(syncs).set(as('manager'))).body.data).toEqual({ items: [], canEdit: false });
    expect((await request(app).post(syncs).set(as('manager')).send({ type: 'appointment', name: 'x' })).status).toBe(403);
    expect((await request(app).post(syncs).set(as('admin')).send({ type: 'contacts', name: 'x' })).body.message).toMatch(/data sync type/);
    expect((await request(app).post(syncs).set(as('admin')).send({ type: 'appointment', name: ' ' })).body.message).toMatch(/name/);
    expect((await request(app).post(syncs).set(as('admin')).send({ type: 'appointment', name: 'x', status: 'paused' })).body.message).toMatch(/Active or Inactive/);
    expect((await request(app).post(syncs).set(as('admin')).send({ type: 'appointment', name: 'x', locations: { mode: 'specific', ids: [String(locations.archived)] } })).body.message).toMatch(/archived or does not exist/);
    const created = await request(app).post(syncs).set(as('admin')).send({ type: 'appointment', name: 'Orem appointments', locations: { mode: 'specific', ids: [String(locations.orem)] } });
    expect(created.status).toBe(201);
    expect(created.body.data.sync).toMatchObject({ type: 'appointment', name: 'Orem appointments', status: 'active', setupComplete: false, locations: { mode: 'specific', ids: [String(locations.orem)] } });
    const id = created.body.data.sync.id;
    const edited = await request(app).patch(`${syncs}/${id}`).set(as('admin')).send({ status: 'inactive', locations: { mode: 'all' } });
    expect(edited.body.data.sync).toMatchObject({ status: 'inactive', locations: { mode: 'all', ids: [] }, name: 'Orem appointments' });
    expect((await request(app).get(`${syncs}/${id}`).set(as('manager'))).body.data.sync.name).toBe('Orem appointments');
    expect((await request(app).get(`${syncs}/${id}`).set(as('otherAdmin'))).status).toBe(404);
    expect((await request(app).get(syncs).set(as('otherAdmin'))).body.data.items).toEqual([]);
    expect((await request(app).delete(`${syncs}/${id}`).set(as('manager'))).status).toBe(403);
    expect((await request(app).delete(`${syncs}/${id}`).set(as('admin'))).status).toBe(200);
    expect((await request(app).get(syncs).set(as('admin'))).body.data.items).toEqual([]);
  });

  it('6. edit, tags, duplicate and delete work, and stay inside the dealership', async () => {
    const created = (await request(app).post(base).set(as('admin')).send(draft({ name: 'Missed call text' }))).body.data.automation;
    const edited = await request(app).patch(`${base}/${created.id}`).set(as('admin')).send({ name: 'Missed call text v2', locations: { mode: 'all' }, tags: ['Sales', ' sales ', 'After hours'] });
    expect(edited.status).toBe(200);
    expect(edited.body.data.automation).toMatchObject({ name: 'Missed call text v2', locations: { mode: 'all', ids: [] }, tags: ['Sales', 'After hours'] });
    expect(edited.body.data.automation.steps).toEqual(created.steps);

    const copy = await request(app).post(`${base}/${created.id}/duplicate`).set(as('admin'));
    expect(copy.status).toBe(201);
    expect(copy.body.data.automation).toMatchObject({ name: 'Copy of Missed call text v2', status: 'draft', tags: ['Sales', 'After hours'] });
    expect(copy.body.data.automation.steps.map((step: any) => step.id)).not.toEqual(created.steps.map((step: any) => step.id));

    expect((await request(app).get(`${base}/${created.id}`).set(as('otherAdmin'))).status).toBe(404);
    expect((await request(app).patch(`${base}/${created.id}`).set(as('otherAdmin')).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).delete(`${base}/${created.id}`).set(as('otherAdmin'))).status).toBe(404);
    expect((await request(app).delete(`${base}/${created.id}`).set(as('manager'))).status).toBe(403);

    expect((await request(app).delete(`${base}/${created.id}`).set(as('admin'))).status).toBe(200);
    expect((await request(app).get(`${base}/${created.id}`).set(as('admin'))).status).toBe(404);
    const list = (await request(app).get(base).set(as('admin'))).body.data.items.map((item: any) => item.name);
    expect(list).toContain('Copy of Missed call text v2');
    expect(list).not.toContain('Missed call text v2');
    expect((await request(app).get(base).set(as('otherAdmin'))).body.data.items).toEqual([]);
  });
});
