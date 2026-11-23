jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: jest.fn() }, messages: { get: jest.fn(), list: jest.fn(), send: jest.fn(), modify: jest.fn(), batchModify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), once: jest.fn(), credentials: {} })) },
    calendar: jest.fn(() => ({ events: {}, channels: {} })),
    oauth2: jest.fn(() => ({ userinfo: { get: jest.fn() } })),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));

import mongoose from 'mongoose';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import ComposerSendClaim from '../src/models/ComposerSendClaim.model';
import { emailReplySenders, recordLeadHandling } from '../src/services/leadHandling.service';
import { personNameOf } from '../src/services/leadConversation.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const mary = new mongoose.Types.ObjectId();
const beth = new mongoose.Types.ObjectId();
const base = new Date('2026-11-20T17:48:00Z').getTime();
const at = (seconds: number) => new Date(base + seconds * 1000);
let serial = 0;

const claim = (leadId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, gmailMessageId: string, when: Date) =>
  ComposerSendClaim.create({
    organizationId: orgId,
    leadId,
    channel: 'email',
    clientRequestId: `p75-${++serial}-abcdef`,
    requestHash: `hash-${serial}`,
    userId: String(userId),
    state: 'sent',
    result: { gmailMessageId, threadId: 'thread-1', subject: 'Re: Atlas' },
    expiresAt: new Date(when.getTime() + 7 * 24 * 60 * 60 * 1000),
  });

const sent = (leadId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, when: Date) =>
  recordLeadHandling({ organizationId: ORG, leadId, action: 'email_sent', channel: 'email', actor: { userId: String(userId) }, at: when });

describe('Real-DB: Phase 75 the rep name on email replies (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await User.collection.insertOne({ _id: mary, name: 'Mary Pinero', email: `mary-${orgId}@example.com`, password: 'x', role: 'employee', organizationId: orgId, isActive: true } as any);
    await CrmUser.collection.insertOne({ _id: beth, organizationId: orgId, fullName: 'Beth Reyes', username: `beth-${beth}`, email: `beth-${orgId}@example.com`, role: 'employee', isActive: true, permissions: [] } as any);
  });

  it('names the rep from the saved send of that exact email', async () => {
    const leadId = new mongoose.Types.ObjectId();
    await claim(leadId, mary, 'gmail-exact-1', at(0));
    const names = await emailReplySenders(ORG, leadId, [{ gmailId: 'gmail-exact-1', occurredAt: at(2).toISOString() }]);
    expect(names.get('gmail-exact-1')).toBe('Mary Pinero');
  });

  it('names a rep who signs in with a CRM account', async () => {
    const leadId = new mongoose.Types.ObjectId();
    await claim(leadId, beth, 'gmail-crm-1', at(0));
    const names = await emailReplySenders(ORG, leadId, [{ gmailId: 'gmail-crm-1', occurredAt: at(1).toISOString() }]);
    expect(names.get('gmail-crm-1')).toBe('Beth Reyes');
  });

  it('names an older email from the reply record sent at the same time', async () => {
    const leadId = new mongoose.Types.ObjectId();
    await sent(leadId, beth, at(4));
    const names = await emailReplySenders(ORG, leadId, [{ gmailId: 'gmail-old-1', occurredAt: at(0).toISOString() }]);
    expect(names.get('gmail-old-1')).toBe('Beth Reyes');
  });

  it('leaves an email with no reply record within 3 minutes unnamed', async () => {
    const leadId = new mongoose.Types.ObjectId();
    await sent(leadId, mary, at(-10 * 60));
    const names = await emailReplySenders(ORG, leadId, [{ gmailId: 'gmail-far-1', occurredAt: at(0).toISOString() }]);
    expect(names.has('gmail-far-1')).toBe(false);
  });

  it('gives the name to the email closest to the reply record, not to an AI email a minute before it', async () => {
    const leadId = new mongoose.Types.ObjectId();
    await sent(leadId, mary, at(62));
    const names = await emailReplySenders(ORG, leadId, [
      { gmailId: 'gmail-ai-1', occurredAt: at(0).toISOString() },
      { gmailId: 'gmail-rep-1', occurredAt: at(60).toISOString() },
    ]);
    expect(names.get('gmail-rep-1')).toBe('Mary Pinero');
    expect(names.has('gmail-ai-1')).toBe(false);
  });

  it('does not reuse the record of an email already named by its saved send', async () => {
    const leadId = new mongoose.Types.ObjectId();
    await claim(leadId, mary, 'gmail-claimed-1', at(0));
    await sent(leadId, mary, at(1));
    const names = await emailReplySenders(ORG, leadId, [
      { gmailId: 'gmail-claimed-1', occurredAt: at(0).toISOString() },
      { gmailId: 'gmail-direct-1', occurredAt: at(30).toISOString() },
    ]);
    expect(names.get('gmail-claimed-1')).toBe('Mary Pinero');
    expect(names.has('gmail-direct-1')).toBe(false);
  });

  it('matches two replies by two reps to the right emails', async () => {
    const leadId = new mongoose.Types.ObjectId();
    await sent(leadId, mary, at(1));
    await sent(leadId, beth, at(91));
    const names = await emailReplySenders(ORG, leadId, [
      { gmailId: 'gmail-two-1', occurredAt: at(0).toISOString() },
      { gmailId: 'gmail-two-2', occurredAt: at(90).toISOString() },
    ]);
    expect(names.get('gmail-two-1')).toBe('Mary Pinero');
    expect(names.get('gmail-two-2')).toBe('Beth Reyes');
  });

  it('never uses records from another lead or another dealership', async () => {
    const leadId = new mongoose.Types.ObjectId();
    const otherLead = new mongoose.Types.ObjectId();
    await sent(otherLead, mary, at(0));
    await recordLeadHandling({ organizationId: String(new mongoose.Types.ObjectId()), leadId, action: 'email_sent', channel: 'email', actor: { userId: String(mary) }, at: at(0) });
    const names = await emailReplySenders(ORG, leadId, [{ gmailId: 'gmail-iso-1', occurredAt: at(0).toISOString() }]);
    expect(names.size).toBe(0);
  });

  it('treats a plain address or an unreadable name in the email as no name', () => {
    expect(personNameOf('Mary Pinero')).toBe('Mary Pinero');
    expect(personNameOf('leads@actionautoutah.com')).toBe('');
    expect(personNameOf('=?UTF-8?B?Sm9zw6kgUGXDsWE=?=')).toBe('');
    expect(personNameOf('')).toBe('');
  });
});
