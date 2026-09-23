import cron from 'node-cron';
import { google } from 'googleapis';
import Lead from '../models/lead.model';
import Appointment from '../models/Appointment.model';
import { CommunicationMessage, CallLog } from '../models/communication.model';
import { isSmsOptedOut, sendLeadNurtureText } from '../services/communication.service';
import { getCentralOAuth2Client } from '../controllers/lead.controller';
import { isWithinSendingHours } from '../utils/sendingWindow';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.LEAD_NURTURE_CRON || '*/15 * * * *';
const STEP_INTERVALS_HOURS = (process.env.LEAD_NURTURE_INTERVALS_HOURS || '24,48,96')
  .split(',')
  .map((value) => parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const MAX_LEAD_AGE_DAYS = parseInt(process.env.LEAD_NURTURE_MAX_LEAD_AGE_DAYS || '10', 10);
const MAX_ATTEMPTS = parseInt(process.env.LEAD_NURTURE_MAX_ATTEMPTS || '3', 10);
const RETRY_MINUTES = parseInt(process.env.LEAD_NURTURE_RETRY_MINUTES || '15', 10);
const PROCESSING_TIMEOUT_MINUTES = 10;
const ELIGIBLE_STATUSES = ['New', 'Contacted', 'Pending'];
const HOUR_MS = 60 * 60 * 1000;
const CUSTOMER_ACTIVITY_GRACE_MS = 60 * 1000;
const BATCH_LIMIT = 300;

interface NurtureStats {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

async function latestContactTimes(leadId: any): Promise<{ human: number; customerCall: number }> {
  const [humanMessage, outboundCall, inboundCall]: any[] = await Promise.all([
    CommunicationMessage.findOne({
      leadId,
      direction: 'outbound',
      'sentBy.userId': { $ne: 'system' },
    })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean(),
    CallLog.findOne({ leadId, direction: 'outbound' })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean(),
    CallLog.findOne({ leadId, direction: 'inbound' })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean(),
  ]);

  const toMs = (doc: any) => (doc?.createdAt ? new Date(doc.createdAt).getTime() : 0);

  return {
    human: Math.max(toMs(humanMessage), toMs(outboundCall)),
    customerCall: toMs(inboundCall),
  };
}

async function customerEmailedSince(lead: any, sinceMs: number): Promise<boolean> {
  if (!lead.threadId) return false;

  const addresses = [lead.email, lead.channel === 'email' ? lead.senderEmail : null]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  if (addresses.length === 0) return true;

  const oauth2Client = await getCentralOAuth2Client(String(lead.organizationId));
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: lead.threadId,
    format: 'metadata',
    metadataHeaders: ['From'],
  });

  return (thread.data.messages || []).some((message) => {
    if (parseInt(message.internalDate || '0', 10) <= sinceMs) return false;
    const from =
      (message.payload?.headers || [])
        .find((header) => header.name?.toLowerCase() === 'from')
        ?.value?.toLowerCase() || '';
    return addresses.some((address) => from.includes(address));
  });
}

async function hasActiveAppointment(leadId: any, now: Date): Promise<boolean> {
  const active = await Appointment.exists({
    leadId,
    status: { $in: ['scheduled', 'confirmed'] },
    startTime: { $gte: now },
  });
  return !!active;
}

export async function runLeadNurtureSweep(): Promise<NurtureStats> {
  const stats: NurtureStats = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const now = new Date();
  if (STEP_INTERVALS_HOURS.length === 0 || !isWithinSendingHours(now)) return stats;

  const candidates = await Lead.find({
    status: { $in: ELIGIBLE_STATUSES },
    phone: { $exists: true, $ne: '' },
    createdAt: { $gte: new Date(now.getTime() - MAX_LEAD_AGE_DAYS * 24 * HOUR_MS) },
    'followUp.nurtureCount': { $not: { $gte: STEP_INTERVALS_HOURS.length } },
    $and: [
      {
        $or: [
          { 'followUp.nurtureAttemptCount': { $lt: MAX_ATTEMPTS } },
          { 'followUp.nurtureAttemptCount': { $exists: false } },
        ],
      },
      {
        $or: [
          { 'followUp.nurtureNextRetryAt': null },
          { 'followUp.nurtureNextRetryAt': { $exists: false } },
          { 'followUp.nurtureNextRetryAt': { $lte: now } },
        ],
      },
      {
        $or: [
          { 'followUp.nurtureStatus': { $ne: 'processing' } },
          {
            'followUp.nurtureLastAttemptAt': {
              $lte: new Date(now.getTime() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000),
            },
          },
        ],
      },
    ],
  })
    .select('organizationId firstName lastName phone email senderEmail channel threadId vehicle followUp createdAt')
    .sort({ createdAt: 1 })
    .limit(BATCH_LIMIT)
    .lean();

  stats.scanned = candidates.length;

  for (const lead of candidates as any[]) {
    try {
      const step: number = lead.followUp?.nurtureCount || 0;
      const intervalMs = STEP_INTERVALS_HOURS[step] * HOUR_MS;
      const createdAt = new Date(lead.createdAt).getTime();
      const lastNurture = lead.followUp?.lastNurtureAt
        ? new Date(lead.followUp.lastNurtureAt).getTime()
        : 0;
      const lastCustomer = lead.followUp?.lastCustomerActivityAt
        ? new Date(lead.followUp.lastCustomerActivityAt).getTime()
        : createdAt;
      const lastRep = lead.followUp?.lastRepResponseAt
        ? new Date(lead.followUp.lastRepResponseAt).getTime()
        : 0;

      const baseAnchor = Math.max(createdAt, lastRep, lastNurture);
      if (now.getTime() - baseAnchor < intervalMs) continue;

      const contacts = await latestContactTimes(lead._id);
      const lastOurTouch = Math.max(baseAnchor, contacts.human);
      if (now.getTime() - lastOurTouch < intervalMs) continue;

      const customerSince = lastOurTouch + CUSTOMER_ACTIVITY_GRACE_MS;
      const waitingOnUs =
        lastCustomer > customerSince ||
        contacts.customerCall > customerSince ||
        (await customerEmailedSince(lead, customerSince));
      if (waitingOnUs) {
        stats.skipped++;
        continue;
      }

      if (await hasActiveAppointment(lead._id, now)) {
        stats.skipped++;
        continue;
      }

      if (await isSmsOptedOut(lead.organizationId, lead.phone)) {
        await Lead.updateOne(
          { _id: lead._id, status: { $in: ELIGIBLE_STATUSES } },
          {
            $set: {
              'followUp.nurtureStatus': 'skipped',
              'followUp.nurtureFailureReason': 'Customer opted out of SMS',
              'followUp.nurtureNextRetryAt': new Date(Date.now() + 24 * HOUR_MS),
            },
          },
          { timestamps: false },
        );
        stats.skipped++;
        continue;
      }

      const staleBefore = new Date(now.getTime() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000);
      const claimed = await Lead.findOneAndUpdate(
        {
          _id: lead._id,
          status: { $in: ELIGIBLE_STATUSES },
          'followUp.nurtureCount': step === 0 ? { $in: [null, 0] } : step,
          $and: [
            {
              $or: [
                { 'followUp.nurtureAttemptCount': { $lt: MAX_ATTEMPTS } },
                { 'followUp.nurtureAttemptCount': { $exists: false } },
              ],
            },
            {
              $or: [
                { 'followUp.nurtureStatus': { $ne: 'processing' } },
                { 'followUp.nurtureLastAttemptAt': { $lte: staleBefore } },
              ],
            },
          ],
        },
        {
          $set: {
            'followUp.nurtureStatus': 'processing',
            'followUp.nurtureLastAttemptAt': now,
          },
          $inc: { 'followUp.nurtureAttemptCount': 1 },
          $unset: {
            'followUp.nurtureFailureReason': 1,
            'followUp.nurtureNextRetryAt': 1,
          },
        },
        { new: true, timestamps: false },
      );
      if (!claimed) continue;

      if (await sendLeadNurtureText(lead, step)) {
        await Lead.updateOne(
          { _id: lead._id, 'followUp.nurtureStatus': 'processing' },
          {
            $set: {
              'followUp.nurtureStatus': 'sent',
              'followUp.lastNurtureAt': new Date(),
              'followUp.nurtureAttemptCount': 0,
            },
            $inc: { 'followUp.nurtureCount': 1 },
            $unset: {
              'followUp.nurtureFailureReason': 1,
              'followUp.nurtureNextRetryAt': 1,
            },
          },
          { timestamps: false },
        );
        stats.sent++;
      } else {
        await Lead.updateOne(
          { _id: lead._id, 'followUp.nurtureStatus': 'processing' },
          {
            $set: {
              'followUp.nurtureStatus': 'failed',
              'followUp.nurtureFailureReason': 'Customer opted out of SMS',
              'followUp.nurtureNextRetryAt': new Date(Date.now() + 24 * HOUR_MS),
            },
          },
          { timestamps: false },
        );
        stats.skipped++;
      }
    } catch (err) {
      const attempts = (lead.followUp?.nurtureAttemptCount || 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await Lead.updateOne(
        { _id: lead._id, 'followUp.nurtureStatus': 'processing' },
        {
          $set: {
            'followUp.nurtureStatus': 'failed',
            'followUp.nurtureFailureReason': String((err as any)?.message || err).slice(0, 500),
            ...(exhausted
              ? {}
              : {
                  'followUp.nurtureNextRetryAt': new Date(
                    Date.now() + RETRY_MINUTES * attempts * 60 * 1000,
                  ),
                }),
          },
          ...(exhausted ? { $unset: { 'followUp.nurtureNextRetryAt': 1 } } : {}),
        },
        { timestamps: false },
      ).catch(() => undefined);
      stats.errors++;
      logger.error({ err, leadId: lead._id }, '[LeadNurture] Failed to process lead');
    }
  }

  return stats;
}

export function initLeadNurtureScheduler(): void {
  if (process.env.LEAD_NURTURE_ENABLED !== 'true') {
    logger.info('[LeadNurture] Disabled. Set LEAD_NURTURE_ENABLED=true to enable');
    return;
  }

  runLeadNurtureSweep().catch((err) => logger.error(err, '[LeadNurture] Startup sweep failed'));

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runLeadNurtureSweep();
      if (stats.sent > 0 || stats.errors > 0) {
        logger.info(stats, '[LeadNurture] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[LeadNurture] Sweep failed');
    }
  });

  logger.info(
    `[LeadNurture] Initialized. Schedule: ${CRON_SCHEDULE}, step intervals (hours): ${STEP_INTERVALS_HOURS.join(',')}, max lead age: ${MAX_LEAD_AGE_DAYS}d`,
  );
}
