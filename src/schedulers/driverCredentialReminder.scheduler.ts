import cron from 'node-cron';
import logger from '../utils/logger';
import notificationService from '../services/notification.service';
import DriverProfile, {
  COMPLIANCE_EXPIRY_FIELDS,
  expiringSoonItems,
  type ComplianceExpiryItem,
} from '../models/DriverProfile.model';
import { BUSINESS_TIME_ZONE } from '../utils/businessDate';

/*
 * Reminds a driver before a credential or other dated document expires (the
 * same items as the Driver Page's "expires soon" notice), so they can upload
 * the renewal in time instead of finding out once it has expired. Each one
 * gets one reminder per step (30, 14 and 3 days before, on the Mountain Time
 * calendar), and a renewal with a new expiration date starts over.
 */

/** Days before expiry at which a reminder goes out, closest first. */
export const EXPIRY_REMINDER_DAYS = [3, 14, 30] as const;

/**
 * Reminders go out from 8:00 AM to 7:59 PM Mountain Time (America/Denver,
 * MDT/MST), so a push never wakes a driver at night; one that falls due
 * overnight goes out the next morning.
 */
export const REMINDER_SEND_HOURS_MOUNTAIN = { from: 8, until: 20 } as const;

const mountainHourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: 'numeric',
  hourCycle: 'h23',
});

/** The hour (0-23) in Mountain Time at `nowMs`. */
export function mountainHour(nowMs: number): number {
  return Number(mountainHourFormatter.formatToParts(new Date(nowMs)).find((part) => part.type === 'hour')?.value ?? 0);
}

type ComplianceDates = NonNullable<Parameters<typeof expiringSoonItems>[0]>;

export type DueExpiryReminder = ComplianceExpiryItem & {
  /** "CDL:2026-11-12:14": the credential, its expiration day and the step. */
  key: string;
  reminderDays: number;
};

/**
 * The reminders due for a profile as of `nowMs`: each credential that hasn't
 * expired yet and is within 30 days, at the closest step it has reached,
 * unless that step was already sent for this expiration date.
 */
export function dueExpiryReminders(
  profile: ComplianceDates | null | undefined,
  sent: readonly string[] = [],
  nowMs = Date.now(),
): DueExpiryReminder[] {
  return expiringSoonItems(profile, Math.max(...EXPIRY_REMINDER_DAYS), nowMs).flatMap((item) => {
    const reminderDays = EXPIRY_REMINDER_DAYS.find((days) => item.daysLeft <= days);
    if (reminderDays === undefined) return [];
    const key = `${item.label}:${item.date}:${reminderDays}`;
    return sent.includes(key) ? [] : [{ ...item, key, reminderDays }];
  });
}

/** The driver-facing title and message for one reminder, in plain English. */
export function expiryReminderText(item: ComplianceExpiryItem): { title: string; message: string } {
  const day = new Date(`${item.date}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const when = item.daysLeft <= 1 ? 'tomorrow' : `in ${item.daysLeft} days`;
  return {
    title: `Your ${item.label} expires ${when}`,
    message:
      `Your ${item.label} expires on ${day}. Before then, open your Documents page, press Replace on it ` +
      `and upload the renewed one with its new expiration date. Once it's approved, you're all set.`,
  };
}

type ReminderProfile = ComplianceDates & {
  _id: unknown;
  userId: unknown;
  organizationId?: string;
  complianceRemindersSent?: string[];
};

/** Sends the reminders that are due. Returns how many were sent. */
export async function sendCredentialExpiryReminders(nowMs = Date.now()): Promise<number> {
  const hour = mountainHour(nowMs);
  if (hour < REMINDER_SEND_HOURS_MOUNTAIN.from || hour >= REMINDER_SEND_HOURS_MOUNTAIN.until) return 0;

  // A day of slack each side: dates are calendar days, counted in Mountain Time.
  const window = {
    $gte: new Date(nowMs - 86_400_000),
    $lte: new Date(nowMs + (Math.max(...EXPIRY_REMINDER_DAYS) + 1) * 86_400_000),
  };
  const profiles = await DriverProfile.find({
    $or: [
      ...COMPLIANCE_EXPIRY_FIELDS.map((field) => ({ [field]: window })),
      { documents: { $elemMatch: { expiresAt: window, reviewStatus: { $ne: 'rejected' } } } },
    ],
  })
    .select([
      'userId',
      'organizationId',
      '+complianceRemindersSent',
      ...COMPLIANCE_EXPIRY_FIELDS,
      'documents.type',
      'documents.label',
      'documents.expiresAt',
      'documents.reviewStatus',
    ])
    .lean<ReminderProfile[]>();

  let sent = 0;
  for (const profile of profiles) {
    if (!profile.userId) continue;
    for (const reminder of dueExpiryReminders(profile, profile.complianceRemindersSent ?? [], nowMs)) {
      // Claim the reminder first, so it goes out once even if two servers run this.
      const claimed = await DriverProfile.updateOne(
        { _id: profile._id, complianceRemindersSent: { $ne: reminder.key } },
        { $addToSet: { complianceRemindersSent: reminder.key } },
      );
      if (!claimed.modifiedCount) continue;

      try {
        await notificationService.createNotification({
          userId: String(profile.userId),
          organizationId: profile.organizationId || 'global',
          type: 'driver_document_expiring',
          ...expiryReminderText(reminder),
          metadata: {
            route: '/driver/documents',
            credential: reminder.label,
            expiresOn: reminder.date,
            daysLeft: reminder.daysLeft,
          },
        });
        sent += 1;
      } catch (error) {
        // A missing user won't come back, so keep the claim; anything else is
        // released so the next run tries again.
        if ((error as { statusCode?: number })?.statusCode !== 404) {
          await DriverProfile.updateOne(
            { _id: profile._id },
            { $pull: { complianceRemindersSent: reminder.key } },
          ).catch(() => undefined);
        }
        logger.error(
          { error, profileId: String(profile._id), reminder: reminder.key },
          '[DriverCredentialReminder] Reminder could not be sent',
        );
      }
    }
  }
  return sent;
}

async function run() {
  try {
    const sent = await sendCredentialExpiryReminders();
    if (sent) logger.info({ sent }, '[DriverCredentialReminder] Expiry reminders sent');
  } catch (error) {
    logger.error({ error }, '[DriverCredentialReminder] Reminder run failed');
  }
}

export const initDriverCredentialReminderScheduler = () => {
  // Hourly, plus once at startup; each reminder is claimed, so reruns never repeat one.
  cron.schedule('17 * * * *', run);
  void run();
};
