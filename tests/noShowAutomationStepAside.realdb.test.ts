const mockSendSms = jest.fn();
const mockNoShowText = jest.fn();

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
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/sendingWindow', () => ({
  ...jest.requireActual('../src/utils/sendingWindow'),
  isWithinSendingHours: () => true,
}));
jest.mock('../src/services/communication.service', () => ({
  ...jest.requireActual('../src/services/communication.service'),
  sendNoShowFollowUpText: (...args: unknown[]) => mockNoShowText(...args),
}));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import CrmAutomationCursor from '../src/models/CrmAutomationCursor.model';
import { setAutomationStatus } from '../src/services/crmAutomation.service';
import { sweepReplies, sweepTriggers } from '../src/services/crmAutomationEngine.service';
import { stepsSendText } from '../src/services/crmAutomationTexts.service';
import { runNoShowFollowUpSweep } from '../src/schedulers/appointmentNoShowFollowUp.scheduler';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const orgId = new mongoose.Types.ObjectId();
const org = String(orgId);
const admin = new mongoose.Types.ObjectId();
const actor = { userId: String(admin), name: 'No-show Admin' };
const later = (ms: number) => new Date(Date.now() + ms);
let phoneSeq = 700;
const nextPhone = () => `+1801555${String(phoneSeq++).padStart(4, '0')}`;
const textStep = { id: 'm', type: 'send_message', config: { body: 'Sorry we missed you, {first_name}. Want to pick a new time?', timing: { when: 'on' } } };

async function automation(name: string, steps: any[], filters: any[] = []) {
  return CrmAutomation.create({
    organizationId: org,
    name,
    locations: { mode: 'all', ids: [] },
    trigger: {
      source: 'suprah', event: 'appointment_no_show', filters, repeat: { mode: 'every_time' }, sendingHours: 'any_time',
      stopOnReply: true, cancelFirstOnReply: true, aiContinuesOnReply: false, stopOnFailure: false,
    },
    steps,
    status: 'draft',
    createdBy: actor,
    updatedBy: actor,
  });
}

async function noShowFor(source: string) {
  const phone = nextPhone();
  const leadId = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({
    _id: leadId, organizationId: orgId, firstName: 'Pat', lastName: source, phone, normalizedPhone: phone, email: `${phone.slice(-4)}@example.com`,
    channel: 'web', source, status: 'New', location: 'Orem', createdAt: new Date(), updatedAt: new Date(),
  } as any);
  const appointmentId = new mongoose.Types.ObjectId();
  await Appointment.collection.insertOne({
    _id: appointmentId, organizationId: org, title: 'Test drive', entryType: 'appointment', status: 'no-show', leadId,
    startTime: new Date(Date.now() - 2 * HOUR), endTime: new Date(Date.now() - HOUR), customerBooking: { firstName: 'Pat', phone },
    statusHistory: [{ from: 'scheduled', to: 'no-show', changedAt: new Date(Date.now() + 1000) }],
    createdAt: new Date(Date.now() - DAY), updatedAt: new Date(),
  } as any);
  return appointmentId;
}

async function readyForBuiltInSweep(ids: mongoose.Types.ObjectId[]) {
  await Appointment.collection.updateMany({ _id: { $in: ids } }, { $set: { updatedAt: new Date(Date.now() - 40 * MINUTE) } });
}

const textedIds = () => mockNoShowText.mock.calls.map((call) => String(call[0]._id));
const stored = (id: mongoose.Types.ObjectId) => Appointment.collection.findOne({ _id: id }) as Promise<any>;

describe('Real-DB proof: the built-in no-show text steps aside for a no-show automation (local MongoDB only)', () => {
  beforeAll(async () => {
    await Organization.collection.insertOne({ _id: orgId, name: 'No-show Motors', slug: `noshow-${orgId}`, status: 'active' } as any);
    await User.collection.insertOne({ _id: admin, organizationId: orgId, name: 'No-show Admin', email: `noshow-${admin}@example.com`, role: 'admin', isActive: true } as any);
  });

  beforeEach(async () => {
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    mockSendSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
    mockNoShowText.mockReset().mockResolvedValue(true);
    await Promise.all([
      CrmAutomation.collection.deleteMany({ organizationId: org }),
      CrmAutomationRun.collection.deleteMany({ organizationId: org }),
      CrmAutomationCursor.collection.deleteMany({}),
      Lead.collection.deleteMany({ organizationId: orgId }),
      Appointment.collection.deleteMany({ organizationId: org }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      Organization.collection.deleteOne({ _id: orgId }),
      User.collection.deleteMany({ organizationId: orgId }),
      CrmAutomation.collection.deleteMany({ organizationId: org }),
      CrmAutomationRun.collection.deleteMany({ organizationId: org }),
      CrmAutomationCursor.collection.deleteMany({}),
      Lead.collection.deleteMany({ organizationId: orgId }),
      Appointment.collection.deleteMany({ organizationId: org }),
    ]);
    delete process.env.CRM_AUTOMATIONS_ENABLED;
  });

  it('a no-show the automation will text gets only the automation text; a no-show the automation filters out still gets the built-in text', async () => {
    const auto = await automation('No-show follow-up', [textStep], [{ field: 'lead_source', operator: 'is', value: 'Website Inquiry' }]);
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await sweepTriggers(new Date());
    await sweepReplies(new Date());
    const covered = await noShowFor('Website Inquiry');
    const walkIn = await noShowFor('Walk-in');
    await sweepTriggers(later(MINUTE));
    const runs: any[] = await CrmAutomationRun.find({ organizationId: org }).lean();
    expect(runs.find((run) => run.appointmentId === String(covered))).toMatchObject({ status: 'waiting', mode: 'live' });
    expect(runs.find((run) => run.appointmentId === String(walkIn))).toMatchObject({ status: 'filtered' });

    await readyForBuiltInSweep([covered, walkIn]);
    const stats = await runNoShowFollowUpSweep();
    expect(stats).toMatchObject({ scanned: 2, sent: 1, skipped: 1 });
    expect(textedIds()).toEqual([String(walkIn)]);
    expect(await stored(covered)).toMatchObject({ noShowFollowUpStatus: 'skipped', noShowFollowUpFailureReason: 'The "No-show follow-up" automation texts this customer instead' });
    expect((await stored(covered)).noShowFollowUpSentAt).toBeFalsy();
    expect(await stored(walkIn)).toMatchObject({ noShowFollowUpStatus: 'sent' });
    expect(await runNoShowFollowUpSweep()).toMatchObject({ scanned: 0 });
  });

  it('Test Mode, an automation with no text step, or automations turned off on the server never silence the built-in text', async () => {
    const testMode = await automation('Trying it out', [textStep]);
    const taskOnly = await automation('Call them back', [{ id: 't', type: 'create_task', config: { recipients: 'admins', task: 'Call this customer back', timing: { when: 'on' } } }]);
    await setAutomationStatus(org, actor, String(testMode._id), 'test');
    await setAutomationStatus(org, actor, String(taskOnly._id), 'active');
    await sweepTriggers(new Date());
    await sweepReplies(new Date());
    const first = await noShowFor('Website Inquiry');
    await sweepTriggers(later(MINUTE));
    const runs: any[] = await CrmAutomationRun.find({ organizationId: org, appointmentId: String(first) }).lean();
    expect(runs.map((run) => `${run.automationName}:${run.mode}`).sort()).toEqual(['Call them back:live', 'Trying it out:test']);
    await readyForBuiltInSweep([first]);
    expect(await runNoShowFollowUpSweep()).toMatchObject({ sent: 1, skipped: 0 });
    expect(textedIds()).toEqual([String(first)]);

    const second = await noShowFor('Website Inquiry');
    await CrmAutomationRun.collection.insertOne({
      organizationId: org, automationId: new mongoose.Types.ObjectId(), automationName: 'Old live run', mode: 'live', event: 'appointment_no_show',
      eventKey: `no-show:${second}:1`, triggerAt: new Date(), appointmentId: String(second), contact: { name: 'Pat' }, steps: [textStep], status: 'completed',
      settings: {}, log: [], createdAt: new Date(), updatedAt: new Date(),
    } as any);
    delete process.env.CRM_AUTOMATIONS_ENABLED;
    await readyForBuiltInSweep([second]);
    expect(await runNoShowFollowUpSweep()).toMatchObject({ sent: 1 });
    expect(textedIds()).toEqual([String(first), String(second)]);
  });

  it('a text step inside a Branch path or the Else path counts as the automation texting', () => {
    const branch = (paths: any[], elseSteps: any[]) => [{ id: 'b', type: 'branch', config: { paths, else: { doNothing: !elseSteps.length, steps: elseSteps } } }];
    expect(stepsSendText(branch([{ id: 'p', steps: [textStep] }], []))).toBe(true);
    expect(stepsSendText(branch([{ id: 'p', steps: [{ id: 'n', type: 'send_notification', config: {} }] }], [textStep]))).toBe(true);
    expect(stepsSendText(branch([{ id: 'p', steps: [{ id: 'w', type: 'wait', config: {} }] }], []))).toBe(false);
    expect(stepsSendText([{ id: 'r', type: 'send_review_invitation', config: {} }])).toBe(true);
    expect(stepsSendText([{ id: 'e', type: 'send_email', config: {} }])).toBe(false);
  });
});
