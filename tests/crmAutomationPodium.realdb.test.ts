const mockSendSms = jest.fn();

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

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import CrmAutomationCursor from '../src/models/CrmAutomationCursor.model';
import { CallLog } from '../src/models/communication.model';
import { getAutomationOptions, setAutomationStatus } from '../src/services/crmAutomation.service';
import { retryRun, runDueSteps, sweepReplies, sweepTriggers } from '../src/services/crmAutomationEngine.service';
import { automationForMissedCallText } from '../src/services/crmAutomationCalls.service';
import { importPodiumRows } from '../src/services/crmAutomationImport.service';
import { exportAutomationActivity, getActivitySummary, listAutomationActivity, listAutomationLogs } from '../src/services/crmAutomationMonitor.service';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const orgId = new mongoose.Types.ObjectId();
const org = String(orgId);
const otherOrg = String(new mongoose.Types.ObjectId());
const actor = { userId: String(new mongoose.Types.ObjectId()), name: 'Podium Test Admin' };
const later = (ms: number) => new Date(Date.now() + ms);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const HEADERS = ['Automation Type', 'Location Name', 'Channel Type', 'Created At', 'Customer Email', 'Customer Name', 'Customer Phone Number', 'Status', 'Status Description', 'Updated At', 'Data Feed Name', 'Automation Display Name'];

function row(values: Record<string, string>, n = 1, dropLast = true) {
  const filled: Record<string, string> = {
    'Automation Type': 'notification',
    'Location Name': 'Action Auto - Orem',
    'Channel Type': '',
    'Created At': ago(2 * 60 * MINUTE),
    'Customer Email': 'null',
    'Customer Name': 'null',
    'Customer Phone Number': '+18015550801',
    Status: 'Filtered',
    'Status Description': 'Filtered by Automation Configuration',
    'Updated At': ago(60 * MINUTE),
    'Data Feed Name': 'Auto text after call',
    ...values,
  };
  const cells = HEADERS.map((header) => filled[header] ?? '');
  return { cells: dropLast && !values['Automation Display Name'] ? cells.slice(0, 11) : cells, n };
}

const SENT = row({ 'Channel Type': 'phone', 'Customer Name': 'Ana Ruiz', Status: 'Message Sent', 'Status Description': 'Successfully Sent Message to Customer', 'Data Feed Name': 'Send a missed call follow-up' });
const FILTERED = row({});
const SCHEDULED = row({ 'Automation Type': 'Send AI Follow Up Message', 'Customer Phone Number': '+18015550802', Status: 'Scheduled', 'Status Description': 'Message Scheduled', 'Data Feed Name': '60 Day AI Lead Follow-up' });
const FAILED = row({ 'Channel Type': 'phone', 'Customer Phone Number': '+18015550803', Status: 'Failed', 'Status Description': 'Failed To Send Message', 'Data Feed Name': 'Send an abandoned call follow-up ' });
const PROCESSED = row({ 'Automation Type': 'writeback', 'Customer Email': 'lead@example.com', 'Customer Phone Number': '+18015550804', Status: 'Processed', 'Status Description': 'Processed Through Automation', 'Data Feed Name': 'Lead Received', 'Automation Display Name': 'Send a lead back to your CRM after it is received in Podium' });

async function cleanup() {
  await Promise.all([
    CrmAutomation.collection.deleteMany({ organizationId: { $in: [org, otherOrg] } }),
    CrmAutomationRun.collection.deleteMany({ organizationId: { $in: [org, otherOrg] } }),
    CrmAutomationCursor.collection.deleteMany({}),
    CallLog.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
  ]);
}

describe('Real-DB proof: Phase 41 Podium import and the abandoned call trigger (local dev MongoDB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    await Organization.collection.insertOne({ _id: orgId, name: 'Podium Import Motors', slug: `podium-import-${orgId}`, status: 'active', metadata: {} } as any);
  });

  beforeEach(async () => {
    mockSendSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await Organization.collection.deleteOne({ _id: orgId });
    delete process.env.CRM_AUTOMATIONS_ENABLED;
  });

  it('1. imports Podium rows as "From Podium" events with the same statuses Monitor uses, and keeps them out of the live view', async () => {
    const tooOld = row({ 'Created At': ago(200 * DAY), 'Updated At': ago(200 * DAY) });
    const oddStatus = row({ Status: 'Archived' });
    const badDate = row({ 'Created At': 'not a date' });
    const twin = { ...FILTERED, n: 2 };
    const result = await importPodiumRows(org, { headers: HEADERS, rows: [SENT, FILTERED, SCHEDULED, FAILED, PROCESSED, twin, tooOld, oddStatus, badDate] });
    expect(result).toEqual({ added: 6, updated: 0, unchanged: 0, skipped: 2, tooOld: 1 });

    const page = await listAutomationActivity(org, { mode: 'podium', range: 'last_7_days' });
    expect(page.mode).toBe('podium');
    expect(page.total).toBe(6);
    expect(page.items.every((item: any) => item.step === 'From Podium' && item.retryable === false && item.mode === 'podium')).toBe(true);
    const byName = (name: string) => page.items.filter((item: any) => item.automationName === name);
    expect(byName('Send a missed call follow-up')[0]).toMatchObject({ display: 'message_sent', channel: 'Text', reason: 'Successfully Sent Message to Customer', contact: { leadId: null, name: 'Ana Ruiz', firstName: 'Ana', phone: '+18015550801', email: '' } });
    expect(byName('60 Day AI Lead Follow-up')[0]).toMatchObject({ display: 'scheduled', reason: 'Message Scheduled', nextRunAt: null });
    expect(byName('Send an abandoned call follow-up')[0]).toMatchObject({ display: 'failed', retryable: false });
    expect(byName('Lead Received')[0]).toMatchObject({ display: 'processed', contact: { email: 'lead@example.com' } });
    expect(byName('Auto text after call').map((item: any) => item.display)).toEqual(['filtered', 'filtered']);

    expect((await listAutomationActivity(org, { mode: 'live', range: 'last_7_days' })).total).toBe(0);
    const summary = await getActivitySummary(org, { mode: 'podium', range: 'last_7_days' });
    expect(summary.counts).toEqual({ message_sent: 1, processed: 1, scheduled: 1, filtered: 2, failed: 1 });

    const logs = await listAutomationLogs(org, { mode: 'podium', range: 'last_7_days' });
    expect(logs.total).toBe(5);
    expect(logs.items.find((item: any) => item.automationName === 'Send a missed call follow-up')).toMatchObject({ step: 'Send a Message', status: 'sent', channel: 'Text', detail: 'Successfully Sent Message to Customer' });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const from = new Date(Date.now() - 7 * DAY).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const file = await exportAutomationActivity(org, { mode: 'podium', from, to: today });
    expect(file.filename).toMatch(/^automation-events-from-podium-/);
    expect(file.csv).toContain('From Podium');
    expect(file.csv).toContain('Ana Ruiz');
  });

  it('2. importing the same file again adds nothing, and a newer status updates the same event', async () => {
    expect(await importPodiumRows(org, { headers: HEADERS, rows: [SENT, SCHEDULED] })).toMatchObject({ added: 2, unchanged: 0 });
    expect(await importPodiumRows(org, { headers: HEADERS, rows: [SENT, SCHEDULED] })).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    const sentLater = { ...SCHEDULED, cells: SCHEDULED.cells.map((value, index) => (HEADERS[index] === 'Status' ? 'Message Sent' : HEADERS[index] === 'Status Description' ? 'Successfully Sent Message to Customer' : HEADERS[index] === 'Updated At' ? ago(5 * MINUTE) : value)) };
    expect(await importPodiumRows(org, { headers: HEADERS, rows: [SENT, sentLater] })).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    expect(await CrmAutomationRun.countDocuments({ organizationId: org, mode: 'podium' })).toBe(2);
    const page = await listAutomationActivity(org, { mode: 'podium', range: 'last_7_days' });
    expect(page.items.find((item: any) => item.automationName === '60 Day AI Lead Follow-up')).toMatchObject({ display: 'message_sent', channel: 'Text' });
  });

  it('3. a file without the Podium columns is refused, and each batch is limited', async () => {
    await expect(importPodiumRows(org, { headers: ['Name', 'Phone'], rows: [] })).rejects.toThrow('This file is missing the Automation Type, Created At, Status columns. Use the automations export from Podium.');
    await expect(importPodiumRows(org, { rows: [] })).rejects.toThrow('The file has no column names');
    await expect(importPodiumRows(org, { headers: HEADERS, rows: Array.from({ length: 501 }, (_, n) => ({ ...FILTERED, n: n + 1 })) })).rejects.toThrow('Send up to 500 rows at a time');
    expect(await importPodiumRows(org, { headers: HEADERS, rows: [{ cells: 'bad' }, { cells: FILTERED.cells, n: 0 }] })).toMatchObject({ added: 0, skipped: 2 });
  });

  it('4. imported events never run or send, cannot be retried, and stay inside their own organization', async () => {
    await importPodiumRows(org, { headers: HEADERS, rows: [SCHEDULED, FAILED] });
    const failed: any = await CrmAutomationRun.findOne({ organizationId: org, mode: 'podium', status: 'failed' }).lean();
    expect(await runDueSteps(later(DAY))).toBeGreaterThanOrEqual(0);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(await CrmAutomationRun.countDocuments({ organizationId: org, mode: 'podium', status: 'waiting', nextRunAt: null })).toBe(1);
    await expect(retryRun(org, String(failed._id), 'Podium Test Admin')).rejects.toThrow('Events imported from Podium are only a record and cannot be retried');
    expect((await listAutomationActivity(otherOrg, { mode: 'podium', range: 'last_7_days' })).total).toBe(0);
    await importPodiumRows(otherOrg, { headers: HEADERS, rows: [SCHEDULED] });
    expect(await CrmAutomationRun.countDocuments({ organizationId: org, mode: 'podium' })).toBe(2);
    expect(await CrmAutomationRun.countDocuments({ organizationId: otherOrg, mode: 'podium' })).toBe(1);
  });

  it('5. "Caller hung up before anyone answered" runs only for abandoned calls and replaces the standard missed-call text for them', async () => {
    const options = await getAutomationOptions(org);
    const calls = options.sources.find((source: any) => source.key === 'suprah')?.groups.find((group: any) => group.label === 'Calls');
    expect(calls?.events.find((event: any) => event.key === 'call_abandoned')).toMatchObject({ label: 'Caller hung up before anyone answered', connected: true });

    const auto = await CrmAutomation.create({
      organizationId: org,
      name: 'Abandoned call follow-up',
      locations: { mode: 'all', ids: [] },
      trigger: { source: 'suprah', event: 'call_abandoned', filters: [], repeat: { mode: 'every_time', days: null, per: [] }, sendingHours: 'any_time', stopOnReply: true, cancelFirstOnReply: true, aiContinuesOnReply: false, stopOnFailure: false },
      steps: [{ id: 'm1', type: 'send_message', config: { body: 'Hi {first_name}, sorry we missed you.', timing: { when: 'on', amount: null, unit: null }, assignTo: null } }],
      status: 'draft',
      createdBy: actor,
      updatedBy: actor,
    });
    await setAutomationStatus(org, actor, String(auto._id), 'active');
    await sweepTriggers(new Date());
    await sweepReplies(new Date());
    const endedAt = later(1000);
    await CallLog.collection.insertMany([
      { orgId: org, direction: 'inbound', from: '+18015550811', to: '+18015550900', status: 'missed', leadId: null, abandonedAt: endedAt, endedAt, createdAt: new Date(), updatedAt: new Date() },
      { orgId: org, direction: 'inbound', from: '+18015550812', to: '+18015550900', status: 'missed', leadId: null, abandonedAt: null, endedAt, createdAt: new Date(), updatedAt: new Date() },
      { orgId: org, direction: 'inbound', from: '+18015550813', to: '+18015550900', status: 'completed', leadId: null, abandonedAt: null, endedAt, createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);
    expect(await sweepTriggers(later(MINUTE))).toBe(1);
    const runs: any[] = await CrmAutomationRun.find({ automationId: auto._id }).lean();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ event: 'call_abandoned', mode: 'live', contact: { phone: '+18015550811' } });
    await runDueSteps(later(MINUTE));
    expect(mockSendSms.mock.calls.map((call) => call[0])).toEqual(['+18015550811']);

    expect(await automationForMissedCallText({ orgId: org, from: '+18015550821', to: '+18015550900', leadId: null, abandonedAt: new Date() })).toBe('Abandoned call follow-up');
    expect(await automationForMissedCallText({ orgId: org, from: '+18015550822', to: '+18015550900', leadId: null, abandonedAt: null })).toBeNull();
  });
});
