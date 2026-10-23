import cron from 'node-cron';
import Appointment from '../models/Appointment.model';
import emailService from '../services/email.service';
import { sendSystemSms } from '../services/communication.service';
import { isDemoPhone } from '../utils/demoPhone';
import logger from '../utils/logger';
import { resolveSmsDestination } from '../utils/smsDestination';
import { isContactRestrictedError } from '../services/contactRestriction.service';
import {
  finishAppointmentSmsNotice,
  noticeOutcomeFromSendError,
  noticeOutcomeFromSendResult,
  startAppointmentSmsNotice,
} from '../utils/appointmentSmsNotice';
import { CALENDAR_TZ } from '../constants/calendarTimezone';

const CRON_SCHEDULE = process.env.APPOINTMENT_REMINDER_CRON || '*/10 * * * *';
const LEAD_MINUTES = parseInt(process.env.APPOINTMENT_REMINDER_LEAD_MINUTES || '60', 10);
const BATCH_LIMIT = 100;

interface ReminderStats {
  scanned: number;
  sent: number;
  errors: number;
}

function formatApptTime(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: CALENDAR_TZ,
  });
}

export async function sendReminderFor(appointment: any): Promise<void> {
  const sends: Array<Promise<unknown>> = [];

  const phone = appointment.customerBooking?.phone;
  const email = appointment.customerBooking?.email;
  const customerName =
    [appointment.customerBooking?.firstName, appointment.customerBooking?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() || 'there';

  const isDemoCustomer = Boolean(phone) && isDemoPhone(phone);

  const forStartTime = new Date(appointment.startTime);
  const destination = phone ? resolveSmsDestination(phone, 'automated') : null;
  if (destination && !destination.ok) {
    logger.warn({ appointmentId: appointment._id, reason: destination.reason }, '[AppointmentReminder] SMS skipped: phone number cannot be texted');
    sends.push(
      startAppointmentSmsNotice(appointment._id, 'reminderSms', forStartTime, 'not_sent', destination.message).catch((err) => {
        logger.warn({ err, appointmentId: appointment._id }, '[AppointmentReminder] Could not record skipped SMS');
      }),
    );
  } else if (phone) {
    const timeLabel = formatApptTime(forStartTime);
    const text = `Reminder: your appointment "${appointment.title}" is scheduled for ${timeLabel}. Reply YES to confirm or CANCEL if you need to reschedule. Reply STOP to opt out.`;
    sends.push(
      (async () => {
        const started = await startAppointmentSmsNotice(appointment._id, 'reminderSms', forStartTime, 'sending');
        if (!started) {
          logger.warn({ appointmentId: appointment._id }, '[AppointmentReminder] SMS skipped: appointment time changed before sending');
          return;
        }
        const outcome = await sendSystemSms({
          orgId: appointment.organizationId,
          toPhone: phone,
          body: text,
          leadId: appointment.leadId,
        }).then(noticeOutcomeFromSendResult, noticeOutcomeFromSendError);
        if (outcome.status !== 'accepted') {
          logger.warn({ appointmentId: appointment._id, status: outcome.status }, '[AppointmentReminder] SMS not sent');
        }
        await finishAppointmentSmsNotice(appointment._id, 'reminderSms', forStartTime, outcome);
      })().catch((err) => {
        logger.warn({ err, appointmentId: appointment._id }, '[AppointmentReminder] SMS send failed');
      }),
    );
  }

  let emailBlockedReason: string | null = null;
  let customerEmailSent = false;
  if (email && !isDemoCustomer) {
    sends.push(
      emailService
        .sendAppointmentReminder(appointment, email, customerName, appointment.organizationId)
        .then(() => {
          customerEmailSent = true;
        })
        .catch((err: unknown) => {
          if (isContactRestrictedError(err)) emailBlockedReason = err.message;
          logger.warn({ err, appointmentId: appointment._id }, '[AppointmentReminder] Customer email send failed');
        }),
    );
  }

  const guestRecipients = (appointment.guestEmails || []).filter(
    (guest: any) => guest?.email && guest.status !== 'declined',
  );

  for (const guest of guestRecipients) {
    sends.push(
      emailService
        .sendAppointmentReminder(appointment, guest.email, guest.guestName || 'there', appointment.organizationId)
        .catch((err: unknown) => {
          logger.warn({ err, appointmentId: appointment._id }, '[AppointmentReminder] Guest email send failed');
        }),
    );
  }

  await Promise.allSettled(sends);

  if (emailBlockedReason) {
    await Appointment.updateOne(
      { _id: appointment._id, startTime: appointment.startTime },
      { $set: { customerEmailNotice: { status: 'not_sent', emailType: 'reminder', reason: emailBlockedReason, updatedAt: new Date() } } },
      { timestamps: false },
    ).catch((err: unknown) => logger.warn({ err, appointmentId: appointment._id }, '[AppointmentReminder] Could not save the email warning'));
  } else if (customerEmailSent && appointment.customerEmailNotice) {
    await Appointment.updateOne(
      { _id: appointment._id, startTime: appointment.startTime },
      { $unset: { customerEmailNotice: '' } },
      { timestamps: false },
    ).catch((err: unknown) => logger.warn({ err, appointmentId: appointment._id }, '[AppointmentReminder] Could not clear the email warning'));
  }
}

export async function runAppointmentReminderSweep(): Promise<ReminderStats> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + LEAD_MINUTES * 60 * 1000);

  const candidates = await Appointment.find({
    entryType: 'appointment',
    status: { $in: ['scheduled', 'confirmed'] },
    reminderSent: false,
    $or: [
      { reminderTime: { $ne: null, $lte: now } },
      { reminderTime: { $in: [null, undefined] }, startTime: { $gte: now, $lte: windowEnd } },
    ],
  })
    .select('title startTime organizationId customerBooking guestEmails reminderTime leadId')
    .limit(BATCH_LIMIT)
    .lean();

  let sent = 0;
  let errors = 0;

  for (const appointment of candidates as any[]) {
    try {
      const claimed = await Appointment.updateOne(
        { _id: appointment._id, reminderSent: false, startTime: appointment.startTime },
        { $set: { reminderSent: true, reminderSentAt: now } },
      );
      if (claimed.modifiedCount === 0) continue;

      await sendReminderFor(appointment);
      sent++;
    } catch (err) {
      errors++;
      logger.error({ err, appointmentId: appointment._id }, '[AppointmentReminder] Failed to process appointment');
    }
  }

  return { scanned: candidates.length, sent, errors };
}

export function initAppointmentReminderScheduler(): void {
  runAppointmentReminderSweep().catch((err) =>
    logger.error(err, '[AppointmentReminder] Startup sweep failed'),
  );

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runAppointmentReminderSweep();
      if (stats.sent > 0 || stats.errors > 0) {
        logger.info(stats, '[AppointmentReminder] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[AppointmentReminder] Sweep failed');
    }
  });

  logger.info(
    `[AppointmentReminder] Initialized — schedule: ${CRON_SCHEDULE}, lead time: ${LEAD_MINUTES}m`,
  );
}
