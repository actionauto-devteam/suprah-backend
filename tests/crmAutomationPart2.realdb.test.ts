const mockSendSms = jest.fn();
const mockNotifyUsers = jest.fn();
const mockGenerate = jest.fn();
const mockClassify = jest.fn();

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
jest.mock('../src/services/aiAgent.service', () => ({
  ...jest.requireActual('../src/services/aiAgent.service'),
  generateProactiveFollowUp: (...args: unknown[]) => mockGenerate(...args),
  classifyAlexReplySafety: (...args: unknown[]) => mockClassify(...args),
}));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Vehicle from '../src/models/Vehicle.model';
import CrmLocation from '../src/models/CrmLocation.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import CrmAutomationCursor from '../src/models/CrmAutomationCursor.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import { CallRecording } from '../src/models/CallRecording.model';
import { CallLog, Conversation, CommunicationMessage } from '../src/models/communication.model';
import { createAutomation, setAutomationStatus, updateAutomation } from '../src/services/crmAutomation.service';
import { retryRun, runDueSteps, sweepDateTriggers, sweepReplies, sweepTriggers } from '../src/services/crmAutomationEngine.service';
import { dateTriggerTimes } from '../src/services/crmAutomationSources.service';
import { listAutomationActivity } from '../src/services/crmAutomationMonitor.service';
import { toCompanyDateStr } from '../src/utils/companyTimezone';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const orgId = new mongoose.Types.ObjectId();
const org = String(orgId);
const admin = new mongoose.Types.ObjectId();
const rep = new mongoose.Types.ObjectId();
const orem = new mongoose.Types.ObjectId();
const actor = { userId: String(admin), name: 'Part Two Admin' };
const later = (ms: number) => new Date(Date.now() + ms);
const ago = (ms: number) => new Date(Date.now() - ms);
let phoneSeq = 700;
const nextPhone = () => `+1801555${String(phoneSeq++).padStart(4, '0')}`;
const message = (body: string, timing: Record<string, unknown> = { when: 'on', amount: null, unit: null }) => ({ id: `m${phoneSeq}${Math.round(Math.random() * 1e6)}`, type: 'send_message', config: { body, timing, assignTo: null } });

async function automation(overrides: Record<string, any> = {}) {
  const { trigger, ...rest } = overrides;
  return CrmAutomation.create({
    organizationId: org,
    name: 'Part two test',
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
    steps: [message('Hi {first_name}!')],
    status: 'draft',
    createdBy: actor,
    updatedBy: actor,
    ...rest,
  });
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

async function textThread(leadDoc: any, at: Date, sentBy: Record<string, unknown> = { userId: String(rep), name: 'Part Two Rep' }) {
  const conversationId = new mongoose.Types.ObjectId();
  await Conversation.collection.insertOne({ _id: conversationId, orgId, customerPhone: leadDoc.phone, leadId: leadDoc._id, lastMessageAt: at, lastDirection: 'outbound', messageCount: 1, createdAt: at, updatedAt: at } as any);
  await CommunicationMessage.collection.insertOne({ orgId, conversationId, leadId: leadDoc._id, direction: 'outbound', body: 'Any questions about the car?', from: '+18015550900', to: leadDoc.phone, status: 'delivered', sentBy, createdAt: at, updatedAt: at } as any);
  return conversationId;
}

async function startCursor(now = new Date()) {
  await sweepTriggers(now);
  await sweepReplies(now);
}

async function setSmsMode(mode: string) {
  await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiAgentModes': { sms: mode, email: 'off', webchat: 'off' } } });
}

async function only(automationId: unknown) {
  return CrmAutomationRun.find({ automationId }).sort({ createdAt: 1 }).lean() as Promise<any[]>;
}

describe('Real-DB proof: automations Part 2 (local dev MongoDB only)', () => {
  beforeAll(async () => {
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    process.env.AI_AGENT_ENABLED = 'true';
    await Organization.collection.insertOne({ _id: orgId, name: 'Part Two Motors', slug: `part-two-${orgId}`, status: 'active', metadata: { aiAgentName: 'Maya', aiAgentModes: { sms: 'live', email: 'off', webchat: 'off' } } } as any);
    await User.collection.insertMany([
      { _id: admin, organizationId: orgId, name: 'Part Two Admin', email: `admin-${admin}@example.com`, role: 'admin', isActive: true },
      { _id: rep, organizationId: orgId, name: 'Part Two Rep', email: `rep-${rep}@example.com`, role: 'employee', isActive: true },
    ] as any[]);
    await CrmLocation.collection.insertOne({ _id: orem, organizationId: org, code: 'orem', name: 'Action Auto - Orem', aliases: [], aliasKeys: ['action auto - orem', 'orem'], status: 'active', archivedAt: null } as any);
    await DealershipPhoneNumber.collection.insertOne({ organizationId: orgId, number: '+18015550951', label: 'Orem line', kind: 'location', location: 'Orem', department: '', createdBy: admin, updatedBy: admin, createdAt: new Date(), updatedAt: new Date() } as any);
  });

  beforeEach(async () => {
    mockSendSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
    mockNotifyUsers.mockReset().mockResolvedValue(undefined);
    mockGenerate.mockReset().mockResolvedValue({ text: 'Hi Rosa, just checking in. Want to pick a time to stop by this week?' });
    mockClassify.mockReset().mockResolvedValue('SAFE');
    await setSmsMode('live');
    await Promise.all([
      CrmAutomation.collection.deleteMany({ organizationId: org }),
      CrmAutomationRun.collection.deleteMany({ organizationId: org }),
      CrmAutomationCursor.collection.deleteMany({}),
      Lead.collection.deleteMany({ organizationId: orgId }),
      Vehicle.collection.deleteMany({ organizationId: org }),
      CallLog.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      CallRecording.collection.deleteMany({ organizationId: org }),
      Conversation.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      CommunicationMessage.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      Organization.collection.deleteOne({ _id: orgId }),
      User.collection.deleteMany({ organizationId: orgId }),
      CrmLocation.collection.deleteMany({ organizationId: org }),
      DealershipPhoneNumber.collection.deleteMany({ organizationId: orgId }),
      CrmAutomation.collection.deleteMany({ organizationId: org }),
      CrmAutomationRun.collection.deleteMany({ organizationId: org }),
      CrmAutomationCursor.collection.deleteMany({}),
      Lead.collection.deleteMany({ organizationId: orgId }),
      Vehicle.collection.deleteMany({ organizationId: org }),
      CallLog.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      CallRecording.collection.deleteMany({ organizationId: org }),
      Conversation.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
      CommunicationMessage.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    ]);
    delete process.env.CRM_AUTOMATIONS_ENABLED;
    delete process.env.AI_AGENT_ENABLED;
  });

  it('1. "Lead stopped replying" runs once after the quiet time, only for open leads that did not answer, and never for a text an automation sent', async () => {
    const auto = await automation({ trigger: { source: 'suprah_leads', event: 'lead_went_quiet', quietFor: { amount: 2, unit: 'hours' } }, steps: [message('Still interested, {first_name}?')] });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const lastText = ago(2 * HOUR - 30 * 1000);
    const quiet = await lead({ firstName: 'Quinn' });
    const answered = await lead({ firstName: 'Ana', followUp: { lastCustomerActivityAt: ago(HOUR) } });
    const sold = await lead({ firstName: 'Sol', status: 'Sold' });
    const own = await lead({ firstName: 'Otto' });
    const fresh = await lead({ firstName: 'Fresh' });
    await textThread(quiet, lastText);
    await textThread(answered, lastText);
    await textThread(sold, lastText);
    await textThread(own, lastText, { userId: 'system', name: 'Automation - Earlier' });
    await textThread(fresh, ago(30 * MINUTE));
    await CrmAutomationRun.collection.insertOne({ organizationId: org, automationId: new mongoose.Types.ObjectId(), automationName: 'Earlier', mode: 'live', event: 'lead_created', eventKey: `x:${own._id}`, triggerAt: lastText, contact: { leadId: String(own._id), name: 'Otto', firstName: 'Otto', phone: own.phone, email: '' }, status: 'completed', steps: [], log: [{ stepId: 's', type: 'send_message', status: 'sent', detail: 'hi', at: lastText }], createdAt: lastText, updatedAt: lastText } as any);

    expect(await sweepTriggers(later(MINUTE))).toBe(1);
    expect(await sweepTriggers(later(2 * MINUTE))).toBe(0);
    const runs = await only(auto._id);
    expect(runs.map((run) => run.contact.firstName)).toEqual(['Quinn']);
    expect(new Date(runs[0].triggerAt).getTime()).toBe(lastText.getTime() + 2 * HOUR);
    await runDueSteps(later(2 * MINUTE));
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms.mock.calls[0][1]).toBe('Still interested, Quinn? Reply STOP to opt out.');
  });

  it('2. the quiet time is saved from the builder, defaults to 24 hours, and is checked', async () => {
    const base = { name: 'Quiet', trigger: { source: 'suprah_leads', event: 'lead_went_quiet' }, steps: [message('Hi')] };
    const fallback = await createAutomation(org, actor, base);
    expect(fallback.trigger?.quietFor).toEqual({ amount: 24, unit: 'hours' });
    const days = await createAutomation(org, actor, { ...base, trigger: { ...base.trigger, quietFor: { amount: 3, unit: 'days' } } });
    expect(days.trigger?.quietFor).toEqual({ amount: 3, unit: 'days' });
    await expect(createAutomation(org, actor, { ...base, trigger: { ...base.trigger, quietFor: { amount: 31, unit: 'days' } } })).rejects.toThrow(/between 1 and 30 days/);
    await expect(createAutomation(org, actor, { ...base, trigger: { ...base.trigger, quietFor: { amount: 2, unit: 'weeks' } } })).rejects.toThrow(/hours or days/);
    const other = await createAutomation(org, actor, { ...base, trigger: { source: 'suprah', event: 'call_missed', quietFor: { amount: 5, unit: 'hours' } } });
    expect(other.trigger?.quietFor).toBeNull();
  });

  it('3. "Voicemail received" runs when a voicemail file is saved, with the caller and the location of the number that was called', async () => {
    const auto = await automation({ trigger: { source: 'suprah', event: 'voicemail_received' }, steps: [message('Thanks for the voicemail, {first_name}. We will call you back from {location_name}.')] });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const caller = await lead({ firstName: 'Val' });
    const callId = new mongoose.Types.ObjectId();
    const plainCallId = new mongoose.Types.ObjectId();
    await CallLog.collection.insertMany([
      { _id: callId, orgId: org, direction: 'inbound', from: caller.phone, to: '+18015550951', status: 'missed', leadId: caller._id, customerName: 'Val Diaz', createdAt: new Date(), updatedAt: new Date() },
      { _id: plainCallId, orgId: org, direction: 'inbound', from: caller.phone, to: '+18015550951', status: 'completed', leadId: caller._id, createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);
    await CallRecording.collection.insertMany([
      { organizationId: org, callLogId: callId, leadId: caller._id, kind: 'voicemail', state: 'ready', startedAt: ago(MINUTE), files: [{ key: 'vm.mp3', endedAt: new Date() }], createdAt: ago(MINUTE), updatedAt: later(1000) },
      { organizationId: org, callLogId: plainCallId, leadId: caller._id, kind: 'call', state: 'ready', startedAt: ago(MINUTE), files: [{ key: 'call.mp3', endedAt: new Date() }], createdAt: ago(MINUTE), updatedAt: later(1000) },
    ] as any[]);
    expect(await sweepTriggers(later(MINUTE))).toBe(1);
    const [run] = await only(auto._id);
    expect(run).toMatchObject({ event: 'voicemail_received', status: 'waiting' });
    expect(run.contact.phone).toBe(caller.phone);
    expect(run.location).toMatch(/Orem/);
    await runDueSteps(later(MINUTE));
    expect(mockSendSms.mock.calls[0][1]).toMatch(/^Thanks for the voicemail, Val\. We will call you back from .*Orem.*\. Reply STOP to opt out\.$/);
  });

  it('4. "Vehicle added" texts open, recent leads who want the same year, make and model, with the vehicle, price and link', async () => {
    const auto = await automation({ trigger: { source: 'inventory', event: 'vehicle_added' }, steps: [message('Good news {first_name}! A {vehicle} just came in at {vehicle_price}: {vehicle_link}')] });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    await lead({ firstName: 'Match', vehicle: { year: '2021', make: 'Honda', model: 'Civic' } });
    await lead({ firstName: 'Year', vehicle: { year: '2020', make: 'Honda', model: 'Civic' } });
    await lead({ firstName: 'Closed', status: 'Sold', vehicle: { year: '2021', make: 'Honda', model: 'Civic' } });
    await lead({ firstName: 'Old', createdAt: ago(200 * DAY), vehicle: { year: '2021', make: 'Honda', model: 'Civic' } });
    await Vehicle.collection.insertOne({ organizationId: org, vin: `VIN${Date.now()}A`, year: 2021, make: 'Honda', modelName: 'Civic', price: 21995, vdpUrl: 'https://example.com/civic', status: 'Ready for Sale', isDeleted: false, isArchived: false, createdAt: later(1000), updatedAt: later(1000) } as any);
    expect(await sweepTriggers(later(MINUTE))).toBe(1);
    const [run] = await only(auto._id);
    expect(run.contact.firstName).toBe('Match');
    expect(run.vehicle).toMatchObject({ label: '2021 Honda Civic', price: 21995, link: 'https://example.com/civic' });
    await runDueSteps(later(MINUTE));
    expect(mockSendSms.mock.calls[0][1]).toBe('Good news Match! A 2021 Honda Civic just came in at $21,995: https://example.com/civic Reply STOP to opt out.');
  });

  it('5. "Vehicle price dropped" runs for leads who asked about that exact vehicle, only for a real drop, with the new price', async () => {
    const auto = await automation({ trigger: { source: 'inventory', event: 'vehicle_price_dropped' }, steps: [message('{first_name}, the {vehicle} is now {vehicle_price}.')] });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const vin = `VIN${Date.now()}B`;
    await lead({ firstName: 'Exact', vehicle: { year: '2019', make: 'Toyota', model: 'RAV4', vin } });
    await lead({ firstName: 'Other', vehicle: { year: '2019', make: 'Toyota', model: 'RAV4', vin: 'SOMEOTHERVIN' } });
    await lead({ firstName: 'Close', vehicle: { year: '2019', make: 'Toyota', model: 'RAV4' } });
    const changedAt = later(1000);
    await Vehicle.collection.insertMany([
      { organizationId: org, vin, year: 2019, make: 'Toyota', modelName: 'RAV4', price: 23500, priceUpdatedAt: changedAt, priceHistory: [{ previousPrice: 25000, newPrice: 23500, changedAt }], status: 'Ready for Sale', isDeleted: false, isArchived: false, createdAt: ago(30 * DAY), updatedAt: changedAt },
      { organizationId: org, vin: `${vin}X`, year: 2019, make: 'Toyota', modelName: 'Camry', price: 19900, priceUpdatedAt: changedAt, priceHistory: [{ previousPrice: 20000, newPrice: 19900, changedAt }], status: 'Ready for Sale', isDeleted: false, isArchived: false, createdAt: ago(30 * DAY), updatedAt: changedAt },
    ] as any[]);
    expect(await sweepTriggers(later(MINUTE))).toBe(2);
    const runs = await only(auto._id);
    expect(runs.map((run) => run.contact.firstName).sort()).toEqual(['Close', 'Exact']);
    await runDueSteps(later(MINUTE));
    expect(mockSendSms.mock.calls.map((call) => call[1]).sort()).toEqual([
      'Close, the 2019 Toyota RAV4 is now $23,500. Reply STOP to opt out.',
      'Exact, the 2019 Toyota RAV4 is now $23,500. Reply STOP to opt out.',
    ]);
  });

  it('6. {vehicle_price} and {vehicle_link} are only allowed with the Inventory triggers', async () => {
    await expect(createAutomation(org, actor, { name: 'Bad', trigger: { source: 'suprah_leads', event: 'lead_created' }, steps: [message('Now {vehicle_price}')] })).rejects.toThrow(/only work with the Inventory triggers/);
    const ok = await createAutomation(org, actor, { name: 'Good', trigger: { source: 'inventory', event: 'vehicle_added' }, steps: [message('See it: {vehicle_link}')] });
    await expect(updateAutomation(org, actor, ok.id, { trigger: { source: 'suprah_leads', event: 'lead_created' } })).rejects.toThrow(/only work with the Inventory triggers/);
  });

  it('7. "On a Date" needs a future date and an audience, runs once for matching leads only, and "1 day before" goes out the day before', async () => {
    const date = toCompanyDateStr(later(3 * DAY));
    const steps = [message('Big sale tomorrow, {first_name}!', { when: 'before', amount: 1, unit: 'days' }), message('The sale is on today!')];
    const noAudience = await automation({ trigger: { source: 'on_a_date', event: null, date, time: '15:00' }, steps });
    await expect(setAutomationStatus(org, actor, String(noAudience._id), 'active')).rejects.toThrow(/at least one audience filter/);
    const past = await automation({ trigger: { source: 'on_a_date', event: null, date: toCompanyDateStr(ago(2 * DAY)), time: '15:00', filters: [{ field: 'lead_status', operator: 'is', value: 'Contacted' }] }, steps });
    await expect(setAutomationStatus(org, actor, String(past._id), 'active')).rejects.toThrow(/date already passed/);

    const auto = await automation({ trigger: { source: 'on_a_date', event: null, date, time: '15:00', filters: [{ field: 'lead_status', operator: 'is', value: 'Contacted' }] }, steps });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await lead({ firstName: 'Cora', status: 'Contacted' });
    await lead({ firstName: 'Cole', status: 'Contacted' });
    await lead({ firstName: 'Nina', status: 'New' });
    await lead({ firstName: 'Dina', status: 'Do Not Contact' });
    await lead({ firstName: 'Demo', status: 'Contacted', source: 'Demo' });
    const times = dateTriggerTimes((await CrmAutomation.findById(auto._id).lean() as any).trigger, steps) as { at: Date; fireAt: Date };
    expect(times.at.getTime() - times.fireAt.getTime()).toBe(DAY);

    expect(await sweepDateTriggers(new Date())).toBe(0);
    const fire = new Date(times.fireAt.getTime() + MINUTE);
    expect(await sweepDateTriggers(fire)).toBe(2);
    expect(await sweepDateTriggers(new Date(fire.getTime() + MINUTE))).toBe(0);
    const runs = await only(auto._id);
    expect(runs.map((run) => run.contact.firstName).sort()).toEqual(['Cole', 'Cora']);
    expect(runs.every((run) => run.status === 'waiting' && new Date(run.triggerAt).getTime() === times.at.getTime())).toBe(true);

    await runDueSteps(fire);
    expect(mockSendSms).toHaveBeenCalledTimes(2);
    expect(mockSendSms.mock.calls.map((call) => call[1]).sort()).toEqual(['Big sale tomorrow, Cole! Reply STOP to opt out.', 'Big sale tomorrow, Cora! Reply STOP to opt out.']);
    const waiting = await only(auto._id);
    expect(waiting.every((run) => run.status === 'waiting' && new Date(run.nextRunAt).getTime() === times.at.getTime())).toBe(true);
    await runDueSteps(new Date(times.at.getTime() + MINUTE));
    expect(mockSendSms).toHaveBeenCalledTimes(4);
    expect((await only(auto._id)).map((run) => run.status)).toEqual(['completed', 'completed']);
  });

  it('8. "Send AI Follow-up Message" writes with the AI agent, passes the safety check, and only texts when the AI agent is Live for texts', async () => {
    const auto = await automation({ steps: [{ id: 'ai', type: 'send_ai_follow_up', config: { instructions: 'Offer a test drive this week.', timing: { when: 'on' } } }] });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    const rosa = await lead({ firstName: 'Rosa', createdAt: later(1000) });
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0][0]).toMatchObject({ agentName: 'Maya', customerFirstName: 'Rosa', automated: true, staffInstructions: 'Offer a test drive this week.' });
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms.mock.calls[0][1]).toBe('Hi Rosa, just checking in. Want to pick a time to stop by this week?');
    const [run] = await only(auto._id);
    expect(run).toMatchObject({ status: 'completed', sentAnyMessage: true });
    expect(run.log[0]).toMatchObject({ type: 'send_ai_follow_up', status: 'sent' });
    const sent: any = await CommunicationMessage.findOne({ leadId: rosa._id, direction: 'outbound' }).lean();
    expect(sent.sentBy).toMatchObject({ userId: 'ai-agent', name: 'Maya' });
    const updated: any = await Lead.findById(rosa._id).lean();
    expect(updated.followUp.lastAutomatedOutreachAt).toBeTruthy();

    mockClassify.mockResolvedValueOnce('UNSAFE');
    await lead({ firstName: 'Una', createdAt: later(2 * MINUTE) });
    await sweepTriggers(later(3 * MINUTE));
    await runDueSteps(later(3 * MINUTE));
    await setSmsMode('training');
    await lead({ firstName: 'Tara', createdAt: later(4 * MINUTE) });
    await sweepTriggers(later(5 * MINUTE));
    await runDueSteps(later(5 * MINUTE));
    const byName = Object.fromEntries((await only(auto._id)).map((item) => [item.contact.firstName, item]));
    expect(byName.Una.log[0]).toMatchObject({ status: 'skipped' });
    expect(byName.Una.log[0].detail).toMatch(/safety check held the follow-up back/);
    expect(byName.Tara.log[0]).toMatchObject({ status: 'skipped', detail: 'The AI agent is not Live for texts, so it did not write a follow-up' });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockSendSms).toHaveBeenCalledTimes(1);

    await setSmsMode('live');
    await setAutomationStatus(org, actor, String(auto._id), 'test');
    await lead({ firstName: 'Tess', createdAt: later(6 * MINUTE) });
    await sweepTriggers(later(7 * MINUTE));
    await runDueSteps(later(7 * MINUTE));
    const test: any = (await only(auto._id)).find((item) => item.mode === 'test');
    expect(test.log[0].status).toBe('test');
    expect(test.log[0].detail).toMatch(/^Would have Maya write and text a follow-up to /);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('9. "Update Lead Status" changes the status with history, skips Do Not Contact, cannot set Do Not Contact, and does not start "Lead status changed" automations', async () => {
    await expect(createAutomation(org, actor, { name: 'DNC', trigger: { source: 'suprah_leads', event: 'lead_created' }, steps: [{ type: 'update_lead_status', config: { status: 'Do Not Contact' } }] })).rejects.toThrow(/cannot mark a lead Do Not Contact/);
    const update = await automation({ name: 'Set contacted', steps: [{ id: 'u', type: 'update_lead_status', config: { status: 'Contacted' } }] });
    const watcher = await automation({ name: 'Watcher', trigger: { source: 'suprah_leads', event: 'lead_status_changed', repeat: { mode: 'every_time', days: null, per: [] } }, steps: [{ id: 'n', type: 'send_notification', config: { recipients: 'admins', userIds: [], message: 'Status changed' } }] });
    await setAutomationStatus(org, actor, String(update._id), 'active');
    await setAutomationStatus(org, actor, String(watcher._id), 'active');
    await startCursor();
    const rosa = await lead({ firstName: 'Rosa', createdAt: later(1000) });
    const dina = await lead({ firstName: 'Dina', status: 'Do Not Contact', createdAt: later(1000) });
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    const changed: any = await Lead.findById(rosa._id).lean();
    expect(changed.status).toBe('Contacted');
    expect(changed.statusHistory[changed.statusHistory.length - 1]).toMatchObject({ from: 'New', to: 'Contacted', automationId: String(update._id), reason: 'Changed by the automation "Set contacted"' });
    const untouched: any = await Lead.findById(dina._id).lean();
    expect(untouched.status).toBe('Do Not Contact');
    const byName = Object.fromEntries((await only(update._id)).map((item) => [item.contact.firstName, item]));
    expect(byName.Rosa.log[0]).toMatchObject({ status: 'done', detail: 'Changed the status from New to Contacted' });
    expect(byName.Dina.log[0]).toMatchObject({ status: 'skipped', detail: 'The lead is marked Do Not Contact, so its status was not changed' });

    await sweepTriggers(later(2 * MINUTE));
    expect(await only(watcher._id)).toHaveLength(0);
    await Lead.collection.updateOne({ _id: rosa._id }, { $set: { status: 'Working', updatedAt: later(150 * 1000) }, $push: { statusHistory: { from: 'Contacted', to: 'Working', changedAt: later(150 * 1000) } } } as any);
    await sweepTriggers(later(3 * MINUTE));
    expect(await only(watcher._id)).toHaveLength(1);
  });

  it('10. Retry runs only the failed steps again, needs the automation on and the server switch, and stops after 3 tries', async () => {
    const auto = await automation({ steps: [message('Hello {first_name}'), { id: 'n', type: 'send_notification', config: { recipients: 'admins', userIds: [], message: 'New lead' } }] });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await startCursor();
    mockSendSms.mockRejectedValueOnce(new Error('Carrier rejected the message'));
    await lead({ firstName: 'Rhea', createdAt: later(1000) });
    await sweepTriggers(later(MINUTE));
    await runDueSteps(later(MINUTE));
    let [run] = await only(auto._id);
    expect(run).toMatchObject({ status: 'failed', reason: 'One or more steps failed' });
    expect(run.log.map((entry: any) => `${entry.type}:${entry.status}`)).toEqual(['send_message:failed', 'send_notification:sent']);
    const page = await listAutomationActivity(org, { mode: 'live' });
    expect(page.items[0]).toMatchObject({ id: String(run._id), retryable: true });

    delete process.env.CRM_AUTOMATIONS_ENABLED;
    await expect(retryRun(org, String(run._id), 'Part Two Admin')).rejects.toThrow(/turned off on this server/);
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    await expect(retryRun(String(new mongoose.Types.ObjectId()), String(run._id), 'Someone')).rejects.toThrow(/not found/);

    await expect(retryRun(org, String(run._id), 'Part Two Admin')).resolves.toMatchObject({ status: 'waiting', retrySteps: 1 });
    await runDueSteps(later(2 * MINUTE));
    [run] = await only(auto._id);
    expect(run.status).toBe('completed');
    expect(run.log.map((entry: any) => `${entry.type}:${entry.status}`)).toEqual(['send_message:failed', 'send_notification:sent', 'retry:done', 'send_message:sent']);
    expect(run.log[2].detail).toBe('Retry requested by Part Two Admin');
    expect(mockSendSms).toHaveBeenCalledTimes(2);
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    await expect(retryRun(org, String(run._id), 'Part Two Admin')).rejects.toThrow(/Only failed events/);

    const tiredLog: any[] = [1, 2, 3].map((n) => ({ stepId: 'retry', type: 'retry', status: 'done', detail: `try ${n}`, at: new Date() }));
    tiredLog.push({ stepId: 'x', type: 'send_message', status: 'failed', detail: 'no', at: new Date() });
    const tired: any = await CrmAutomationRun.create({ organizationId: org, automationId: auto._id, automationName: 'Part two test', mode: 'live', event: 'website_form_lead', eventKey: 'tired', triggerAt: new Date(), contact: { leadId: null, name: 'T', firstName: 'T', phone: '', email: '' }, steps: [{ id: 'x', type: 'send_message', config: {} }], stepIndex: 1, status: 'failed', log: tiredLog } as any);
    await expect(retryRun(org, String(tired._id), 'Part Two Admin')).rejects.toThrow(/already retried 3 times/);

    await setAutomationStatus(org, actor, String(auto._id), 'inactive');
    await CrmAutomationRun.updateOne({ _id: tired._id }, { $set: { log: [{ stepId: 'x', type: 'send_message', status: 'failed', detail: 'no', at: new Date() }] } });
    await expect(retryRun(org, String(tired._id), 'Part Two Admin')).rejects.toThrow(/Activate the automation before retrying/);
  });

  it('11. the trigger list no longer offers "Review received", and every Part 2 trigger and step is live', async () => {
    const { getAutomationOptions } = await import('../src/services/crmAutomation.service');
    const options = await getAutomationOptions(org);
    const events = options.sources.flatMap((source: any) => source.groups.flatMap((group: any) => group.events));
    expect(events.find((event: any) => event.key === 'review_received')).toBeUndefined();
    for (const key of ['lead_went_quiet', 'voicemail_received', 'vehicle_added', 'vehicle_price_dropped']) expect(events.find((event: any) => event.key === key)?.connected).toBe(true);
    for (const key of ['send_ai_follow_up', 'update_lead_status']) expect(options.actions.find((action: any) => action.key === key)?.connected).toBe(true);
    expect(options.actions.every((action: any) => action.connected)).toBe(true);
    expect(options.inventoryVariables).toEqual(['vehicle_price', 'vehicle_link']);
  });
});
