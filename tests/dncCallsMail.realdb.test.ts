const mockHangup = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return { ...actual, COMPANY_NUMBER: '+18015550900', hangupCall: (...args: unknown[]) => mockHangup(...args) };
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

import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import CrmUser from '../src/models/CrmUser.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import CallbackPermission from '../src/models/CallbackPermission.model';
import ContactRestrictionAudit from '../src/models/ContactRestrictionAudit.model';
import { CallLog, Conversation } from '../src/models/communication.model';
import { logClientCall, stopRestrictedBrowserCall } from '../src/services/communication.service';
import { CALLBACK_WINDOW_MS, grantCallbackPermission, OUTBOUND_CALL_MESSAGES } from '../src/services/callbackPermission.service';
import { assertMailRecipientsAllowed, mailRecipientAddresses } from '../src/services/contactRestriction.service';
import gmailService from '../src/services/gmail.service';

const MINUTE = 60 * 1000;
const orgId = new mongoose.Types.ObjectId();
const org = String(orgId);
const otherOrgId = new mongoose.Types.ObjectId();
const SIP = 'sip-connection-p44-test';
const LINE = '+18015550950';
const PHONE = {
  dnc: '+18015550701',
  dncOther: '+18015550702',
  open: '+18015550703',
  family: '+18015550704',
  backstop: '+18015550705',
  otherOrg: '+18015550706',
};
const staffId = new mongoose.Types.ObjectId();
const staff = { userId: String(staffId), name: 'Taylor Staff' };
const ids = {
  dnc: new mongoose.Types.ObjectId(),
  family: new mongoose.Types.ObjectId(),
  backstop: new mongoose.Types.ObjectId(),
  staffDnc: new mongoose.Types.ObjectId(),
  open: new mongoose.Types.ObjectId(),
  otherOrg: new mongoose.Types.ObjectId(),
};

function rawLead(_id: mongoose.Types.ObjectId, status: string, phone: string, extra: Record<string, unknown> = {}, organizationId = orgId) {
  const now = new Date();
  return {
    _id,
    organizationId,
    createdBy: staff,
    firstName: 'Pat',
    lastName: 'Lee',
    status,
    phone,
    normalizedPhone: phone,
    source: 'Manual Entry',
    channel: 'sms',
    statusHistory: status === 'Do Not Contact' ? [{ from: 'New', to: 'Do Not Contact', changedAt: new Date(Date.now() - 120 * MINUTE), changedBy: staff }] : [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

let clientCallSeq = 0;
const startCall = (toPhone: string, extra: Record<string, unknown> = {}) =>
  logClientCall({ orgId: org, user: staff as any, clientCallId: `p44-${++clientCallSeq}-${Date.now()}`, event: 'start', toPhone, ...extra });

async function inboundCall(from: string, startedAt = new Date()) {
  return CallLog.create({ orgId: org, direction: 'inbound', from, to: LINE, status: 'missed', startedAt });
}

const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64');

function browserCall(to: string, extra: Record<string, unknown> = {}) {
  return { connection_id: SIP, call_control_id: `v3:p44-${new mongoose.Types.ObjectId()}`, to, from: LINE, ...extra };
}

function fakeGmail(headers: Array<{ name: string; value: string }> = []) {
  return {
    users: {
      messages: {
        send: jest.fn().mockResolvedValue({ data: { id: 'sent-1' } }),
        get: jest.fn().mockResolvedValue({ data: { id: 'sent-1', threadId: 'thread-1', labelIds: ['SENT'], payload: { headers: [] } } }),
      },
      drafts: {
        get: jest.fn().mockResolvedValue({ data: { id: 'draft-1', message: { id: 'draft-message-1', payload: { headers } } } }),
        send: jest.fn().mockResolvedValue({ data: { id: 'sent-1' } }),
      },
    },
  };
}

async function cleanup() {
  await Promise.all([
    Lead.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    CrmUser.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    DealershipPhoneNumber.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    CallLog.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    Conversation.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    CallbackPermission.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    ContactRestrictionAudit.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
  ]);
}

describe('Real-DB Phase 44: Do Not Contact for calls and Suprah Mail (local MongoDB only)', () => {
  const previousSip = process.env.TELNYX_SIP_CONNECTION_ID;

  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    process.env.TELNYX_SIP_CONNECTION_ID = SIP;
    await cleanup();
    await CallbackPermission.init();
    await Lead.collection.insertMany([
      rawLead(ids.dnc, 'Do Not Contact', PHONE.dnc, { email: 'dnc@example.com', normalizedEmail: 'dnc@example.com' }),
      rawLead(ids.family, 'Do Not Contact', PHONE.family),
      rawLead(ids.backstop, 'Do Not Contact', PHONE.backstop),
      rawLead(ids.staffDnc, 'Do Not Contact', '+18015550799', { email: 'taylor@dealer.test', normalizedEmail: 'taylor@dealer.test' }),
      rawLead(ids.open, 'Contacted', PHONE.open, { email: 'open@example.com', normalizedEmail: 'open@example.com' }),
      rawLead(ids.otherOrg, 'Do Not Contact', PHONE.otherOrg, { email: 'other-org@example.com', normalizedEmail: 'other-org@example.com' }, otherOrgId),
    ] as any[]);
    await CrmUser.collection.insertOne({
      _id: staffId, organizationId: orgId, fullName: 'Taylor Staff', username: `taylor-${staffId}`, email: 'taylor@dealer.test',
      password: 'not-used', role: 'admin', isActive: true, googleMail: { connected: true, gmailAddress: 'taylor.sales@gmail.com' },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    await DealershipPhoneNumber.collection.insertOne({
      organizationId: orgId, number: LINE, label: 'Main line', kind: 'main', location: '', department: '',
      createdBy: staff, updatedBy: staff, createdAt: new Date(), updatedAt: new Date(),
    } as any);
  });

  beforeEach(() => {
    mockHangup.mockReset();
    mockHangup.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanup();
    if (previousSip === undefined) delete process.env.TELNYX_SIP_CONNECTION_ID;
    else process.env.TELNYX_SIP_CONNECTION_ID = previousSip;
  });

  describe('calls', () => {
    it('blocks a call to a Do Not Contact customer who has not called in, and records it', async () => {
      await expect(startCall(PHONE.dnc)).rejects.toMatchObject({ statusCode: 403, message: OUTBOUND_CALL_MESSAGES.restricted });
      expect(await CallLog.countDocuments({ orgId: org, direction: 'outbound', to: PHONE.dnc })).toBe(0);
      const audit: any = await ContactRestrictionAudit.findOne({ organizationId: orgId, event: 'outbound_blocked', channel: 'call' }).lean();
      expect(audit).toMatchObject({ purpose: 'manual_call', outcome: 'restricted' });
      expect(audit.restrictingLeadIds.map(String)).toContain(String(ids.dnc));
      const open = await startCall(PHONE.open);
      expect(open).toMatchObject({ status: 'ringing', to: PHONE.open });
      expect(open.callbackPermission).toBeUndefined();
    });

    it('lets staff call back twice within 24 hours after the customer calls, then blocks', async () => {
      const inbound = await inboundCall(PHONE.dnc);
      expect(await grantCallbackPermission(inbound)).toBe(true);
      const permission: any = await CallbackPermission.findOne({ organizationId: orgId, phone: PHONE.dnc }).lean();
      expect(permission).toMatchObject({ attemptsUsed: 0, maxAttempts: 2 });
      expect(String(permission.sourceCallLogId)).toBe(String(inbound._id));
      expect(new Date(permission.expiresAt).getTime() - new Date(inbound.startedAt!).getTime()).toBe(CALLBACK_WINDOW_MS);

      const first = await startCall(PHONE.dnc);
      expect(first.callbackPermission).toMatchObject({ attempt: 1, maxAttempts: 2 });
      const second = await startCall(PHONE.dnc, { leadId: String(ids.dnc) });
      expect(second.callbackPermission).toMatchObject({ attempt: 2, maxAttempts: 2 });
      await expect(startCall(PHONE.dnc)).rejects.toMatchObject({ statusCode: 403, message: OUTBOUND_CALL_MESSAGES.triesUsed });

      const used: any[] = await ContactRestrictionAudit.find({ organizationId: orgId, event: 'callback_permission_used' }).sort({ createdAt: 1 }).lean();
      expect(used).toHaveLength(2);
      expect(used.map((item) => String(item.callLogId))).toEqual([String(first._id), String(second._id)]);
      expect(await ContactRestrictionAudit.countDocuments({ organizationId: orgId, event: 'callback_permission_granted', callLogId: inbound._id })).toBe(1);
      const after: any = await CallbackPermission.findOne({ organizationId: orgId, phone: PHONE.dnc }).lean();
      expect(after.attempts.map((item: any) => item.userId)).toEqual([staff.userId, staff.userId]);
    });

    it('a new call from the customer gives 2 new tries; an older call event never replaces a newer one', async () => {
      const older = await inboundCall(PHONE.dnc, new Date(Date.now() - 30 * MINUTE));
      expect(await grantCallbackPermission(older)).toBe(false);
      await expect(startCall(PHONE.dnc)).rejects.toMatchObject({ statusCode: 403 });
      const newer = await inboundCall(PHONE.dnc);
      expect(await grantCallbackPermission(newer)).toBe(true);
      const call = await startCall(PHONE.dnc);
      expect(call.callbackPermission).toMatchObject({ attempt: 1 });
    });

    it('blocks after the 24 hours end, and only the number that called can be called back', async () => {
      await CallbackPermission.updateOne({ organizationId: orgId, phone: PHONE.dnc }, { $set: { expiresAt: new Date(Date.now() - MINUTE), attemptsUsed: 0 } });
      await expect(startCall(PHONE.dnc)).rejects.toMatchObject({ statusCode: 403, message: OUTBOUND_CALL_MESSAGES.windowEnded });

      expect(await grantCallbackPermission(await inboundCall(PHONE.family))).toBe(true);
      await expect(startCall(PHONE.dncOther, { leadId: String(ids.family) })).rejects.toMatchObject({ statusCode: 403, message: OUTBOUND_CALL_MESSAGES.restricted });
      expect((await startCall(PHONE.family)).callbackPermission).toMatchObject({ attempt: 1 });
    });

    it('does not create a callback for callers who are not Do Not Contact, or for another dealership', async () => {
      expect(await grantCallbackPermission(await inboundCall(PHONE.open))).toBe(false);
      expect(await grantCallbackPermission(await inboundCall(PHONE.otherOrg))).toBe(false);
      expect(await CallbackPermission.countDocuments({ phone: { $in: [PHONE.open, PHONE.otherOrg] } })).toBe(0);
      expect(await startCall(PHONE.otherOrg)).toMatchObject({ status: 'ringing' });
    });
  });

  describe('server check after dialing', () => {
    it('hangs up a browser call to a Do Not Contact number that skipped the first check', async () => {
      const payload = browserCall(PHONE.backstop);
      await stopRestrictedBrowserCall(payload);
      expect(mockHangup).toHaveBeenCalledWith(payload.call_control_id);
      expect(await ContactRestrictionAudit.countDocuments({ organizationId: orgId, event: 'outbound_blocked', purpose: 'call_check_after_dial' })).toBe(1);
    });

    it('marks the call log as stopped when the call has one', async () => {
      const call = await CallLog.create({ orgId: org, direction: 'outbound', from: LINE, to: PHONE.backstop, status: 'ringing', startedAt: new Date(), clientCallId: 'p44-tagged', placedBy: staff });
      await stopRestrictedBrowserCall(browserCall(PHONE.backstop, { client_state: encode({ kind: 'recording-outbound', callLogId: String(call._id), token: 'x' }) }));
      expect(mockHangup).toHaveBeenCalledTimes(1);
      expect(await CallLog.findById(call._id).lean()).toMatchObject({ status: 'failed', hangupCause: 'do-not-contact' });
    });

    it('an old call log cannot be reused to skip the check, and a callback that was already answered is not counted again', async () => {
      const old = await CallLog.create({ orgId: org, direction: 'outbound', from: LINE, to: PHONE.backstop, status: 'completed', startedAt: new Date(), clientCallId: 'p44-old', placedBy: staff, callbackPermission: { permissionId: 'x', attempt: 1, maxAttempts: 2, expiresAt: new Date(Date.now() + MINUTE) } });
      await stopRestrictedBrowserCall(browserCall(PHONE.backstop, { client_state: encode({ kind: 'recording-outbound', callLogId: String(old._id), token: 'x' }) }));
      expect(mockHangup).toHaveBeenCalledTimes(1);
      const answered = await CallLog.create({ orgId: org, direction: 'outbound', from: LINE, to: PHONE.backstop, status: 'in-progress', startedAt: new Date(), clientCallId: 'p44-answered', placedBy: staff, callbackPermission: { permissionId: 'x', attempt: 2, maxAttempts: 2, expiresAt: new Date(Date.now() + MINUTE) } });
      await stopRestrictedBrowserCall(browserCall(PHONE.backstop, { client_state: encode({ kind: 'recording-outbound', callLogId: String(answered._id), token: 'x' }) }));
      expect(mockHangup).toHaveBeenCalledTimes(1);
      await CallLog.deleteMany({ _id: { $in: [old._id, answered._id] } });
    });

    it('a made-up label in the call does not skip the check', async () => {
      await stopRestrictedBrowserCall(browserCall(PHONE.backstop, { client_state: encode({ kind: 'agent-leg', callLogId: 'nope' }) }));
      expect(mockHangup).toHaveBeenCalledTimes(1);
    });

    it('lets allowed calls ring: callbacks already counted, callers with a callback, and customers who are not Do Not Contact', async () => {
      expect(await grantCallbackPermission(await inboundCall(PHONE.backstop))).toBe(true);
      const counted = await startCall(PHONE.backstop);
      expect(counted.callbackPermission).toMatchObject({ attempt: 1 });
      await stopRestrictedBrowserCall(browserCall(PHONE.backstop, { client_state: encode({ kind: 'recording-outbound', callLogId: String(counted._id), token: 'x' }) }));
      expect((await CallbackPermission.findOne({ organizationId: orgId, phone: PHONE.backstop }).lean())?.attemptsUsed).toBe(1);

      await stopRestrictedBrowserCall(browserCall(PHONE.backstop));
      expect((await CallbackPermission.findOne({ organizationId: orgId, phone: PHONE.backstop }).lean())?.attemptsUsed).toBe(1);
      await CallLog.updateOne({ _id: counted._id }, { $set: { status: 'completed', endedAt: new Date() } });

      await stopRestrictedBrowserCall(browserCall(PHONE.backstop));
      expect((await CallbackPermission.findOne({ organizationId: orgId, phone: PHONE.backstop }).lean())?.attemptsUsed).toBe(2);

      await stopRestrictedBrowserCall(browserCall(PHONE.open));
      expect(mockHangup).not.toHaveBeenCalled();

      await stopRestrictedBrowserCall(browserCall(PHONE.backstop));
      expect(mockHangup).toHaveBeenCalledTimes(1);
    });

    it('ignores events from other connections, calls to a SIP address, and calls it cannot match to a dealership', async () => {
      await stopRestrictedBrowserCall({ ...browserCall(PHONE.dnc), connection_id: 'voice-app' });
      await stopRestrictedBrowserCall(browserCall('sip:gencred123@sip.telnyx.com'));
      await stopRestrictedBrowserCall(browserCall(PHONE.dnc, { from: '+18015559999' }));
      expect(mockHangup).not.toHaveBeenCalled();
    });
  });

  describe('Suprah Mail', () => {
    afterEach(() => jest.restoreAllMocks());

    it('reads every address from To, CC and BCC, with or without names', () => {
      expect(mailRecipientAddresses('"Lee, Pat" <DNC@example.com>, open@example.com', ['x <o\'brien@example.com>'], undefined))
        .toEqual(['dnc@example.com', 'open@example.com', "o'brien@example.com"]);
    });

    it('blocks an email when any To, CC or BCC address is Do Not Contact, and names the address', async () => {
      for (const field of ['to', 'cc', 'bcc']) {
        await expect(assertMailRecipientsAllowed({ userId: String(staffId), to: 'open@example.com', [field]: 'Pat Lee <dnc@example.com>' }))
          .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('dnc@example.com is marked Do Not Contact') });
      }
      const audit: any = await ContactRestrictionAudit.findOne({ organizationId: orgId, channel: 'email', purpose: 'suprah_mail' }).lean();
      expect(audit).toMatchObject({ event: 'outbound_blocked', outcome: 'restricted' });
      expect(audit.restrictingLeadIds.map(String)).toEqual([String(ids.dnc)]);
    });

    it('allows other customers, team members and other dealerships\' customers', async () => {
      await expect(assertMailRecipientsAllowed({ userId: String(staffId), to: 'open@example.com', cc: 'taylor@dealer.test, Taylor <TAYLOR.SALES@gmail.com>' })).resolves.toBeUndefined();
      await expect(assertMailRecipientsAllowed({ userId: String(staffId), to: 'other-org@example.com' })).resolves.toBeUndefined();
    });

    it('stops sendEmail and sendDraft before anything reaches Gmail', async () => {
      const blocked = fakeGmail();
      jest.spyOn(gmailService, 'getClientForUser').mockResolvedValue({ gmail: blocked as any, gmailAddress: 'taylor.sales@gmail.com' });
      await expect(gmailService.sendEmail(String(staffId), { fromEmail: 'taylor.sales@gmail.com', to: 'open@example.com', bcc: 'dnc@example.com', subject: 'Hi', text: 'Hello' }))
        .rejects.toMatchObject({ statusCode: 403 });
      expect(blocked.users.messages.send).not.toHaveBeenCalled();

      const draft = fakeGmail([{ name: 'To', value: 'open@example.com' }, { name: 'Bcc', value: '"Pat Lee" <dnc@example.com>' }]);
      jest.spyOn(gmailService, 'getClientForUser').mockResolvedValue({ gmail: draft as any, gmailAddress: 'taylor.sales@gmail.com' });
      await expect(gmailService.sendDraft(String(staffId), 'draft-1')).rejects.toMatchObject({ statusCode: 403 });
      expect(draft.users.drafts.send).not.toHaveBeenCalled();

      const fine = fakeGmail([{ name: 'To', value: 'open@example.com' }]);
      jest.spyOn(gmailService, 'getClientForUser').mockResolvedValue({ gmail: fine as any, gmailAddress: 'taylor.sales@gmail.com' });
      await gmailService.sendEmail(String(staffId), { fromEmail: 'taylor.sales@gmail.com', to: 'open@example.com', subject: 'Hi', text: 'Hello' });
      await gmailService.sendDraft(String(staffId), 'draft-1');
      expect(fine.users.messages.send).toHaveBeenCalledTimes(1);
      expect(fine.users.drafts.send).toHaveBeenCalledTimes(1);
    });
  });
});
