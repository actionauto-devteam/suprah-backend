import cron from 'node-cron';
import Lead from '../models/lead.model';
import {
  isSmsOptedOut,
  sendStaffAttributedSms,
  checkConversationPauseForLead,
  shouldDeferAutomatedFollowUp,
  resolveDealerName,
  SmsDeliveryUncertainError,
} from '../services/communication.service';
import { hasActiveAppointment, latestContactTimes, customerEmailedSince } from './leadNurture.scheduler';
import { isWithinSendingHours } from '../utils/sendingWindow';
import { NURTURE_ELIGIBLE_STATUSES as ELIGIBLE_STATUSES } from '../constants/leadStatus';
import { resolveAiAgentSettings, generateProactiveFollowUp, classifyAlexReplySafety } from '../services/aiAgent.service';
import { validateOutboundMessage } from '../utils/aiOutboundSafety';
import { CommunicationMessage, Conversation } from '../models/communication.model';
import { retryDbWrite } from '../utils/retryDbWrite';
import logger from '../utils/logger';

/** Eligibility evaluation genuinely starts at 8:00 AM America/Denver, with actual sending
 *  still never earlier than 9:00 AM — preserved as two distinct things, not collapsed into
 *  one once-daily trigger. Runs every 15 minutes from 8 AM through 8 PM (matching every
 *  other scheduler in this codebase — leadNurture, review requests, no-show follow-up all
 *  use frequent self-gated ticks rather than a single daily firing). The 8:00-8:59 AM ticks
 *  will scan and evaluate candidates exactly as later ticks do, but isWithinSendingHours
 *  (checked per-lead below, both before claiming and again right before send) still blocks
 *  any actual send until 9:00 AM — so the 8 AM eligibility check and the 9 AM send floor
 *  are both real, independently enforced, not merged into a single timestamp.  */
const CRON_SCHEDULE = process.env.AI_LEAD_FOLLOWUP_CRON || '*/15 8-20 * * *';
const CRON_TIMEZONE = 'America/Denver';
const STEP_INTERVALS_HOURS = [48, 120, 216]; // Day 2, Day 5, Day 9 since the FIXED cadence anchor (see cadenceAnchor below) — never since the previous automated touch
const MAX_FOLLOWUPS = STEP_INTERVALS_HOURS.length;
const MAX_LEAD_AGE_DAYS = parseInt(process.env.AI_LEAD_FOLLOWUP_MAX_LEAD_AGE_DAYS || '14', 10);
const MAX_ATTEMPTS = parseInt(process.env.AI_LEAD_FOLLOWUP_MAX_ATTEMPTS || '3', 10);
const RETRY_MINUTES = parseInt(process.env.AI_LEAD_FOLLOWUP_RETRY_MINUTES || '15', 10);
const PROCESSING_TIMEOUT_MINUTES = 10;
/** Shared same-day dedup window with leadNurture.scheduler.ts on the same
 *  followUp.lastAutomatedOutreachAt field (set by both schedulers on every claim). 24h —
 *  not just a same-tick race window — so if EITHER scheduler has touched this lead at all
 *  in roughly the last day, the OTHER scheduler will not also claim it, closing the
 *  "duplicate later the same day" gap. This is DB-state-based (not in-memory), so it
 *  survives scheduler restarts and concurrent workers unchanged — there is nothing to
 *  "lose" on restart, the next tick re-reads the same persisted field. Safely smaller than
 *  either scheduler's own minimum legitimate re-touch interval (nurture's smallest step is
 *  24h; this scheduler's smallest is 48h), so it never delays either system's own next
 *  legitimate send — it only blocks a cross-system pile-on. */
const CROSS_SCHEDULER_LOCK_MINUTES = 24 * 60;
const HOUR_MS = 60 * 60 * 1000;
const CUSTOMER_ACTIVITY_GRACE_MS = 60 * 1000;
const BATCH_LIMIT = 100;

interface AiFollowUpStats {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

async function buildSmsTranscriptForLead(organizationId: any, phone: string): Promise<{ from: 'customer' | 'ai' | 'staff'; staffName?: string; body: string }[]> {
  const conversation: any = await Conversation.findOne({ orgId: organizationId, customerPhone: phone }).select('_id').lean();
  if (!conversation) return [];
  const messages = await CommunicationMessage.find({ conversationId: conversation._id })
    .sort({ createdAt: -1 })
    .limit(12)
    .lean();
  return messages.reverse().map((m: any) => {
    if (m.direction === 'inbound') return { from: 'customer' as const, body: m.body };
    if (m.sentBy?.userId === 'ai-agent') return { from: 'ai' as const, body: m.body };
    return { from: 'staff' as const, staffName: m.sentBy?.name, body: m.body };
  });
}

export async function runAiLeadFollowupSweep(): Promise<AiFollowUpStats> {
  const stats: AiFollowUpStats = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const now = new Date();

  const candidates = await Lead.find({
    status: { $in: ELIGIBLE_STATUSES },
    phone: { $exists: true, $ne: '' },
    createdAt: { $gte: new Date(now.getTime() - MAX_LEAD_AGE_DAYS * 24 * HOUR_MS) },
    'followUp.aiFollowUpCount': { $not: { $gte: MAX_FOLLOWUPS } },
    'followUp.aiFollowUpStatus': { $ne: 'pending_reconciliation' },
    $and: [
      {
        $or: [
          { 'followUp.aiFollowUpAttemptCount': { $lt: MAX_ATTEMPTS } },
          { 'followUp.aiFollowUpAttemptCount': { $exists: false } },
        ],
      },
      {
        $or: [
          { 'followUp.aiFollowUpNextRetryAt': null },
          { 'followUp.aiFollowUpNextRetryAt': { $exists: false } },
          { 'followUp.aiFollowUpNextRetryAt': { $lte: now } },
        ],
      },
      {
        $or: [
          { 'followUp.aiFollowUpStatus': { $ne: 'processing' } },
          { 'followUp.aiFollowUpLastAttemptAt': { $lte: new Date(now.getTime() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000) } },
        ],
      },
      {
        $or: [
          { 'followUp.lastAutomatedOutreachAt': null },
          { 'followUp.lastAutomatedOutreachAt': { $exists: false } },
          { 'followUp.lastAutomatedOutreachAt': { $lte: new Date(now.getTime() - CROSS_SCHEDULER_LOCK_MINUTES * 60 * 1000) } },
        ],
      },
    ],
  })
    .select('organizationId firstName lastName phone vehicle followUp createdAt assignedTo')
    .sort({ createdAt: 1 })
    .limit(BATCH_LIMIT)
    .lean();

  stats.scanned = candidates.length;

  for (const lead of candidates as any[]) {
    try {
      const { enabled: aiEnabled, agentName } = await resolveAiAgentSettings(String(lead.organizationId));
      if (!aiEnabled) { stats.skipped++; continue; }

      const step: number = lead.followUp?.aiFollowUpCount || 0;
      const intervalMs = STEP_INTERVALS_HOURS[step] * HOUR_MS;
      const createdAt = new Date(lead.createdAt).getTime();
      // Fixed cadence anchor — deliberately excludes lastAutomatedOutreachAt so Day 2/5/9
      // are always measured from the original customer activity (creation or a human
      // rep's response), never reset or pushed later by this system's own prior sends.
      // The cross-scheduler duplicate check is handled separately below, via the DB-level
      // lastAutomatedOutreachAt recency filter in the candidate query and claim query —
      // not by folding it into this timing math.
      const lastRep = lead.followUp?.lastRepResponseAt ? new Date(lead.followUp.lastRepResponseAt).getTime() : 0;
      const cadenceAnchor = Math.max(createdAt, lastRep);
      if (now.getTime() - cadenceAnchor < intervalMs) continue;

      const earlyPauseCheck = await checkConversationPauseForLead({ organizationId: lead.organizationId, phone: lead.phone, leadId: lead._id });
      if (shouldDeferAutomatedFollowUp(earlyPauseCheck)) { stats.skipped++; continue; }

      const contacts = await latestContactTimes(lead._id);
      const lastOurTouch = Math.max(cadenceAnchor, contacts.human);
      if (now.getTime() - lastOurTouch < intervalMs) continue;

      const customerSince = lastOurTouch + CUSTOMER_ACTIVITY_GRACE_MS;
      const lastCustomer = lead.followUp?.lastCustomerActivityAt ? new Date(lead.followUp.lastCustomerActivityAt).getTime() : createdAt;
      const waitingOnUs =
        lastCustomer > customerSince ||
        contacts.customerCall > customerSince ||
        (await customerEmailedSince(lead, customerSince));
      if (waitingOnUs) { stats.skipped++; continue; }

      if (await hasActiveAppointment(lead._id, now)) { stats.skipped++; continue; }

      if (await isSmsOptedOut(lead.organizationId, lead.phone)) {
        await Lead.updateOne(
          { _id: lead._id, status: { $in: ELIGIBLE_STATUSES } },
          { $set: { 'followUp.aiFollowUpStatus': 'skipped', 'followUp.aiFollowUpFailureReason': 'Customer opted out of SMS', 'followUp.aiFollowUpNextRetryAt': new Date(Date.now() + 24 * HOUR_MS) } },
          { timestamps: false },
        );
        stats.skipped++;
        continue;
      }

      if (!isWithinSendingHours(now)) { stats.skipped++; continue; }

      const staleBefore = new Date(now.getTime() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000);
      const claimed = await Lead.findOneAndUpdate(
        {
          _id: lead._id,
          status: { $in: ELIGIBLE_STATUSES },
          'followUp.aiFollowUpCount': step === 0 ? { $in: [null, 0] } : step,
          'followUp.aiFollowUpStatus': { $ne: 'pending_reconciliation' },
          $and: [
            { $or: [{ 'followUp.aiFollowUpAttemptCount': { $lt: MAX_ATTEMPTS } }, { 'followUp.aiFollowUpAttemptCount': { $exists: false } }] },
            { $or: [{ 'followUp.aiFollowUpStatus': { $ne: 'processing' } }, { 'followUp.aiFollowUpLastAttemptAt': { $lte: staleBefore } }] },
            { $or: [{ 'followUp.lastAutomatedOutreachAt': null }, { 'followUp.lastAutomatedOutreachAt': { $exists: false } }, { 'followUp.lastAutomatedOutreachAt': { $lte: new Date(now.getTime() - CROSS_SCHEDULER_LOCK_MINUTES * 60 * 1000) } }] },
          ],
        },
        {
          $set: { 'followUp.aiFollowUpStatus': 'processing', 'followUp.aiFollowUpLastAttemptAt': now, 'followUp.lastAutomatedOutreachAt': now },
          $inc: { 'followUp.aiFollowUpAttemptCount': 1 },
          $unset: { 'followUp.aiFollowUpFailureReason': 1, 'followUp.aiFollowUpNextRetryAt': 1 },
        },
        { new: true, timestamps: false },
      );
      if (!claimed) continue;

      try {
        // Re-validate everything right before generating/sending — state may have changed
        // between the eligibility scan above and this point, and generation itself can take
        // several seconds during which the customer could reply, opt out, or get paused.
        const revalidate = async (): Promise<string | null> => {
          const pause = await checkConversationPauseForLead({ organizationId: lead.organizationId, phone: lead.phone, leadId: lead._id });
          if (shouldDeferAutomatedFollowUp(pause)) return pause.reason || 'AI conversation is currently paused';
          if (await isSmsOptedOut(lead.organizationId, lead.phone)) return 'Customer opted out of SMS';
          if (await hasActiveAppointment(lead._id, new Date())) return 'Customer now has an active appointment';
          if (!isWithinSendingHours(new Date())) return 'Outside permitted sending hours';
          return null;
        };

        const preGenBlock = await revalidate();
        if (preGenBlock) {
          await Lead.updateOne(
            { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
            { $set: { 'followUp.aiFollowUpStatus': 'skipped', 'followUp.aiFollowUpFailureReason': `Suppressed before generation: ${preGenBlock}` }, $inc: { 'followUp.aiFollowUpAttemptCount': -1 } },
            { timestamps: false },
          );
          stats.skipped++;
          continue;
        }

        const dealerName = await resolveDealerName(lead.organizationId);
        const vehicleInterest = lead.vehicle ? [lead.vehicle.year, lead.vehicle.make, lead.vehicle.model].filter(Boolean).join(' ') : undefined;
        const transcript = await buildSmsTranscriptForLead(lead.organizationId, lead.phone);

        const generation = await generateProactiveFollowUp({
          agentName,
          dealerName,
          customerFirstName: lead.firstName,
          leadVehicleInterest: vehicleInterest,
          transcript,
          channel: 'sms',
          followUpNumber: step + 1,
        });

        if (!generation.text) {
          await Lead.updateOne(
            { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
            { $set: { 'followUp.aiFollowUpStatus': 'failed', 'followUp.aiFollowUpFailureReason': generation.error || 'Generation failed', 'followUp.aiFollowUpNextRetryAt': new Date(Date.now() + RETRY_MINUTES * 60 * 1000) } },
            { timestamps: false },
          );
          stats.errors++;
          continue;
        }

        // Two-layer safety: the same deterministic pattern check and fail-closed AI
        // classifier already used elsewhere in this project, not a third safety system.
        const deterministic = validateOutboundMessage(generation.text);
        const classifierVerdict = deterministic.ok ? await classifyAlexReplySafety(generation.text) : 'UNSAFE';
        if (!deterministic.ok || classifierVerdict !== 'SAFE') {
          await Lead.updateOne(
            { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
            { $set: { 'followUp.aiFollowUpStatus': 'skipped', 'followUp.aiFollowUpFailureReason': `Blocked by safety check: ${deterministic.reasons.join(', ') || classifierVerdict}` } },
            { timestamps: false },
          );
          stats.skipped++;
          continue;
        }

        const postGenBlock = await revalidate();
        if (postGenBlock) {
          await Lead.updateOne(
            { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
            { $set: { 'followUp.aiFollowUpStatus': 'skipped', 'followUp.aiFollowUpFailureReason': `Suppressed after generation: ${postGenBlock}` }, $inc: { 'followUp.aiFollowUpAttemptCount': -1 } },
            { timestamps: false },
          );
          stats.skipped++;
          continue;
        }

        const result = await sendStaffAttributedSms({
          orgId: lead.organizationId,
          toPhone: lead.phone,
          body: generation.text,
          leadId: lead._id,
          actor: { userId: 'ai-agent', name: agentName },
        });

        if (result) {
          try {
            await Lead.updateOne(
              { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
              {
                $set: { 'followUp.aiFollowUpStatus': 'sent', 'followUp.lastAutomatedOutreachAt': new Date(), 'followUp.aiFollowUpAttemptCount': 0 },
                $inc: { 'followUp.aiFollowUpCount': 1 },
                $unset: { 'followUp.aiFollowUpFailureReason': 1, 'followUp.aiFollowUpNextRetryAt': 1 },
              },
              { timestamps: false },
            );
            stats.sent++;
          } catch (recordErr) {
            await retryDbWrite(() =>
              Lead.updateOne(
                { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
                {
                  $set: {
                    'followUp.aiFollowUpStatus': 'pending_reconciliation',
                    'followUp.aiFollowUpFailureReason': 'SMS was sent successfully but the follow-up count could not be recorded',
                  },
                  $unset: { 'followUp.aiFollowUpNextRetryAt': 1 },
                },
                { timestamps: false },
              ),
            ).catch((retryErr) => {
              logger.error({ err: retryErr, leadId: lead._id }, '[AiLeadFollowup] Could not record pending_reconciliation after a confirmed send — lead remains "processing" and may be reclaimed and re-sent once the stale-processing timeout elapses. Not guaranteed exactly-once under a sustained DB outage.');
            });
            stats.errors++;
            logger.error({ err: recordErr, leadId: lead._id }, '[AiLeadFollowup] SMS sent successfully but follow-up bookkeeping failed — marked pending_reconciliation, will not auto-retry');
          }
        } else {
          await Lead.updateOne(
            { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
            { $set: { 'followUp.aiFollowUpStatus': 'skipped', 'followUp.aiFollowUpFailureReason': 'Customer opted out of SMS' } },
            { timestamps: false },
          );
          stats.skipped++;
        }
      } catch (err) {
        if (err instanceof SmsDeliveryUncertainError) {
          await retryDbWrite(() =>
            Lead.updateOne(
              { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
              {
                $set: {
                  'followUp.aiFollowUpStatus': 'pending_reconciliation',
                  'followUp.aiFollowUpFailureReason': err.message,
                  'followUp.aiFollowUpPendingProviderMessageId': err.providerMessageId,
                },
                $unset: { 'followUp.aiFollowUpNextRetryAt': 1 },
              },
              { timestamps: false },
            ),
          ).catch((retryErr) => {
            logger.error({ err: retryErr, leadId: lead._id, providerMessageId: err.providerMessageId }, '[AiLeadFollowup] Could not record pending_reconciliation after an ambiguous send outcome — lead remains "processing" and may be reclaimed and re-sent once the stale-processing timeout elapses. Not guaranteed exactly-once under a sustained DB outage.');
          });
          stats.errors++;
          logger.error({ leadId: lead._id, providerMessageId: err.providerMessageId }, '[AiLeadFollowup] SMS delivery outcome uncertain after provider acceptance — marked pending_reconciliation, will not auto-retry');
          continue;
        }
        const attempts = (lead.followUp?.aiFollowUpAttemptCount || 0) + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        await Lead.updateOne(
          { _id: lead._id, 'followUp.aiFollowUpStatus': 'processing' },
          {
            $set: {
              'followUp.aiFollowUpStatus': 'failed',
              'followUp.aiFollowUpFailureReason': String((err as any)?.message || err).slice(0, 500),
              ...(exhausted ? {} : { 'followUp.aiFollowUpNextRetryAt': new Date(Date.now() + RETRY_MINUTES * attempts * 60 * 1000) }),
            },
            ...(exhausted ? { $unset: { 'followUp.aiFollowUpNextRetryAt': 1 } } : {}),
          },
          { timestamps: false },
        ).catch(() => undefined);
        stats.errors++;
        logger.error({ err, leadId: lead._id }, '[AiLeadFollowup] Failed to process lead');
      }
    } catch (err) {
      stats.errors++;
      logger.error({ err, leadId: lead._id }, '[AiLeadFollowup] Failed to evaluate lead');
    }
  }

  return stats;
}

export function initAiLeadFollowupScheduler(): void {
  if (process.env.AI_LEAD_FOLLOWUP_ENABLED !== 'true') {
    logger.info('[AiLeadFollowup] Disabled. Set AI_LEAD_FOLLOWUP_ENABLED=true to enable (also requires AI_AGENT_ENABLED and the org-level AI Agent toggle).');
    return;
  }

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runAiLeadFollowupSweep();
      if (stats.sent > 0 || stats.errors > 0) {
        logger.info(stats, '[AiLeadFollowup] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[AiLeadFollowup] Sweep failed');
    }
  }, { timezone: CRON_TIMEZONE });

  logger.info(`[AiLeadFollowup] Initialized. Schedule: ${CRON_SCHEDULE} (${CRON_TIMEZONE})`);
}
