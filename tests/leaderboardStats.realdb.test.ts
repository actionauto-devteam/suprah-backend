import mongoose from 'mongoose';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import Customer from '../src/models/Customer.model';
import CustomerPurchase from '../src/models/CustomerPurchase.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import UserActivity from '../src/models/UserActivity.model';
import { CallLog, CommunicationMessage } from '../src/models/communication.model';
import { UserBadge } from '../src/models/Badge.model';
import {
  awardBadges,
  badgesByKey,
  buildCheckpoints,
  buildEntries,
  buildFeed,
  buildRecords,
  buildTrend,
  clearLeaderboardCache,
  companyWallTimeUtc,
  kpisByPerson,
  loadPeriodData,
  previousPeriod,
  resolvePeriod,
  teamTotals,
} from '../src/services/leaderboardStats.service';
import {
  canViewLeaderboard,
  leaderboardViewer,
  listLeaderboardStaff,
  setLeaderboardAccess,
} from '../src/services/leaderboardAccess.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const anaCrm = new mongoose.Types.ObjectId();
const anaMain = new mongoose.Types.ObjectId();
const benMain = new mongoose.Types.ObjectId();
const caraCrm = new mongoose.Types.ObjectId();
const danCrm = new mongoose.Types.ObjectId();
const eveCrm = new mongoose.Types.ObjectId();
const lead1 = new mongoose.Types.ObjectId();
const lead2 = new mongoose.Types.ObjectId();
const lead3 = new mongoose.Types.ObjectId();
const conversation = new mongoose.Types.ObjectId();
const chatSession = new mongoose.Types.ObjectId();
const NOW = new Date('2026-11-16T15:00:00.000Z');
const mst = (wall: string) => new Date(`${wall}-07:00`);

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error: any) {
    return { status: error?.statusCode ?? error?.status, message: String(error?.message || '') };
  }
  return null;
}

describe('Real-DB: Leaderboard numbers from real records (local test DB only)', () => {
  beforeAll(async () => {
    const connection = mongoose.connection;
    if (connection.host !== '127.0.0.1' || connection.port !== 27018 || !/_test$/.test(connection.name)) throw new Error('Local test DB only');
    const crm = (id: mongoose.Types.ObjectId, fullName: string, email: string, role: string, extra: Record<string, unknown> = {}) => ({
      _id: id, organizationId: orgId, fullName, username: fullName.split(' ')[0].toLowerCase(), email, password: 'x', role, isActive: true, isOffboarded: false, isSystem: false, ...extra,
    });
    await CrmUser.collection.insertMany([
      crm(anaCrm, 'Ana Caller', 'ana@p55.test', 'employee'),
      crm(caraCrm, 'Cara Admin', 'cara@p55.test', 'admin'),
      crm(danCrm, 'Dan Gone', 'dan@p55.test', 'employee', { isOffboarded: true }),
      crm(eveCrm, 'Eve Viewer', 'eve@p55.test', 'manager'),
    ] as any[]);
    await User.collection.insertMany([
      { _id: anaMain, name: 'Ana Caller', email: 'ana@p55.test', organizationId: orgId, role: 'employee', isActive: true },
      { _id: benMain, name: 'Ben Main', email: 'ben@p55.test', organizationId: orgId, role: 'employee', isActive: true },
    ] as any[]);

    await Lead.collection.insertMany([
      { _id: lead1, organizationId: orgId, firstName: 'Lou', lastName: 'One', phone: '+18015550001', source: 'Website', status: 'Sold', assignedTo: anaMain, createdAt: mst('2026-11-01T09:00:00'), statusHistory: [{ from: 'Contacted', to: 'Sold', changedAt: mst('2026-11-10T16:00:00'), changedBy: anaCrm }] },
      { _id: lead2, organizationId: orgId, firstName: 'Liz', lastName: 'Two', phone: '+18015550002', source: 'Website', status: 'New', assignedTo: anaCrm, createdAt: mst('2026-11-10T08:00:00') },
      { _id: lead3, organizationId: orgId, firstName: 'Lee', lastName: 'Three', phone: '+18015550003', source: 'Website', status: 'New', assignedTo: benMain, createdAt: mst('2026-11-10T09:00:00') },
      { organizationId: orgId, firstName: 'Una', lastName: 'Assigned', phone: '+18015550004', source: 'Website', status: 'New', createdAt: mst('2026-11-10T10:00:00') },
      { organizationId: orgId, firstName: 'Dup', lastName: 'Combined', phone: '+18015550005', source: 'Website', status: 'New', createdAt: mst('2026-11-10T10:30:00'), combinedInto: { leadId: lead2, at: mst('2026-11-10T11:00:00'), previousStatus: 'New' } },
    ] as any[]);

    await CallLog.collection.insertMany([
      { orgId, direction: 'outbound', from: '+18015550100', to: '+18015550001', status: 'completed', placedBy: { userId: String(anaCrm), name: 'Ana Caller' }, answeredAt: mst('2026-11-10T11:00:10'), durationSec: 120, leadId: lead1, createdAt: mst('2026-11-10T11:00:00') },
      { orgId, direction: 'outbound', from: '+18015550100', to: '+18015550009', status: 'canceled', placedBy: { userId: String(anaCrm), name: 'Ana Caller' }, createdAt: mst('2026-11-10T13:30:00') },
      { orgId, direction: 'inbound', from: '+18015550002', to: '+18015550100', status: 'completed', answeredBy: { userId: String(anaMain), name: 'Ana Caller' }, answeredAt: mst('2026-11-10T15:00:05'), durationSec: 60, customerName: 'Liz Two', createdAt: mst('2026-11-10T15:00:00') },
      { orgId, direction: 'outbound', from: '+18015550100', to: '+18015550003', status: 'completed', placedBy: { userId: String(benMain), name: 'Ben Main' }, answeredAt: mst('2026-11-10T19:00:10'), durationSec: 30, leadId: lead3, createdAt: mst('2026-11-10T19:00:00') },
      { orgId, direction: 'inbound', from: '+18015550077', to: '+18015550100', status: 'missed', createdAt: mst('2026-11-10T12:30:00') },
      { orgId, direction: 'outbound', from: '+18015550100', to: '+18015550001', status: 'completed', placedBy: { userId: String(anaCrm), name: 'Ana Caller' }, answeredAt: mst('2026-11-09T23:30:10'), durationSec: 40, createdAt: mst('2026-11-09T23:30:00') },
    ] as any[]);

    await CommunicationMessage.collection.insertMany([
      { orgId, conversationId: conversation, leadId: lead1, direction: 'inbound', body: 'Is it available?', from: '+18015550001', to: '+18015550100', status: 'received', createdAt: mst('2026-11-10T09:00:00') },
      { orgId, conversationId: conversation, leadId: lead1, direction: 'outbound', body: 'AI reply', from: '+18015550100', to: '+18015550001', status: 'delivered', sentBy: { userId: 'ai-agent', name: 'Suprah AI' }, createdAt: mst('2026-11-10T09:01:00') },
      { orgId, conversationId: conversation, leadId: lead1, direction: 'outbound', body: 'Yes it is', from: '+18015550100', to: '+18015550001', status: 'delivered', sentBy: { userId: String(anaCrm), name: 'Ana Caller' }, createdAt: mst('2026-11-10T09:10:00') },
      { orgId, conversationId: conversation, leadId: lead1, direction: 'outbound', body: 'Failed one', from: '+18015550100', to: '+18015550001', status: 'failed', sentBy: { userId: String(anaCrm), name: 'Ana Caller' }, createdAt: mst('2026-11-10T09:20:00') },
    ] as any[]);

    await WebChatMessage.collection.insertMany([
      { organizationId: ORG, sessionId: chatSession, leadId: lead3, direction: 'inbound', body: 'Hello', createdAt: mst('2026-11-10T10:00:00') },
      { organizationId: ORG, sessionId: chatSession, leadId: lead3, direction: 'outbound', body: 'Hi there', sentBy: { userId: String(benMain), name: 'Ben Main' }, createdAt: mst('2026-11-10T10:05:00') },
    ] as any[]);

    await UserActivity.collection.insertOne({ userId: caraCrm, organizationId: orgId, type: 'other', title: 'Lead Replied', metadata: { leadId: String(lead2) }, createdAt: mst('2026-11-10T14:00:00') } as any);

    await Appointment.collection.insertMany([
      { organizationId: ORG, title: 'Test drive', entryType: 'appointment', status: 'scheduled', startTime: mst('2026-11-12T10:00:00'), endTime: mst('2026-11-12T11:00:00'), createdBy: anaCrm, createdByModel: 'CrmUser', salesperson: { userId: benMain, crmUserId: null, name: 'Ben Main' }, leadId: lead3, createdAt: mst('2026-11-10T10:10:00') },
      { organizationId: ORG, title: 'Team lunch', entryType: 'event', status: 'scheduled', startTime: mst('2026-11-12T12:00:00'), endTime: mst('2026-11-12T13:00:00'), createdBy: anaCrm, createdByModel: 'CrmUser', createdAt: mst('2026-11-10T10:20:00') },
      { organizationId: ORG, title: 'Cancelled drive', entryType: 'appointment', status: 'cancelled', startTime: mst('2026-11-12T14:00:00'), endTime: mst('2026-11-12T15:00:00'), createdBy: anaCrm, createdByModel: 'CrmUser', createdAt: mst('2026-11-10T10:30:00') },
    ] as any[]);

    await CustomerPurchase.collection.insertOne({ organizationId: ORG, leadId: lead1, vehicle: { label: '2022 Honda Civic' }, soldAt: mst('2026-11-10T17:00:00'), salespersonId: anaMain, salespersonName: 'Ana Caller', source: 'manual', createdBy: { userId: String(caraCrm), name: 'Cara Admin' }, createdAt: mst('2026-11-10T17:05:00') } as any);

    await Customer.collection.insertMany([
      { organizationId: ORG, firstName: 'New', lastName: 'Customer', createdBy: caraCrm, source: 'manual', createdAt: mst('2026-11-10T18:00:00') },
      { organizationId: ORG, firstName: 'Old', lastName: 'Import', createdBy: caraCrm, source: 'import', createdAt: mst('2026-11-10T18:10:00') },
    ] as any[]);
  });

  afterAll(async () => {
    const connection = mongoose.connection;
    if (connection.host === '127.0.0.1' && connection.port === 27018 && /_test$/.test(connection.name)) await connection.dropDatabase();
  });

  beforeEach(() => clearLeaderboardCache());

  it('resolves Denver periods and checkpoint times', () => {
    expect(resolvePeriod({ period: 'today' }, NOW)).toMatchObject({ fromDate: '2026-11-16', toDate: '2026-11-16', singleDay: true });
    expect(resolvePeriod({ period: 'yesterday' }, NOW)).toMatchObject({ fromDate: '2026-11-15', toDate: '2026-11-15' });
    expect(resolvePeriod({ period: 'this_week' }, NOW)).toMatchObject({ fromDate: '2026-11-16', toDate: '2026-11-16' });
    expect(resolvePeriod({ period: 'last_week' }, NOW)).toMatchObject({ fromDate: '2026-11-09', toDate: '2026-11-15', days: 7 });
    expect(resolvePeriod({ period: 'this_month' }, NOW)).toMatchObject({ fromDate: '2026-11-01', toDate: '2026-11-16' });
    expect(resolvePeriod({ period: 'last_month' }, NOW)).toMatchObject({ fromDate: '2026-10-01', toDate: '2026-10-31' });
    expect(resolvePeriod({ periodType: 'weekly' }, NOW).preset).toBe('this_week');
    const today = resolvePeriod({ period: 'today' }, NOW);
    expect(today.start.toISOString()).toBe('2026-11-16T07:00:00.000Z');
    expect(today.end.toISOString()).toBe('2026-11-17T07:00:00.000Z');
    expect(companyWallTimeUtc('2026-11-10', 12).toISOString()).toBe('2026-11-10T19:00:00.000Z');
    expect(companyWallTimeUtc('2026-07-10', 12).toISOString()).toBe('2026-07-10T18:00:00.000Z');
    expect(previousPeriod(resolvePeriod({ period: 'this_week' }, NOW))).toMatchObject({ fromDate: '2026-11-09', toDate: '2026-11-15' });
    expect(() => resolvePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-20' }, NOW)).toThrow('future');
    expect(() => resolvePeriod({ period: 'custom', from: '2026-11-12', to: '2026-11-10' }, NOW)).toThrow('before');
    expect(() => resolvePeriod({ period: 'custom', from: '2024-01-01', to: '2026-11-10' }, NOW)).toThrow('one year');
    expect(() => resolvePeriod({ period: 'forever' }, NOW)).toThrow('Unknown period');
  });

  it('counts calls, messages, leads, sales and customers per person', async () => {
    const period = resolvePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-10' }, NOW);
    const data = await loadPeriodData(ORG, period.start, period.end);
    const byPerson = kpisByPerson(data);
    const ana = byPerson.get('ana@p55.test')!;
    const ben = byPerson.get('ben@p55.test')!;
    const cara = byPerson.get('cara@p55.test')!;

    expect(ana).toMatchObject({
      callsMade: 2, callsAnswered: 1, callsTotal: 3, callsConnected: 1, talkTimeSec: 180,
      textsSent: 1, messagesSent: 1, followUpsSent: 2, leadsCreated: 1, leadsConverted: 1,
      conversionRate: 100, transactionsCompleted: 1, avgResponseTimeMin: 10, responsesCount: 1, leadsContacted: 1,
    });
    expect(ben).toMatchObject({ callsMade: 1, callsTotal: 1, talkTimeSec: 30, chatsSent: 1, messagesSent: 1, avgResponseTimeMin: 5, leadsCreated: 1, appointmentsCompleted: 1 });
    expect(cara).toMatchObject({ emailsSent: 1, messagesSent: 1, onboardingsCompleted: 1, followUpsSent: 0, callsTotal: 0 });
    expect(ana.totalScore).toBeGreaterThan(0);

    const totals = teamTotals(data, byPerson);
    expect(totals).toMatchObject({ callsMade: 3, callsAnswered: 1, callsTotal: 4, missedCalls: 1, incomingCalls: 2, leadsCreated: 3, activeUsers: 3, appointmentsCompleted: 1, transactionsCompleted: 1, onboardingsCompleted: 1, messagesSent: 3 });
  });

  it('ranks everyone by calls, hides former staff and compares with the day before', async () => {
    const period = resolvePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-10' }, NOW);
    const prev = previousPeriod(period);
    const [data, prevData] = await Promise.all([loadPeriodData(ORG, period.start, period.end), loadPeriodData(ORG, prev.start, prev.end)]);
    const entries = buildEntries(data, 'calls', prevData);
    const names = entries.map((entry) => entry.user.fullName);
    expect(names).toEqual(['Ana Caller', 'Ben Main', 'Cara Admin', 'Eve Viewer']);
    expect(entries.map((entry) => entry.rank)).toEqual([1, 2, 3, 3]);
    expect(entries[0]).toMatchObject({ metricValue: 3, prevRank: 1, rankChange: 0 });
    expect(entries[0].user.ids.sort()).toEqual([String(anaCrm), String(anaMain)].sort());
    expect(entries[1].prevRank).toBeNull();
    expect(names).not.toContain('Dan Gone');

    const byAppointments = buildEntries(data, 'appointments');
    expect(byAppointments[0].user.fullName).toBe('Ben Main');
  });

  it('builds the 12, 2, 4, 6 and 8 PM call checkpoints', async () => {
    const period = resolvePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-10' }, NOW);
    const data = await loadPeriodData(ORG, period.start, period.end);
    const checkpoints = buildCheckpoints(data, period, NOW)!;
    expect(checkpoints.times).toEqual(['12 PM', '2 PM', '4 PM', '6 PM', '8 PM']);
    expect(checkpoints.rows.find((row) => row.fullName === 'Ana Caller')).toMatchObject({ counts: [1, 2, 3, 3, 3], total: 3 });
    expect(checkpoints.rows.find((row) => row.fullName === 'Ben Main')).toMatchObject({ counts: [0, 0, 0, 0, 1], total: 1 });
    expect(checkpoints.teamCounts).toEqual([1, 2, 3, 3, 4]);

    const midday = buildCheckpoints(data, period, mst('2026-11-10T15:00:00'))!;
    expect(midday.teamCounts).toEqual([1, 2, null, null, null]);

    const week = resolvePeriod({ period: 'last_week' }, NOW);
    expect(buildCheckpoints(await loadPeriodData(ORG, week.start, week.end), week, NOW)).toBeNull();
  });

  it('builds the activity feed, trend and export records', async () => {
    const period = resolvePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-10' }, NOW);
    const data = await loadPeriodData(ORG, period.start, period.end);
    const feed = buildFeed(data, 40);
    expect(feed[0]).toMatchObject({ actionType: 'call_made', customer: 'Lee Three', user: { fullName: 'Ben Main' } });
    expect(feed.map((item) => item.actionType)).toEqual(expect.arrayContaining(['call_made', 'call_received', 'message_sent', 'email_sent', 'appointment_created', 'lead_converted', 'transaction_completed', 'onboarding_completed']));
    expect(feed.find((item) => item.actionType === 'lead_converted')).toMatchObject({ customer: 'Lou One', user: { fullName: 'Ana Caller' } });

    const trend = buildTrend(data, '2026-11-09', 3);
    expect(trend.map((day) => day._id)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(trend[1].count).toBe(data.events.length);

    const calls = buildRecords(data, period, 'calls', 'calls');
    expect(calls.calls).toHaveLength(5);
    expect(calls.activity).toHaveLength(0);
    expect(calls.calls.find((row) => row.result === 'Missed')).toMatchObject({ employee: 'Nobody (missed)', direction: 'Incoming' });
    expect(calls.people[0]).toMatchObject({ name: 'Ana Caller', rank: 1 });
    expect(calls.checkpoints?.teamTotal).toBe(4);

    const full = buildRecords(data, period, 'full', 'calls');
    expect(full.activity).toHaveLength(data.events.length);
    expect(full.activity.some((row) => row.action === 'Call made (follow-up)')).toBe(true);
  });

  it('awards badges once and keeps them', async () => {
    const now = mst('2026-11-12T12:00:00');
    await awardBadges(ORG, now);
    const period = resolvePeriod({ period: 'custom', from: '2026-11-10', to: '2026-11-10' }, NOW);
    const data = await loadPeriodData(ORG, period.start, period.end);
    const badges = await badgesByKey(ORG, data.people);
    expect(badges.get('ana@p55.test')).toEqual(expect.arrayContaining(['first_lead', 'top_weekly']));
    expect(badges.get('ben@p55.test')).toEqual(expect.arrayContaining(['first_lead']));
    expect(badges.get('ben@p55.test')).not.toContain('top_weekly');
    const count = await UserBadge.countDocuments({ organizationId: orgId });

    clearLeaderboardCache();
    await awardBadges(ORG, now);
    expect(await UserBadge.countDocuments({ organizationId: orgId })).toBe(count);

    await UserBadge.deleteMany({ organizationId: orgId });
    clearLeaderboardCache();
    await awardBadges(ORG, NOW);
    const fromLastWeek = await badgesByKey(ORG, data.people);
    expect(fromLastWeek.get('ana@p55.test')).toEqual(expect.arrayContaining(['top_weekly', 'speed_demon']));
    expect(fromLastWeek.get('ben@p55.test')).toEqual(expect.arrayContaining(['speed_demon']));
    expect(await UserBadge.exists({ organizationId: orgId, badgeId: 'top_weekly', periodKey: 'week-2026-11-09' })).toBeTruthy();
  });

  it('lets admins choose who can see the Leaderboard', async () => {
    const admin = await leaderboardViewer(String(caraCrm), ORG);
    const eve = await leaderboardViewer(String(eveCrm), ORG);
    const ben = await leaderboardViewer(String(benMain), ORG);
    expect(admin.admin).toBe(true);
    expect(await canViewLeaderboard(admin)).toBe(true);
    expect(await canViewLeaderboard(eve)).toBe(false);
    expect(await canViewLeaderboard(ben)).toBe(false);

    await setLeaderboardAccess({ admin, principalId: String(eveCrm), principalKind: 'crm', allowed: true });
    await setLeaderboardAccess({ admin, principalId: String(benMain), principalKind: 'main', allowed: true });
    expect(await canViewLeaderboard(eve)).toBe(true);
    expect(await canViewLeaderboard(ben)).toBe(true);

    await setLeaderboardAccess({ admin, principalId: String(eveCrm), principalKind: 'crm', allowed: false });
    expect(await canViewLeaderboard(eve)).toBe(false);

    expect(await errorOf(setLeaderboardAccess({ admin: ben, principalId: String(eveCrm), principalKind: 'crm', allowed: true }))).toMatchObject({ status: 403 });
    expect(await errorOf(setLeaderboardAccess({ admin, principalId: String(caraCrm), principalKind: 'crm', allowed: false }))).toMatchObject({ status: 400 });
    expect(await errorOf(setLeaderboardAccess({ admin, principalId: String(danCrm), principalKind: 'crm', allowed: true }))).toMatchObject({ status: 403 });

    const staff = await listLeaderboardStaff(ORG);
    expect(staff.map((row) => `${row.name}:${row.kind}:${row.allowed}`)).toEqual([
      'Cara Admin:crm:true',
      'Ana Caller:crm:false',
      'Ben Main:main:true',
      'Eve Viewer:crm:false',
    ]);
  });
});
