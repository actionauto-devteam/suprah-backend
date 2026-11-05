import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import CrmUser from '../src/models/CrmUser.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import VehicleReengagementLog from '../src/models/VehicleReengagementLog.model';
import Appointment from '../src/models/Appointment.model';
import { CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import crmAutomationRoute from '../src/routes/crmAutomation.routes';
import { customBounds, getActivitySummary, getReengagementSummary, listAutomationActivity, listAutomationLogs, rangeBounds } from '../src/services/crmAutomationMonitor.service';
import { COMPANY_TZ, addDaysToDateStr, toCompanyDateStr, zoneMidnightUtc } from '../src/utils/companyTimezone';

const app = express();
app.use(express.json());
app.use('/api/crm/automations', crmAutomationRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const org = new mongoose.Types.ObjectId();
const otherOrg = new mongoose.Types.ObjectId();
const orgKey = String(org);
const users = { employee: new mongoose.Types.ObjectId(), manager: new mongoose.Types.ObjectId(), admin: new mongoose.Types.ObjectId() };
const tokens: Record<string, string> = {};
const as = (who: keyof typeof users) => ({ Authorization: `Bearer ${tokens[who]}` });
const base = '/api/crm/automations';
const sales = new mongoose.Types.ObjectId();
const service = new mongoose.Types.ObjectId();
const HOUR = 60 * 60 * 1000;
const today = toCompanyDateStr(new Date());
const at = (day: string, hours: number) => new Date(zoneMidnightUtc(day, COMPANY_TZ).getTime() + hours * HOUR);
const contact = (name: string, phone: string, email: string) => ({ leadId: null, name, firstName: name.split(' ')[0], phone, email });
const seeds: any[] = [];

function run(id: string, fields: Record<string, any>) {
  const createdAt: Date = fields.createdAt;
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgKey,
    automationId: sales,
    automationName: 'Sales follow-up',
    mode: 'live',
    event: 'lead_created',
    eventKey: `monitor-${id}`,
    triggerAt: createdAt,
    contact: contact('Pat Lee', '+18015550199', 'pat@example.com'),
    status: 'completed',
    sentAnyMessage: false,
    steps: [],
    stepIndex: 0,
    log: [],
    reason: null,
    updatedAt: createdAt,
    ...fields,
  };
  seeds.push({ id, ...doc });
  return doc;
}

describe('Real-DB proof: automation Monitor (local dev MongoDB only)', () => {
  beforeAll(async () => {
    const member = (id: any, role: string) => ({ _id: id, organizationId: org, fullName: `Monitor ${role}`, username: `monitor-${id}`, email: `monitor-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([member(users.employee, 'employee'), member(users.manager, 'manager'), member(users.admin, 'admin')] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    const automation = (id: any, name: string, tags: string[]) => ({ _id: id, organizationId: orgKey, name, tags, status: 'active', locations: { mode: 'all', ids: [] }, trigger: null, steps: [], createdAt: new Date(), updatedAt: new Date() });
    await CrmAutomation.collection.insertMany([automation(sales, 'Sales follow-up', ['Sales']), automation(service, 'Service reminder', [])] as any[]);
    const yesterday = addDaysToDateStr(today, -1);
    await CrmAutomationRun.collection.insertMany([
      run('sent', { createdAt: at(today, 10), sentAnyMessage: true, contact: contact('Rosa Diaz', '+18015550101', 'rosa@example.com'), log: [{ stepId: 'm', type: 'send_message', status: 'sent', detail: 'Texted Rosa', at: at(today, 10.1) }] }),
      run('processed', { createdAt: at(today, 11), contact: contact('Ned Park', '+18015550102', 'ned@example.com'), log: [{ stepId: 'n', type: 'send_notification', status: 'sent', detail: 'Notified admins', at: at(today, 11.1) }] }),
      run('scheduled', { createdAt: at(today, 12), automationId: service, automationName: 'Service reminder', status: 'waiting', sentAnyMessage: true, stepIndex: 1, steps: [{ id: 'a', type: 'send_message', config: {} }, { id: 'b', type: 'send_email', config: {} }], nextRunAt: at(today, 20), contact: contact('Sam Cole', '+18015550103', 'sam@example.com'), log: [{ stepId: 'a', type: 'send_message', status: 'sent', detail: 'Texted Sam', at: at(today, 12.1) }] }),
      run('filtered', { createdAt: at(today, 0.5), automationId: service, automationName: 'Service reminder', status: 'filtered', reason: 'Did not match the audience', contact: contact('Fay Wu', '+18015550104', 'fay@example.com') }),
      run('failed', { createdAt: at(yesterday, 23.5), status: 'failed', reason: 'Text could not be sent', contact: contact('Gus Hale', '+18015550105', 'gus@example.com'), log: [{ stepId: 'e', type: 'send_email', status: 'failed', detail: 'No email address', at: at(yesterday, 23.6) }] }),
      run('stopped', { createdAt: at(addDaysToDateStr(today, -3), 9), status: 'stopped', sentAnyMessage: true, reason: 'The contact replied', contact: contact('Ivy Ross', '+18015550106', 'ivy@example.com') }),
      run('formula', { createdAt: at(today, 13), automationId: service, automationName: 'Service reminder', contact: contact('=HYPERLINK("http://x")', '+18015550107', 'f@example.com') }),
      run('old', { createdAt: at(addDaysToDateStr(today, -40), 9), sentAnyMessage: true }),
      run('test', { createdAt: at(today, 9), mode: 'test', sentAnyMessage: true, contact: contact('Tess Test', '+18015550108', 'tess@example.com'), log: [{ stepId: 'm', type: 'send_message', status: 'test', detail: 'Would text Tess', at: at(today, 9.1) }] }),
      run('other-org', { createdAt: at(today, 9), organizationId: String(otherOrg), sentAnyMessage: true }),
    ] as any[]);
  });

  afterAll(async () => {
    await CrmUser.collection.deleteMany({ organizationId: org });
    await CrmAutomation.collection.deleteMany({ organizationId: orgKey });
    await CrmAutomationRun.collection.deleteMany({ organizationId: { $in: [orgKey, String(otherOrg)] } });
    await VehicleReengagementLog.collection.deleteMany({ organizationId: orgKey });
    await CommunicationMessage.collection.deleteMany({ orgId: orgKey });
    await Appointment.collection.deleteMany({ organizationId: orgKey });
  });

  it('1. date ranges follow Mountain Time, including the daylight saving change and last month', () => {
    const dst = rangeBounds('today', new Date('2026-03-08T12:00:00Z'));
    expect([dst.from, dst.to, dst.start.toISOString(), dst.end.toISOString()]).toEqual(['2026-03-08', '2026-03-08', '2026-03-08T07:00:00.000Z', '2026-03-09T06:00:00.000Z']);
    const lastMonth = rangeBounds('last_month', new Date('2026-03-15T18:00:00Z'));
    expect([lastMonth.from, lastMonth.to, lastMonth.start.toISOString(), lastMonth.end.toISOString()]).toEqual(['2026-02-01', '2026-02-28', '2026-02-01T07:00:00.000Z', '2026-03-01T07:00:00.000Z']);
    const month = rangeBounds('month_to_date', new Date('2026-11-03T13:00:00Z'));
    expect([month.from, month.to]).toEqual(['2026-11-01', '2026-11-03']);
    const late = rangeBounds('today', new Date('2026-11-04T05:30:00Z'));
    expect(late.from).toBe('2026-11-03');
    expect(rangeBounds('last_7_days', new Date('2026-11-03T13:00:00Z')).from).toBe('2026-10-28');
  });

  it('2. the chart counts each day by Message Sent, Processed, Scheduled, Filtered and Failed, with Day to Date and Month to Date', async () => {
    const summary = await getActivitySummary(orgKey, { range: 'last_7_days' });
    expect(summary.buckets).toHaveLength(7);
    expect(summary.buckets[6]).toMatchObject({ from: today, to: today, total: 5, counts: { message_sent: 1, processed: 2, scheduled: 1, filtered: 1, failed: 0 } });
    expect(summary.buckets[5]).toMatchObject({ from: addDaysToDateStr(today, -1), total: 1, counts: { failed: 1 } });
    expect(summary.buckets[3].counts.message_sent).toBe(1);
    expect(summary.counts).toEqual({ message_sent: 2, processed: 2, scheduled: 1, filtered: 1, failed: 1 });
    expect(summary.total).toBe(7);
    expect(summary.dayToDate).toBe(5);
    const monthStart = `${today.slice(0, 8)}01`;
    const expectedMonth = seeds.filter((seed) => seed.organizationId === orgKey && seed.mode === 'live' && toCompanyDateStr(seed.createdAt) >= monthStart && toCompanyDateStr(seed.createdAt) <= today).length;
    expect(summary.monthToDate).toBe(expectedMonth);
    const weeks = await getActivitySummary(orgKey, { range: 'last_7_days', group: 'week' });
    expect(weeks.buckets.length).toBeGreaterThanOrEqual(1);
    expect(weeks.buckets.length).toBeLessThanOrEqual(2);
    expect(weeks.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(7);
    expect(weeks.buckets[0].from).toBe(addDaysToDateStr(today, -6));
    expect(weeks.buckets[weeks.buckets.length - 1].to).toBe(today);
    const months = await getActivitySummary(orgKey, { range: 'last_30_days', group: 'month' });
    expect(months.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(7);
    expect(months.buckets.every((bucket) => bucket.from.slice(0, 7) === bucket.to.slice(0, 7))).toBe(true);
    const test = await getActivitySummary(orgKey, { range: 'today', mode: 'test' });
    expect(test.counts.message_sent).toBe(1);
    expect(test.total).toBe(1);
  });

  it('3. Events list each run with the Podium status, the action, the channel and the reason, and filter by status, tag, automation and search', async () => {
    const all = await listAutomationActivity(orgKey, { range: 'last_7_days' });
    expect(all.total).toBe(7);
    const byName = Object.fromEntries(all.items.map((item) => [item.contact.name, item]));
    expect(byName['Rosa Diaz']).toMatchObject({ display: 'message_sent', step: 'Send a Message', channel: 'Text' });
    expect(byName['Ned Park']).toMatchObject({ display: 'processed', step: 'Send Notification', channel: '' });
    expect(byName['Sam Cole']).toMatchObject({ display: 'scheduled', step: 'Send an Email', channel: 'Text' });
    expect(byName['Fay Wu']).toMatchObject({ display: 'filtered', reason: 'Did not match the audience' });
    expect(byName['Gus Hale']).toMatchObject({ display: 'failed', channel: '' });
    expect(byName['Ivy Ross']).toMatchObject({ display: 'message_sent' });
    const processed = await listAutomationActivity(orgKey, { range: 'last_7_days', status: 'processed' });
    expect(processed.items.map((item) => item.contact.firstName).sort()).toEqual(['=HYPERLINK("http://x")', 'Ned'].sort());
    const tagged = await listAutomationActivity(orgKey, { range: 'last_7_days', tag: 'Sales' });
    expect(tagged.items.map((item) => item.contact.name).sort()).toEqual(['Gus Hale', 'Ivy Ross', 'Ned Park', 'Rosa Diaz']);
    expect((await listAutomationActivity(orgKey, { range: 'last_7_days', tag: 'Sales', automationId: String(service) })).total).toBe(0);
    expect((await listAutomationActivity(orgKey, { range: 'last_7_days', automationId: String(service) })).total).toBe(3);
    expect((await listAutomationActivity(orgKey, { range: 'last_7_days', name: 'SALES' })).total).toBe(4);
    for (const q of ['rosa', '801-555-0101', 'ROSA@EXAMPLE']) {
      const found = await listAutomationActivity(orgKey, { range: 'last_7_days', q });
      expect(found.items.map((item) => item.contact.name)).toEqual(['Rosa Diaz']);
    }
    expect((await listAutomationActivity(orgKey, { range: 'last_7_days', q: '.*' })).total).toBe(0);
    expect((await listAutomationActivity(orgKey, { range: 'today' })).total).toBe(5);
    expect((await listAutomationActivity(orgKey, { range: 'today', mode: 'test' })).items.map((item) => item.contact.name)).toEqual(['Tess Test']);
  });

  it('4. Logs list every step taken in the range, newest first, and follow the same filters', async () => {
    const logs = await listAutomationLogs(orgKey, { range: 'today' });
    expect(logs.items.map((item) => `${item.contact.firstName}:${item.step}:${item.status}`)).toEqual(['Sam:Send a Message:sent', 'Ned:Send Notification:sent', 'Rosa:Send a Message:sent']);
    expect(logs.items[0]).toMatchObject({ channel: 'Text', detail: 'Texted Sam' });
    const week = await listAutomationLogs(orgKey, { range: 'last_7_days' });
    expect(week.total).toBe(4);
    expect(week.items[3]).toMatchObject({ step: 'Send an Email', status: 'failed', channel: '' });
    expect((await listAutomationLogs(orgKey, { range: 'last_7_days', status: 'scheduled' })).items.map((item) => item.contact.firstName)).toEqual(['Sam']);
    expect((await listAutomationLogs(orgKey, { range: 'today', mode: 'test' })).items.map((item) => item.status)).toEqual(['test']);
    expect((await listAutomationLogs(orgKey, { range: 'today', name: 'service' })).items.map((item) => item.contact.firstName)).toEqual(['Sam']);
    expect((await listAutomationLogs(orgKey, { range: 'today', name: 'nothing like this' })).total).toBe(0);
  });

  it('5. the endpoints check roles and inputs, and Export as CSV downloads a safe file for Events and Logs', async () => {
    expect((await request(app).get(`${base}/activity/summary`).set(as('employee'))).status).toBe(403);
    const summary = await request(app).get(`${base}/activity/summary?range=last_7_days&group=day`).set(as('manager'));
    expect(summary.status).toBe(200);
    expect(summary.body.data.total).toBe(7);
    const bad = await request(app).get(`${base}/activity?status=completed`).set(as('manager'));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('That status is not valid');
    const events = await request(app).get(`${base}/activity/export?range=last_7_days`).set(as('admin'));
    expect(events.status).toBe(200);
    expect(events.headers['content-type']).toMatch(/text\/csv/);
    expect(events.headers['content-disposition']).toBe(`attachment; filename="automation-events-${addDaysToDateStr(today, -6)}-to-${today}.csv"`);
    const lines = events.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Contact,Phone,Email,Automation,Action,Status,Reason,Channel,Created At (Mountain)');
    expect(lines).toHaveLength(8);
    expect(lines.find((line) => line.includes('HYPERLINK'))).toMatch(/^"'=HYPERLINK\(""http:\/\/x""\)",\+18015550107,/);
    expect(lines.find((line) => line.startsWith('Rosa Diaz'))).toMatch(/Sales follow-up,Send a Message,Message Sent,,Text,/);
    const logs = await request(app).get(`${base}/activity/export?range=today&view=logs&mode=test`).set(as('manager'));
    const logLines = logs.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(logs.headers['content-disposition']).toContain('automation-logs-test-mode-');
    expect(logLines[0]).toBe('Contact,Phone,Email,Automation,Step,Result,Channel,Detail,Time (Mountain)');
    expect(logLines[1]).toMatch(/^Tess Test,\+18015550108,tess@example.com,Sales follow-up,Send a Message,Test only,Text,Would text Tess,/);
  });

  it('6. the re-engagement chart counts texts sent each day and who replied or booked within 7 days', async () => {
    const [l1, l2, l3, l4, l5] = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
    const twoAgo = addDaysToDateStr(today, -2);
    const tenAgo = addDaysToDateStr(today, -10);
    const log = (leadId: any, status: string, sentAt: Date) => ({ organizationId: orgKey, vehicleId: new mongoose.Types.ObjectId(), leadId, vehicleLabel: '2024 Toyota Camry', leadName: 'Re Lead', leadPhone: '+18015550500', status, sentAt: status === 'sent' ? sentAt : undefined, createdAt: sentAt, updatedAt: sentAt });
    await VehicleReengagementLog.collection.insertMany([
      log(l1, 'sent', at(twoAgo, 10)),
      log(l2, 'sent', at(twoAgo, 11)),
      log(l3, 'sent', at(tenAgo, 10)),
      log(l4, 'failed', at(twoAgo, 12)),
      log(l5, 'sent', at(addDaysToDateStr(today, -40), 10)),
    ] as any[]);
    const message = (leadId: any, direction: string, createdAt: Date) => ({ orgId: orgKey, conversationId: new mongoose.Types.ObjectId(), leadId, direction, body: 'Yes', channel: 'sms', createdAt, updatedAt: createdAt });
    await CommunicationMessage.collection.insertMany([
      message(l1, 'inbound', at(twoAgo, 13)),
      message(l2, 'outbound', at(twoAgo, 12)),
      message(l3, 'inbound', at(addDaysToDateStr(today, -1), 9)),
      message(l4, 'inbound', at(twoAgo, 13)),
    ] as any[]);
    await Appointment.collection.insertMany([{ organizationId: orgKey, leadId: l1, title: 'Test drive', startTime: at(today, 15), createdAt: at(addDaysToDateStr(today, -1), 9), updatedAt: new Date() }] as any[]);
    const summary = await getReengagementSummary(orgKey);
    expect(summary.days).toHaveLength(30);
    expect(summary.days[29].day).toBe(today);
    expect(summary.days.find((day) => day.day === twoAgo)).toEqual({ day: twoAgo, sent: 2, engaged: 1, booked: 1 });
    expect(summary.days.find((day) => day.day === tenAgo)).toEqual({ day: tenAgo, sent: 1, engaged: 0, booked: 0 });
    expect(summary.totals).toEqual({ sent: 3, engaged: 1, booked: 1 });
    expect(summary.windowDays).toBe(7);
    expect(summary.enabled).toBe(process.env.VEHICLE_REENGAGEMENT_ENABLED === 'true');
    expect((await request(app).get(`${base}/activity/reengagement`).set(as('employee'))).status).toBe(403);
    const res = await request(app).get(`${base}/activity/reengagement`).set(as('manager'));
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({ sent: 3, engaged: 1, booked: 1 });
  });

  it('7. Export CSV can use a start and end date, and tells how many rows the file will have', async () => {
    const yesterday = addDaysToDateStr(today, -1);
    const count = (query: string, who: keyof typeof users = 'manager') => request(app).get(`${base}/activity/export/count?${query}`).set(as(who));
    expect((await count(`from=${yesterday}&to=${today}`, 'employee')).status).toBe(403);
    const events = await count(`from=${yesterday}&to=${today}`);
    expect(events.status).toBe(200);
    expect(events.body.data).toEqual({ view: 'events', mode: 'live', range: { from: yesterday, to: today }, total: 6, limit: 5000, rows: 6 });
    expect((await count(`from=${yesterday}&to=${today}&status=failed&range=today`, 'admin')).body.data.total).toBe(1);
    expect((await count(`from=${yesterday}&to=${today}&q=rosa`)).body.data.total).toBe(1);
    expect((await count(`from=${yesterday}&to=${today}&view=logs`)).body.data).toMatchObject({ view: 'logs', total: 4, rows: 4 });
    expect((await count(`from=${today}&to=${today}&view=logs&mode=test`)).body.data.total).toBe(1);
    const file = await request(app).get(`${base}/activity/export?from=${yesterday}&to=${yesterday}&range=month_to_date`).set(as('admin'));
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toBe(`attachment; filename="automation-events-${yesterday}-to-${yesterday}.csv"`);
    const lines = file.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Gus Hale,/);
    const list = await listAutomationActivity(orgKey, { from: today, to: today });
    expect(list.total).toBe(5);
    expect(list.range).toEqual({ key: 'custom', from: today, to: today });
    const problem = async (query: string) => {
      const res = await count(query);
      expect(res.status).toBe(400);
      return res.body.message;
    };
    expect(await problem(`from=${today}`)).toBe('Pick a valid start and end date');
    expect(await problem('from=2026-02-30&to=2026-03-01')).toBe('Pick a valid start and end date');
    expect(await problem('from=11/05/2026&to=11/05/2026')).toBe('Pick a valid start and end date');
    expect(await problem(`from=${today}&to=${yesterday}`)).toBe('The start date must be on or before the end date');
    expect(await problem('from=2025-01-01&to=2026-01-02')).toBe('Pick a date range of one year or less');
    expect((await count('from=2025-01-02&to=2026-01-02')).status).toBe(200);
    expect(customBounds('2026-03-08', '2026-03-08').end.toISOString()).toBe('2026-03-09T06:00:00.000Z');
    const fallBack = customBounds('2026-11-01', '2026-11-01');
    expect([fallBack.start.toISOString(), fallBack.end.toISOString()]).toEqual(['2026-11-01T06:00:00.000Z', '2026-11-02T07:00:00.000Z']);
  });
});
