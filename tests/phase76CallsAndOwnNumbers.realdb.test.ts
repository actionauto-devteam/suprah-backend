const mockSendSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return {
    ...actual,
    COMPANY_NUMBER: '+18015550900',
    sendSms: (...args: unknown[]) => mockSendSms(...args),
    transferToAgent: jest.fn().mockResolvedValue({ data: { result: 'ok' } }),
    playMissedAndHangup: jest.fn().mockResolvedValue(undefined),
    hangupCall: jest.fn().mockResolvedValue({}),
    answerCall: jest.fn(),
    speak: jest.fn(),
    speakIvr: jest.fn(),
    gatherIvr: jest.fn(),
    recordingCommand: jest.fn(),
    recordingDisclosure: jest.fn(),
    findRecordings: jest.fn().mockResolvedValue([]),
    deleteProviderRecording: jest.fn(),
  };
});
jest.mock('../src/utils/socketEmitter', () => {
  const actual = jest.requireActual('../src/utils/socketEmitter');
  return {
    ...actual,
    getSocketIO: () => null,
    emitToOrg: jest.fn(),
    emitToUser: jest.fn(),
    emitToCrmUser: jest.fn(),
    streamLogToAdmins: jest.fn(),
  };
});
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import Notification from '../src/models/Notification.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import { CallLog, Conversation, CommunicationMessage } from '../src/models/communication.model';
import { submitLeadInquiry } from '../src/services/leadIntake.service';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { isDealershipNumber, listOtherSystemNumbers, saveOtherSystemNumbers } from '../src/services/dealershipOwnNumbers.service';
import { handleCallHangup, logClientCall } from '../src/services/communication.service';

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const COMPANY = '+18015550900';
const OREM_OTHER_SYSTEM = '+16182975360';
const MAIN_OTHER_SYSTEM = '+18017666137';
const ids = { owner: new mongoose.Types.ObjectId(), crmAdmin: new mongoose.Types.ObjectId() };
const admin = { userId: String(ids.crmAdmin), name: 'Ada Admin' };
const staff = { userId: String(ids.crmAdmin), name: 'Ada Admin' };
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };
let serial = 0;
const nextPhone = () => `+1801555${String(7600 + (++serial)).slice(-4)}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);
const textsTo = (phone: string) => mockSendSms.mock.calls.filter(([to]) => to === phone).length;

function smsInquiry(phone: string, body: string) {
  return {
    organizationId: ORG,
    kind: 'sms' as const,
    receivedAt: new Date(),
    channel: 'sms' as const,
    source: 'Inbound SMS',
    contact: { phone, assurance: 'carrier_verified' as const },
    comments: body,
    sourceIds: { communicationMessageId: new mongoose.Types.ObjectId() },
  };
}

function callInquiry(phone: string) {
  return {
    organizationId: ORG,
    kind: 'call' as const,
    receivedAt: new Date(),
    channel: 'phone' as const,
    source: 'Phone Call',
    contact: { phone, assurance: 'carrier_verified' as const },
    comments: 'Incoming call',
    sourceIds: { callControlId: `p76-inquiry-${++serial}` },
  };
}

async function card(phone: string, status: string) {
  return Lead.create({
    organizationId: orgId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone,
    source: 'Inbound SMS', channel: 'sms', status,
  });
}

async function missedCall(from: string) {
  const n = ++serial;
  const call = await CallLog.create({
    orgId, direction: 'inbound', from, to: COMPANY, status: 'ringing', startedAt: new Date(Date.now() - 20000),
    providerCallControlId: `p76-ctl-${n}`, providerCallSessionId: `p76-ses-${n}`,
  } as any);
  await handleCallHangup({ call_control_id: `p76-ctl-${n}`, call_session_id: `p76-ses-${n}`, hangup_cause: 'normal_clearing' });
  return CallLog.findById(call._id).lean();
}

describe('Real-DB: Phase 76 calls on the right card and dealership numbers (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.COMM_ORG_ID = ORG;
    process.env.SKIP_RATE_LIMIT = 'true';
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init(), CallLog.init(), Conversation.init(), DealershipPhoneNumber.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Phase 76 Motors', slug: `p76-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `p76-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: ids.owner, name: 'Olivia Owner', email: `p76-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await CrmUser.collection.insertOne({ _id: ids.crmAdmin, organizationId: orgId, fullName: 'Ada Admin', username: `p76-${ids.crmAdmin}`, email: `p76-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' } as any);
    await DealershipPhoneNumber.collection.insertOne({ organizationId: orgId, number: COMPANY, label: 'Main test', kind: 'main', createdBy: ids.owner, updatedBy: ids.owner } as any);
    await setLeadIntakeMode({ organizationId: ORG, mode: 'active', reason: 'Phase 76 test', actor: admin });
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async (to: string) => ({ id: `sim-${++serial}`, to: [{ phone_number: to }] }));
  });

  afterAll(async () => {
    process.env.COMM_ORG_ID = saved.org;
    process.env.SKIP_RATE_LIMIT = saved.skip;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('saves the other phone system numbers in one format and knows the Suprah lines too', async () => {
    const result = await saveOtherSystemNumbers(ORG, { numbers: ['(618) 297-5360', '16182975360', ' ', '801-766-6137'] });
    expect(result).toEqual([OREM_OTHER_SYSTEM, MAIN_OTHER_SYSTEM]);
    expect(await listOtherSystemNumbers(ORG)).toEqual([OREM_OTHER_SYSTEM, MAIN_OTHER_SYSTEM]);
    await expect(saveOtherSystemNumbers(ORG, { numbers: ['12345'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(saveOtherSystemNumbers(ORG, {})).rejects.toMatchObject({ statusCode: 400 });
    expect(await listOtherSystemNumbers(ORG)).toEqual([OREM_OTHER_SYSTEM, MAIN_OTHER_SYSTEM]);
    expect(await isDealershipNumber(ORG, '(618) 297-5360')).toBe(true);
    expect(await isDealershipNumber(ORG, COMPANY)).toBe(true);
    expect(await isDealershipNumber(ORG, nextPhone())).toBe(false);
    expect(await isDealershipNumber(String(otherOrgId), OREM_OTHER_SYSTEM)).toBe(false);
  });

  it('texts and calls from a dealership number go to Others, in one card per number, with no new-lead notice', async () => {
    const first = await submitLeadInquiry(smsInquiry(OREM_OTHER_SYSTEM, 'Sorry we missed your call, first'));
    if (first.status !== 'associated') throw new Error(`Expected a card, got ${first.status}`);
    expect(first.created).toBe(true);
    const created: any = await Lead.findById(first.leadId).lean();
    expect(created.status).toBe('Not a Lead');
    expect(created.statusHistory?.[0]?.reason).toBe('Dealership phone number');
    expect(created.followUp?.awaitingReplySince ?? null).toBeNull();

    const second = await submitLeadInquiry(smsInquiry(OREM_OTHER_SYSTEM, 'Sorry we missed your call, second'));
    const call = await submitLeadInquiry(callInquiry(OREM_OTHER_SYSTEM));
    expect(second).toMatchObject({ status: 'associated', created: false, leadId: first.leadId });
    expect(call).toMatchObject({ status: 'associated', created: false, leadId: first.leadId });
    expect(await Lead.countDocuments({ organizationId: orgId, phone: OREM_OTHER_SYSTEM })).toBe(1);
    expect(await Notification.countDocuments({ 'metadata.leadId': first.leadId })).toBe(0);
  });

  it('an open card for a dealership number still gets its texts', async () => {
    const open = await card(MAIN_OTHER_SYSTEM, 'Contacted');
    const result = await submitLeadInquiry(smsInquiry(MAIN_OTHER_SYSTEM, 'Test text from the other system'));
    expect(result).toMatchObject({ status: 'associated', created: false, leadId: String(open._id) });
    expect(await Lead.countDocuments({ organizationId: orgId, phone: MAIN_OTHER_SYSTEM })).toBe(1);
  });

  it('a customer text after a closed card still makes a new card', async () => {
    const phone = nextPhone();
    const closed = await card(phone, 'Closed');
    const result = await submitLeadInquiry(smsInquiry(phone, 'I want to buy again'));
    if (result.status !== 'associated') throw new Error(`Expected a card, got ${result.status}`);
    expect(result.created).toBe(true);
    expect(result.leadId).not.toBe(String(closed._id));
    expect(((await Lead.findById(result.leadId).lean()) as any).status).toBe('New');
  });

  it('a new card picks up calls and texts to that number from the last 30 minutes only', async () => {
    const phone = nextPhone();
    const closed = await card(phone, 'Not a Lead');
    const conversation = await Conversation.create({ orgId, customerPhone: phone } as any);
    const recent = new mongoose.Types.ObjectId();
    const old = new mongoose.Types.ObjectId();
    const owned = new mongoose.Types.ObjectId();
    const message = new mongoose.Types.ObjectId();
    await CallLog.collection.insertMany([
      { _id: recent, orgId, direction: 'outbound', from: COMPANY, to: phone, status: 'completed', leadId: null, conversationId: conversation._id, createdAt: minutesAgo(10), updatedAt: minutesAgo(10) },
      { _id: old, orgId, direction: 'outbound', from: COMPANY, to: phone, status: 'completed', leadId: null, conversationId: conversation._id, createdAt: minutesAgo(45), updatedAt: minutesAgo(45) },
      { _id: owned, orgId, direction: 'outbound', from: COMPANY, to: phone, status: 'completed', leadId: closed._id, conversationId: conversation._id, createdAt: minutesAgo(5), updatedAt: minutesAgo(5) },
    ] as any[]);
    await CommunicationMessage.collection.insertOne({ _id: message, orgId, conversationId: conversation._id, leadId: null, direction: 'outbound', body: 'Test text', from: COMPANY, to: phone, status: 'delivered', createdAt: minutesAgo(5), updatedAt: minutesAgo(5) } as any);

    const result = await submitLeadInquiry(smsInquiry(phone, 'Sorry we missed your call'));
    if (result.status !== 'associated') throw new Error(`Expected a card, got ${result.status}`);
    expect(result.created).toBe(true);
    const leadOf = async (model: any, id: unknown) => String(((await model.findById(id).lean()) as any)?.leadId ?? null);
    expect(await leadOf(CallLog, recent)).toBe(result.leadId);
    expect(await leadOf(CommunicationMessage, message)).toBe(result.leadId);
    expect(await leadOf(CallLog, old)).toBe('null');
    expect(await leadOf(CallLog, owned)).toBe(String(closed._id));
  });

  it('a dial pad call is saved only on an open card, while the card Call button keeps its card', async () => {
    const closedPhone = nextPhone();
    const closed = await card(closedPhone, 'Closed');
    const noCard: any = await logClientCall({ orgId: ORG, user: staff, clientCallId: `cc_p76_${++serial}`, event: 'start', toPhone: closedPhone });
    expect(noCard.leadId ?? null).toBeNull();

    const openPhone = nextPhone();
    const open = await card(openPhone, 'Contacted');
    const onOpen: any = await logClientCall({ orgId: ORG, user: staff, clientCallId: `cc_p76_${++serial}`, event: 'start', toPhone: openPhone });
    expect(String(onOpen.leadId)).toBe(String(open._id));

    const fromCard: any = await logClientCall({ orgId: ORG, user: staff, clientCallId: `cc_p76_${++serial}`, event: 'start', toPhone: closedPhone, leadId: closed._id });
    expect(String(fromCard.leadId)).toBe(String(closed._id));
  });

  it('a caller gets one missed-call text per hour, and dealership numbers get none', async () => {
    const caller = nextPhone();
    const first: any = await missedCall(caller);
    expect(first.status).toBe('missed');
    expect(textsTo(caller)).toBe(1);
    const second: any = await missedCall(caller);
    expect(second.status).toBe('missed');
    expect(textsTo(caller)).toBe(1);

    const otherCaller = nextPhone();
    await missedCall(otherCaller);
    expect(textsTo(otherCaller)).toBe(1);

    const returning = nextPhone();
    await CallLog.collection.insertOne({ orgId, direction: 'inbound', from: returning, to: COMPANY, status: 'missed', textBackSentAt: minutesAgo(120), createdAt: minutesAgo(121), updatedAt: minutesAgo(120) } as any);
    await missedCall(returning);
    expect(textsTo(returning)).toBe(1);

    const own: any = await missedCall(OREM_OTHER_SYSTEM);
    expect(own.status).toBe('missed');
    expect(textsTo(OREM_OTHER_SYSTEM)).toBe(0);
  });
});
