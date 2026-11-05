const mockSendSms = jest.fn();
const mockNotifyUsers = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const nodeCrypto = require('crypto');
  const keys = nodeCrypto.generateKeyPairSync('ed25519');
  const der: Buffer = keys.publicKey.export({ format: 'der', type: 'spki' });
  process.env.TELNYX_PUBLIC_KEY = der.subarray(der.length - 32).toString('base64');
  const actual = jest.requireActual('../src/services/telnyx.service');
  return { ...actual, COMPANY_NUMBER: '+18015550900', sendSms: (...args: unknown[]) => mockSendSms(...args) };
});
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: (...args: unknown[]) => mockNotifyUsers(...args),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import CrmLocation from '../src/models/CrmLocation.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import CrmAutomationCursor from '../src/models/CrmAutomationCursor.model';
import { CallLog, Conversation, CommunicationMessage } from '../src/models/communication.model';
import { setAutomationStatus } from '../src/services/crmAutomation.service';
import { checkAutomationAlerts, nextSendingTime, runDueSteps, sweepReplies, sweepTriggers } from '../src/services/crmAutomationEngine.service';
import { automationForMissedCallText } from '../src/services/crmAutomationCalls.service';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const orgId = new mongoose.Types.ObjectId();
const org = String(orgId);
const admin = new mongoose.Types.ObjectId();
const rep = new mongoose.Types.ObjectId();
const orem = new mongoose.Types.ObjectId();
const actor = { userId: String(admin), name: 'Engine Admin' };
const later = (ms: number) => new Date(Date.now() + ms);
let phoneSeq = 300;
const nextPhone = () => `+1801555${String(phoneSeq++).padStart(4, '0')}`;

async function automation(overrides: Record<string, any> = {}) {
  const { trigger, ...rest } = overrides;
  const doc = await CrmAutomation.create({
    organizationId: org,
    name: 'Engine test',
    locations: { mode: 'all', ids: [] },
    trigger: {
      source: 'suprah_leads',
      event: 'website_form_lead',
      filters: [],
      repeat: { mode: 'once_per_days', days: 365, per: ['customer_phone'] },
      sendingHours: 'any_time',
      stopOnReply: true,
      cancelFirstOnReply: true,
      aiContinuesOnReply: false,
      stopOnFailure: false,
      ...(trigger || {}),
    },
    steps: [{ id: 's1', type: 'send_message', config: { body: 'Hi {first_name}, thanks for contacting {dealership_name}!', timing: { when: 'on', amount: null, unit: null }, assignTo: null } }],
    status: 'draft',
    createdBy: actor,
    updatedBy: actor,
    ...rest,
  });
  return doc;
}

async function lead(overrides: Record<string, any> = {}) {
  const phone = overrides.phone || nextPhone();
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    firstName: 'Rosa',
    lastName: 'Diaz',
    phone,
    normalizedPhone: phone,
    email: `${phone.slice(-4)}@example.com`,
    channel: 'web',
    source: 'Website Inquiry',
    status: 'New',
    location: 'Action Auto - Orem',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await Lead.collection.insertOne(doc as any);
  return doc;
}

async function startCursor(now = new Date()) {
  await sweepTriggers(now);
  await sweepReplies(now);
}

describe('Real-DB proof: automation engine (local dev MongoDB only)', () => {
  beforeAll(async () => {
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    await Organization.collection.insertOne({ _id: orgId, name: 'Engine Motors', slug: `engine-${orgId}`, status: 'active', metadata: { aiAgentName: 'Maya' } } as any);
    await User.collection.insertMany([
      { _id: admin, organizationId: orgId, name: 'Engine Admin', email: `admin-${admin}@example.com`, role: 'admin', isActive: true },
      { _id: rep, organizationId: orgId, name: 'Engine Rep', email: `rep-${rep}@example.com`, role: 'employee', isActive: true },
    ] as any[]);
    await CrmLocation.collection.insertOne({ _id: orem, organizationId: org, code: 'orem', name: 'Action Auto - Orem', aliases: [], aliasKeys: ['action auto - orem', 'orem'], status: 'active', archivedAt: null } as any);
    await DealershipPhoneNumber.collection.insertOne({ organizationId: orgId, number: '+18015550950', label: 'Orem line', kind: 'location', location: 'Orem', department: '', createdBy: admin, updatedBy: admin, createdAt: new Date(), updatedAt: new Date() } as any);
  });

  beforeEach(async () => {
    mockSendSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
    mockNotifyUsers.mockReset().mockResolvedValue(undefined);
    await Promise.all([
      CrmAutomation.collection.deleteMany({ organizationId: org }),
      CrmAutomationRun.collection.deleteMany({}),
      CrmAutomationCursor.collection.deleteMany({}),
      Lead.collection.deleteMany({ organizationId: orgId }),
      Appointment.collection.deleteMany({ organizationId: org }),
      CallLog.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      Conversation.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      CommunicationMessage.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      Organization.collection.deleteOne({ _id: orgId }),
      DealershipPhoneNumber.collection.deleteMany({ organizationId: orgId }),
      User.collection.deleteMany({ organizationId: orgId }),
      CrmLocation.collection.deleteMany({ organizationId: org }),
      CrmAutomation.collection.deleteMany({ organizationId: org }),
      CrmAutomationRun.collection.deleteMany({}),
      CrmAutomationCursor.collection.deleteMany({}),
      Lead.collection.deleteMany({ organizationId: orgId }),
      Appointment.collection.deleteMany({ organizationId: org }),
      CallLog.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      Conversation.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      CommunicationMessage.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    ]);
    delete process.env.CRM_AUTOMATIONS_ENABLED;
  });

  it('1. an automation can only be turned on when its trigger and every step can really run', async () => {
    const review = await automation({ trigger: { source: 'suprah', event: 'review_received' } });
    await expect(setAutomationStatus(org, actor, String(review._id), 'active')).rejects.toThrow(/trigger is not live yet/);
    const onlyWait = await automation({ steps: [{ id: 'w', type: 'wait', config: { amount: 1, unit: 'days' } }] });
    await expect(setAutomationStatus(org, actor, String(onlyWait._id), 'test')).rejects.toThrow(/at least one action/);
    const ai = await automation({ steps: [{ id: 'a', type: 'send_ai_follow_up', config: { instructions: '', timing: { when: 'on' } } }] });
    await expect(setAutomationStatus(org, actor, String(ai._id), 'active')).rejects.toThrow(/not live yet: Send AI Follow-up Message/);
    await expect(setAutomationStatus(org, actor, String(ai._id), 'inactive')).resolves.toMatchObject({ status: 'inactive' });
    const ready = await automation();
    const on = await setAutomationStatus(org, actor, String(ready._id), 'active');
    expect(on.status).toBe('active');
    expect(on.statusChangedAt).toBeTruthy();
  });

  it('2. a live form lead gets the text, the team is notified, the lead is assigned, and non-matching leads are filtered with a reason', async () => {
    const auto = await automation({
      locations: { mode: 'specific', ids: [String(orem)] },
      trigger: { filters: [{ field: 'channel', operator: 'is', value: 'web' }] },
      steps: [
        { id: 'm', type: 'send_message', config: { body: 'Hi {first_name}, thanks for contacting {dealership_name}!', timing: { when: 'on', amount: null, unit: null }, assignTo: String(rep) } },
        { id: 'n', type: 'send_notification', config: { recipients: 'admins', userIds: [], message: 'New form lead {first_name}' } },
      ],
    });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const rosa = await lead();
    await lead({ firstName: 'Text', channel: 'sms' });
    await lead({ firstName: 'Lehi', location: 'Lehi Lot' });
    await lead({ firstName: 'Demo', source: 'Demo' });
    expect(await sweepTriggers(later(MINUTE))).toBe(3);

    const runs = await CrmAutomationRun.find({ automationId: auto._id }).lean();
    const byName = Object.fromEntries(runs.map((run: any) => [run.contact.firstName, run]));
    expect(byName.Rosa).toMatchObject({ status: 'waiting', mode: 'live', event: 'website_form_lead' });
    expect(byName.Text).toMatchObject({ status: 'filtered', reason: 'Did not match the audience' });
    expect(byName.Lehi).toMatchObject({ status: 'filtered', reason: 'Not at one of the selected locations' });
    expect(byName.Demo).toBeUndefined();

    expect(await runDueSteps(later(MINUTE))).toBe(1);
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms.mock.calls[0][0]).toBe(rosa.phone);
    expect(mockSendSms.mock.calls[0][1]).toBe('Hi Rosa, thanks for contacting Engine Motors! Reply STOP to opt out.');
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(admin)], org, 'lead_message', 'Automation: Engine test', 'New form lead Rosa', expect.objectContaining({ leadId: String(rosa._id) }));
    const assigned: any = await Lead.findById(rosa._id).lean();
    expect(String(assigned.assignedTo)).toBe(String(rep));
    const done: any = await CrmAutomationRun.findById(byName.Rosa._id).lean();
    expect(done.status).toBe('completed');
    expect(done.log.map((entry: any) => `${entry.type}:${entry.status}`)).toEqual(['send_message:sent', 'assign_team_member:done', 'send_notification:sent']);
    expect(await sweepTriggers(later(2 * MINUTE))).toBe(0);
  });

  it('3. repeat once per 365 days per phone stops a second run for the same contact', async () => {
    const auto = await automation({ trigger: { source: 'suprah_leads', event: 'lead_status_changed' } });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const now = Date.now();
    await lead({ statusHistory: [{ from: 'New', to: 'Contacted', changedAt: new Date(now + 1000) }, { from: 'Contacted', to: 'Working', changedAt: new Date(now + 2000) }] });
    await sweepTriggers(later(MINUTE));
    const runs = await CrmAutomationRun.find({ automationId: auto._id }).sort({ triggerAt: 1 }).lean();
    expect(runs.map((run: any) => run.status)).toEqual(['waiting', 'filtered']);
    expect(runs[1].reason).toBe('Already ran for this contact in the last 365 days');
  });

  it('4. Test Mode runs the steps but sends nothing and changes nothing', async () => {
    const auto = await automation({ steps: [
      { id: 'm', type: 'send_message', config: { body: 'Hello {first_name}', timing: { when: 'on' }, assignTo: String(rep) } },
      { id: 'u', type: 'unassign_team_member', config: {} },
    ] });
    await setAutomationStatus(org, actor, String(auto._id), 'test');
    await startCursor();
    const tess = await lead({ firstName: 'Tess', assignedTo: admin });
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    const run: any = await CrmAutomationRun.findOne({ automationId: auto._id }).lean();
    expect(run).toMatchObject({ mode: 'test', status: 'completed' });
    expect(run.log.map((entry: any) => entry.status)).toEqual(['test', 'test', 'test']);
    expect(run.log[0].detail).toBe(`Would text ${tess.phone}: Hello Tess Reply STOP to opt out.`);
    expect(mockSendSms).not.toHaveBeenCalled();
    const unchanged: any = await Lead.findById(tess._id).lean();
    expect(String(unchanged.assignedTo)).toBe(String(admin));
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await lead({ firstName: 'Tess', phone: tess.phone });
    await sweepTriggers(later(2 * MINUTE));
    const live: any = await CrmAutomationRun.findOne({ automationId: auto._id, mode: 'live' }).lean();
    expect(live).toMatchObject({ status: 'waiting', reason: null });
  });

  it('5. "2 hours after" waits, a reply stops it, and sending hours move a late-night text to 9 AM', async () => {
    const auto = await automation({
      trigger: { source: 'suprah', event: 'call_missed' },
      steps: [{ id: 'm', type: 'send_message', config: { body: 'Sorry we missed you', timing: { when: 'after', amount: 2, unit: 'hours' } } }],
    });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const caller = await lead({ firstName: 'Cal', createdAt: new Date(Date.now() - DAY) });
    const endedAt = new Date(Date.now() + 1000);
    await CallLog.collection.insertOne({ orgId: org, direction: 'inbound', from: caller.phone, to: '+18015550900', status: 'missed', leadId: caller._id, endedAt, createdAt: new Date(), updatedAt: new Date() } as any);
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    let run: any = await CrmAutomationRun.findOne({ automationId: auto._id }).lean();
    expect(run.status).toBe('waiting');
    expect(new Date(run.nextRunAt).getTime()).toBe(endedAt.getTime() + 2 * HOUR);
    expect(mockSendSms).not.toHaveBeenCalled();

    await Lead.collection.updateOne({ _id: caller._id }, { $set: { 'followUp.lastCustomerActivityAt': later(5 * MINUTE) } });
    await sweepReplies(later(6 * MINUTE));
    run = await CrmAutomationRun.findOne({ automationId: auto._id }).lean();
    expect(run).toMatchObject({ status: 'stopped', reason: 'The contact replied' });

    expect(nextSendingTime(new Date('2026-11-10T05:05:00Z')).toISOString()).toBe('2026-11-10T16:00:00.000Z');
    expect(nextSendingTime(new Date('2026-11-10T13:30:00Z')).toISOString()).toBe('2026-11-10T16:00:00.000Z');
    expect(nextSendingTime(new Date('2026-11-10T18:00:00Z')).toISOString()).toBe('2026-11-10T18:00:00.000Z');
  });

  it('6. with "also cancel the first message" off, a reply lets the first text go and then stops', async () => {
    const auto = await automation({
      trigger: { cancelFirstOnReply: false },
      steps: [
        { id: 'm', type: 'send_message', config: { body: 'First', timing: { when: 'after', amount: 1, unit: 'hours' } } },
        { id: 'm2', type: 'send_message', config: { body: 'Second', timing: { when: 'after', amount: 3, unit: 'hours' } } },
      ],
    });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const una = await lead({ firstName: 'Una' });
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    await Lead.collection.updateOne({ _id: una._id }, { $set: { 'followUp.lastCustomerActivityAt': later(5 * MINUTE) } });
    await sweepReplies(later(6 * MINUTE));
    await runDueSteps(later(2 * HOUR));
    const run: any = await CrmAutomationRun.findOne({ automationId: auto._id }).lean();
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms.mock.calls[0][1]).toBe('First Reply STOP to opt out.');
    expect(run).toMatchObject({ status: 'stopped', reason: 'The contact replied' });
  });

  it('7. appointment triggers: "1 day before" counts back from the appointment, and a no-show confirmation uses the next upcoming appointment of the lead', async () => {
    const booked = await automation({
      name: 'Day before',
      trigger: { source: 'suprah', event: 'appointment_booked' },
      steps: [{ id: 'r', type: 'send_message', config: { body: 'See you tomorrow', timing: { when: 'before', amount: 1, unit: 'days' } } }],
    });
    const noShow = await automation({
      name: 'No show',
      trigger: { source: 'suprah', event: 'appointment_no_show' },
      steps: [{ id: 'c', type: 'send_appointment_confirmation', config: { timing: { when: 'on' } } }],
    });
    await setAutomationStatus(org, actor, String(booked._id), 'active');
    await setAutomationStatus(org, actor, String(noShow._id), 'active');
    await startCursor();
    const ana = await lead({ firstName: 'Ana' });
    const startTime = new Date(Date.now() + 3 * DAY);
    await Appointment.collection.insertOne({ organizationId: org, title: 'Test drive', entryType: 'appointment', status: 'scheduled', leadId: ana._id, startTime, endTime: new Date(startTime.getTime() + HOUR), customerBooking: { firstName: 'Ana', phone: ana.phone }, createdAt: new Date(), updatedAt: new Date() } as any);
    await Appointment.collection.insertOne({ organizationId: org, title: 'Missed drive', entryType: 'appointment', status: 'no-show', leadId: ana._id, startTime: new Date(Date.now() - HOUR), endTime: new Date(), customerBooking: { firstName: 'Ana', phone: ana.phone }, statusHistory: [{ from: 'scheduled', to: 'no-show', changedAt: new Date(Date.now() + 1000) }], createdAt: new Date(Date.now() - DAY), updatedAt: new Date() } as any);
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    const dayBefore: any = await CrmAutomationRun.findOne({ automationId: booked._id }).lean();
    expect(dayBefore.status).toBe('waiting');
    expect(new Date(dayBefore.nextRunAt).getTime()).toBe(startTime.getTime() - DAY);
    const confirmation: any = await CrmAutomationRun.findOne({ automationId: noShow._id }).lean();
    expect(confirmation.status).toBe('completed');
    expect(confirmation.log[0]).toMatchObject({ type: 'send_appointment_confirmation', status: 'sent' });
    expect(mockSendSms.mock.calls[0][1]).toMatch(/^Hi Ana, this is Maya from Engine Motors\. Confirming your appointment "Test drive" on .+\. Reply YES to confirm or CANCEL to change it\. Reply STOP to opt out\.$/);
  });

  it('8. turning an automation off stops its waiting runs, and things that happened before it was turned on are ignored', async () => {
    const auto = await automation({ steps: [{ id: 'm', type: 'send_message', config: { body: 'Later', timing: { when: 'after', amount: 1, unit: 'days' } } }] });
    await lead({ firstName: 'Old', createdAt: new Date(Date.now() - 30 * 1000) });
    await CrmAutomationCursor.collection.insertOne({ key: `${org}:website_form_lead`, at: new Date(Date.now() - 10 * MINUTE) } as any);
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await sweepReplies();
    await lead({ firstName: 'New', createdAt: later(1000) });
    await sweepTriggers(later(MINUTE));
    const runs = await CrmAutomationRun.find({ automationId: auto._id }).lean();
    expect(runs.map((run: any) => run.contact.firstName)).toEqual(['New']);
    await runDueSteps(later(MINUTE));
    await setAutomationStatus(org, actor, String(auto._id), 'inactive');
    const stopped: any = await CrmAutomationRun.findOne({ automationId: auto._id }).lean();
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'The automation was turned off' });
    expect(await runDueSteps(later(2 * DAY))).toBe(0);
  });

  it('10. a Branch follows the first matching If, falls to Else when nothing matches or the If already ran, and can do nothing', async () => {
    const branched = await automation({
      trigger: { source: 'suprah_leads', event: 'lead_created', repeat: { mode: 'every_time' } },
      steps: [{ id: 'b', type: 'branch', config: {
        timing: { when: 'on' },
        paths: [
          { id: 'web', filters: [{ field: 'channel', operator: 'is', value: 'web' }], repeat: { mode: 'once_per_days', days: 30, per: ['customer_email'] }, steps: [{ id: 'mw', type: 'send_message', config: { body: 'Web path for {first_name}', timing: { when: 'on' } } }] },
          { id: 'sms', filters: [{ field: 'channel', operator: 'is', value: 'sms' }], repeat: { mode: 'every_time' }, steps: [{ id: 'ms', type: 'send_message', config: { body: 'Text path', timing: { when: 'on' } } }] },
        ],
        else: { doNothing: false, steps: [{ id: 'me', type: 'send_message', config: { body: 'Else path', timing: { when: 'on' } } }] },
      } }],
    });
    await setAutomationStatus(org, actor, String(branched._id), 'active');
    await startCursor();
    const web = await lead({ firstName: 'Wendy', email: 'wendy@example.com' });
    await lead({ firstName: 'Sam', channel: 'sms', source: 'Inbound SMS' });
    await lead({ firstName: 'Ella', channel: 'email', source: 'Email Inquiry' });
    await lead({ firstName: 'Wendy2', email: 'wendy@example.com', phone: nextPhone() });
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    const runs: any[] = await CrmAutomationRun.find({ automationId: branched._id }).lean();
    const byName = Object.fromEntries(runs.map((run) => [run.contact.firstName, run]));
    expect(byName.Wendy.log.map((entry: any) => `${entry.type}:${entry.detail.split(':')[0]}`)).toEqual(['branch:Followed If 1', 'send_message:Web path for Wendy Reply STOP to opt out.']);
    expect(byName.Sam.log[0].detail).toBe('Followed If 2');
    expect(byName.Ella.log[0].detail).toBe('No condition matched. Followed Else');
    expect(byName.Wendy2.log[0].detail).toBe('No condition matched. Followed Else');
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
    const bodies = mockSendSms.mock.calls.map((call) => call[1]).sort();
    expect(bodies).toEqual(['Else path Reply STOP to opt out.', 'Else path Reply STOP to opt out.', 'Text path Reply STOP to opt out.', `Web path for Wendy Reply STOP to opt out.`].sort());
    expect(String(byName.Wendy.contact.leadId)).toBe(String(web._id));

    const quiet = await automation({
      name: 'Quiet branch',
      trigger: { source: 'suprah_leads', event: 'lead_created', repeat: { mode: 'every_time' } },
      steps: [{ id: 'b2', type: 'branch', config: { timing: { when: 'on' }, paths: [{ id: 'never', filters: [{ field: 'lead_status', operator: 'is', value: 'Sold' }], repeat: { mode: 'every_time' }, steps: [{ id: 'sold', type: 'send_message', config: { body: 'Sold', timing: { when: 'on' } } }] }], else: { doNothing: true, steps: [] } } }],
    });
    await setAutomationStatus(org, actor, String(quiet._id), 'active');
    await sweepTriggers(later(2 * MINUTE));
    await lead({ firstName: 'Nora' });
    mockSendSms.mockClear();
    await sweepTriggers(later(3 * MINUTE));
    await runDueSteps(later(3 * MINUTE));
    const nora: any = await CrmAutomationRun.findOne({ automationId: quiet._id, 'contact.firstName': 'Nora' }).lean();
    expect(nora).toMatchObject({ status: 'completed' });
    expect(nora.log.map((entry: any) => entry.detail)).toEqual(['No condition matched. Else: do nothing']);
  });

  it('11. "Any call" runs for answered and missed calls, uses the location of the number that was called, fills {location_name}, and labels the text with the automation name', async () => {
    const auto = await automation({
      name: 'Auto text after call',
      locations: { mode: 'specific', ids: [String(orem)] },
      trigger: { source: 'suprah', event: 'call_any', repeat: { mode: 'every_time' }, sendingHours: 'any_time' },
      steps: [{ id: 'm', type: 'send_message', config: { body: 'Thanks for calling {location_name}!', timing: { when: 'on' } } }],
    });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const endedAt = new Date(Date.now() + 1000);
    const call = (from: string, to: string, status: string) => ({ orgId: org, direction: 'inbound', from, to, status, leadId: null, endedAt, createdAt: new Date(), updatedAt: new Date() });
    const newCaller = nextPhone();
    const answered = nextPhone();
    const otherLine = nextPhone();
    await CallLog.collection.insertMany([
      call(newCaller, '+18015550950', 'missed'),
      call(answered, '+1 (801) 555-0950', 'completed'),
      call(otherLine, '+18015550999', 'missed'),
      call(nextPhone(), '+18015550950', 'ringing'),
    ] as any[]);
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    const runs: any[] = await CrmAutomationRun.find({ automationId: auto._id }).lean();
    const byPhone = Object.fromEntries(runs.map((run) => [run.contact.phone, run]));
    expect(runs).toHaveLength(3);
    expect(byPhone[newCaller]).toMatchObject({ status: 'completed', event: 'call_any', location: 'Action Auto - Orem' });
    expect(byPhone[answered]).toMatchObject({ status: 'completed', location: 'Action Auto - Orem' });
    expect(byPhone[otherLine]).toMatchObject({ status: 'filtered', reason: 'Not at one of the selected locations' });
    expect(mockSendSms.mock.calls.map((sent) => sent[1])).toEqual(['Thanks for calling Action Auto - Orem! Reply STOP to opt out.', 'Thanks for calling Action Auto - Orem! Reply STOP to opt out.']);
    const messages: any[] = await CommunicationMessage.find({ orgId: { $in: [org, orgId] }, direction: 'outbound' }).lean();
    expect(messages.map((message) => message.sentBy)).toEqual([{ userId: 'system', name: 'Automation - Auto text after call' }, { userId: 'system', name: 'Automation - Auto text after call' }].map((value) => expect.objectContaining(value)));

    const anywhere = await automation({ name: 'Lead location text', trigger: { source: 'suprah', event: 'call_missed', repeat: { mode: 'every_time' }, sendingHours: 'any_time' }, steps: [{ id: 'l', type: 'send_message', config: { body: 'Hi from {location_name}', timing: { when: 'on' } } }] });
    await setAutomationStatus(org, actor, String(auto._id), 'inactive');
    await setAutomationStatus(org, actor, String(anywhere._id), 'active');
    await sweepTriggers(later(2 * MINUTE));
    const known = await lead({ firstName: 'Lena', location: 'orem' });
    const unknownPlace = await lead({ firstName: 'Paz', location: '' });
    const ended2 = new Date(Date.now() + 2 * MINUTE + 1000);
    await CallLog.collection.insertMany([
      { orgId: org, direction: 'inbound', from: known.phone, to: '+18015550999', status: 'missed', leadId: known._id, endedAt: ended2, createdAt: new Date(), updatedAt: new Date() },
      { orgId: org, direction: 'inbound', from: unknownPlace.phone, to: '+18015550999', status: 'missed', leadId: unknownPlace._id, endedAt: ended2, createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);
    mockSendSms.mockClear();
    await sweepTriggers(later(3 * MINUTE));
    await runDueSteps(later(3 * MINUTE));
    expect(mockSendSms.mock.calls.filter((sent) => [known.phone, unknownPlace.phone].includes(sent[0])).map((sent) => sent[1]).sort()).toEqual(['Hi from Action Auto - Orem Reply STOP to opt out.', 'Hi from Engine Motors Reply STOP to opt out.']);
  });

  it('12. the built-in missed-call text steps aside only when an active automation will text that missed call', async () => {
    const missed = (to: string, from = nextPhone()) => ({ orgId: org, from, to, leadId: null });
    expect(await automationForMissedCallText(missed('+18015550950'))).toBeNull();
    const auto = await automation({ name: 'Send a missed call follow-up', locations: { mode: 'specific', ids: [String(orem)] }, trigger: { source: 'suprah', event: 'call_missed' } });
    expect(await automationForMissedCallText(missed('+18015550950'))).toBeNull();
    await setAutomationStatus(org, actor, String(auto._id), 'test');
    expect(await automationForMissedCallText(missed('+18015550950'))).toBeNull();
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    expect(await automationForMissedCallText(missed('+18015550950'))).toBe('Send a missed call follow-up');
    expect(await automationForMissedCallText(missed('+18015550999'))).toBeNull();
    const oremLead = await lead({ location: 'Orem' });
    expect(await automationForMissedCallText(missed('+18015550999', oremLead.phone))).toBe('Send a missed call follow-up');
    expect(await automationForMissedCallText({ orgId: org, from: nextPhone(), to: '+18015550999', leadId: oremLead._id })).toBe('Send a missed call follow-up');
    const ended = await automation({ name: 'Thanks after an answered call', trigger: { source: 'suprah', event: 'call_ended' } });
    await setAutomationStatus(org, actor, String(ended._id), 'active');
    expect(await automationForMissedCallText(missed('+18015550999'))).toBeNull();
    process.env.CRM_AUTOMATIONS_ENABLED = 'false';
    expect(await automationForMissedCallText(missed('+18015550950'))).toBeNull();
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    const everywhere = await automation({ name: 'Any call text', trigger: { source: 'suprah', event: 'call_any' } });
    await setAutomationStatus(org, actor, String(everywhere._id), 'active');
    expect(await automationForMissedCallText(missed('+18015550999'))).toBe('Any call text');
  });

  it('13. the missed-call check follows the automation audience and Repeat, and needs a text step, so a caller is never left without a text', async () => {
    const taskOnly = await automation({ name: 'Call back task', trigger: { source: 'suprah', event: 'call_missed' }, steps: [{ id: 't', type: 'create_task', config: { recipients: 'admins', task: 'Call them back', timing: { when: 'on' } } }] });
    await setAutomationStatus(org, actor, String(taskOnly._id), 'active');
    const web = await lead({ source: 'Website Inquiry' });
    const walkIn = await lead({ source: 'Walk-in' });
    const call = (who: any) => ({ orgId: org, from: who.phone, to: '+18015550999', leadId: who._id });
    expect(await automationForMissedCallText(call(web))).toBeNull();
    const auto = await automation({ name: 'Website callers', trigger: { source: 'suprah', event: 'call_missed', filters: [{ field: 'lead_source', operator: 'is', value: 'Website Inquiry' }] } });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    expect(await automationForMissedCallText(call(walkIn))).toBeNull();
    expect(await automationForMissedCallText(call(web))).toBe('Website callers');
    await startCursor();
    const ended = new Date(Date.now() + 1000);
    await CallLog.collection.insertOne({ orgId: org, direction: 'inbound', from: web.phone, to: '+18015550999', status: 'missed', leadId: web._id, endedAt: ended, createdAt: new Date(), updatedAt: new Date() } as any);
    await sweepTriggers(later(MINUTE));
    expect(await CrmAutomationRun.countDocuments({ automationId: auto._id, status: { $ne: 'filtered' } })).toBe(1);
    expect(await automationForMissedCallText(call(web))).toBeNull();
    await CrmAutomation.updateOne({ _id: auto._id }, { $set: { 'trigger.repeat': { mode: 'every_time', days: null, per: [] } } });
    expect(await automationForMissedCallText(call(web))).toBe('Website callers');
  });

  it('9. alerts tell the chosen people when an automation ran too little or dropped, once a day, and never for a new automation', async () => {
    const tenAm = new Date('2026-11-20T17:00:00Z');
    const quiet = await automation({ name: 'Quiet one', status: 'active', statusChangedAt: new Date(tenAm.getTime() - 10 * DAY), alerts: { enabled: true, condition: 'min_events', minEvents: 2, days: 7, dropPercent: 50, userIds: [String(admin)] } });
    const dropped = await automation({ name: 'Dropped one', status: 'active', statusChangedAt: new Date(tenAm.getTime() - 20 * DAY), alerts: { enabled: true, condition: 'percentage_drop', minEvents: 1, days: 7, dropPercent: 50, userIds: [String(rep)] } });
    const fresh = await automation({ name: 'New one', status: 'active', statusChangedAt: new Date(tenAm.getTime() - DAY), alerts: { enabled: true, condition: 'min_events', minEvents: 5, days: 7, dropPercent: 50, userIds: [String(admin)] } });
    const run = (automationId: any, daysAgo: number, status = 'completed') => ({ organizationId: org, automationId, automationName: 'x', mode: 'live', event: 'website_form_lead', eventKey: `k-${automationId}-${daysAgo}-${Math.random()}`, triggerAt: new Date(tenAm.getTime() - daysAgo * DAY), contact: { leadId: null, name: '', firstName: '', phone: '', email: '' }, status, steps: [], log: [], createdAt: new Date(tenAm.getTime() - daysAgo * DAY), updatedAt: new Date() });
    await CrmAutomationRun.collection.insertMany([
      run(quiet._id, 2), run(quiet._id, 3, 'filtered'), run(quiet._id, 4, 'filtered'),
      run(dropped._id, 8), run(dropped._id, 9), run(dropped._id, 10), run(dropped._id, 11), run(dropped._id, 3),
    ] as any[]);
    expect(await checkAutomationAlerts(new Date('2026-11-20T14:00:00Z'))).toBe(0);
    expect(await checkAutomationAlerts(tenAm)).toBe(2);
    const calls = mockNotifyUsers.mock.calls.filter((call) => call[2] === 'automation_alert');
    expect(calls.map((call) => call[3]).sort()).toEqual(['Automation alert: Dropped one', 'Automation alert: Quiet one']);
    const quietCall = calls.find((call) => call[3] === 'Automation alert: Quiet one') as any[];
    expect(quietCall[0]).toEqual([String(admin)]);
    expect(quietCall[4]).toMatch(/^It ran 1 time in the last 7 days, below the alert level of 2\./);
    const dropCall = calls.find((call) => call[3] === 'Automation alert: Dropped one') as any[];
    expect(dropCall[0]).toEqual([String(rep)]);
    expect(dropCall[4]).toMatch(/^It ran 1 time in the last 7 days, down 75% from 4 the 7 days before\./);
    expect(await checkAutomationAlerts(new Date(tenAm.getTime() + 2 * HOUR))).toBe(0);
    const saved: any = await CrmAutomation.findById(fresh._id).lean();
    expect(saved.alerts.lastAlertAt).toBeNull();
    expect(saved.alerts.lastCheckedAt).toBeTruthy();
  });
});
