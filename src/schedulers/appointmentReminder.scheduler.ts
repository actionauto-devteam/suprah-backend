import cron from 'node-cron';
import Appointment from '../models/Appointment.model';
import emailService from '../services/email.service';
import { sendSms } from '../services/telnyx.service';
import logger from '../utils/logger';
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

async function sendReminderFor(appointment: any): Promise<void> {
  const sends: Array<Promise<unknown>> = [];

  const phone = appointment.customerBooking?.phone;
  const email = appointment.customerBooking?.email;
  const customerName =
    [appointment.customerBooking?.firstName, appointment.customerBooking?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() || 'there';

  if (phone) {
    const timeLabel = formatApptTime(new Date(appointment.startTime));
    const text = `Reminder: your appointment "${appointment.title}" is scheduled for ${timeLabel}. Reply YES to confirm or CANCEL if you need to reschedule. Reply STOP to opt out.`;
    sends.push(
      sendSms(phone, text).catch((err) => {
        logger.warn({ err, appointmentId: appointment._id }, '[AppointmentReminder] SMS send failed');
      }),
    );
  }

  if (email) {
    sends.push(
      emailService
        .sendAppointmentReminder(appointment, email, customerName, appointment.organizationId)
        .catch((err: unknown) => {
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
    .select('title startTime organizationId customerBooking guestEmails reminderTime')
    .limit(BATCH_LIMIT)
    .lean();

  let sent = 0;
  let errors = 0;

  for (const appointment of candidates as any[]) {
    try {
      const claimed = await Appointment.updateOne(
        { _id: appointment._id, reminderSent: false },
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
