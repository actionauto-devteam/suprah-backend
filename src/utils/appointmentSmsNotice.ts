import mongoose from 'mongoose';
import Appointment, { AppointmentSmsNoticeStatus } from '../models/Appointment.model';
import { isSmsDestinationError } from './smsDestination';
import { isContactRestrictedError } from '../services/contactRestriction.service';

export type AppointmentSmsNoticeField = 'reminderSms' | 'rescheduleNotice';

export const SMS_NOTICE_FIELDS: AppointmentSmsNoticeField[] = ['reminderSms', 'rescheduleNotice'];
export const SMS_OPTED_OUT_NOTICE_REASON = 'This customer replied STOP, so texting is turned off.';
export const SMS_PROVIDER_REJECTED_REASON = 'The text service rejected this message.';
export const SMS_UNCONFIRMED_REASON = "We couldn't confirm whether this text went out.";
export const SMS_CARRIER_FAILED_REASON = 'The carrier reported that this text was not delivered.';

export interface AppointmentSmsNoticeOutcome {
  status: Extract<AppointmentSmsNoticeStatus, 'accepted' | 'not_sent' | 'failed' | 'unknown'>;
  reason?: string | null;
  messageId?: string | null;
  providerMessageId?: string | null;
}

export type AppointmentTextSendResult = boolean | { messageId?: unknown; providerMessageId?: unknown } | null | undefined;

const asDate = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));

const asObjectId = (value: unknown) =>
  value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null;

export function noticeOutcomeFromSendResult(result: AppointmentTextSendResult): AppointmentSmsNoticeOutcome {
  if (!result) return { status: 'not_sent', reason: SMS_OPTED_OUT_NOTICE_REASON };
  if (result === true) return { status: 'accepted' };
  return {
    status: 'accepted',
    messageId: result.messageId ? String(result.messageId) : null,
    providerMessageId: result.providerMessageId ? String(result.providerMessageId) : null,
  };
}

export function noticeOutcomeFromSendError(error: any): AppointmentSmsNoticeOutcome {
  if (isSmsDestinationError(error) || isContactRestrictedError(error)) return { status: 'not_sent', reason: error.message };
  if (error?.name === 'SmsDeliveryUncertainError') {
    return {
      status: 'unknown',
      reason: SMS_UNCONFIRMED_REASON,
      messageId: error.messageId ? String(error.messageId) : null,
      providerMessageId: error.providerMessageId ? String(error.providerMessageId) : null,
    };
  }
  return { status: 'failed', reason: SMS_PROVIDER_REJECTED_REASON };
}

export function plannedSmsNotice(
  status: Extract<AppointmentSmsNoticeStatus, 'not_sent' | 'sending'>,
  forStartTime: unknown,
  reason?: string | null,
) {
  return {
    status,
    reason: reason ?? null,
    forStartTime: asDate(forStartTime),
    messageId: null,
    providerMessageId: null,
    updatedAt: new Date(),
  };
}

export async function startAppointmentSmsNotice(
  appointmentId: unknown,
  field: AppointmentSmsNoticeField,
  forStartTime: unknown,
  status: Extract<AppointmentSmsNoticeStatus, 'not_sent' | 'sending'>,
  reason?: string | null,
): Promise<boolean> {
  const notice = plannedSmsNotice(status, forStartTime, reason);
  const result = await Appointment.updateOne(
    { _id: appointmentId, startTime: notice.forStartTime },
    { $set: { [field]: notice } },
    { timestamps: false },
  );
  return result.matchedCount === 1;
}

export async function finishAppointmentSmsNotice(
  appointmentId: unknown,
  field: AppointmentSmsNoticeField,
  forStartTime: unknown,
  outcome: AppointmentSmsNoticeOutcome,
): Promise<boolean> {
  const when = asDate(forStartTime);
  const result = await Appointment.updateOne(
    { _id: appointmentId, startTime: when, [`${field}.forStartTime`]: when, [`${field}.status`]: 'sending' },
    {
      $set: {
        [`${field}.status`]: outcome.status,
        [`${field}.reason`]: outcome.reason ?? null,
        [`${field}.messageId`]: asObjectId(outcome.messageId),
        [`${field}.providerMessageId`]: outcome.providerMessageId ?? null,
        [`${field}.updatedAt`]: new Date(),
      },
    },
    { timestamps: false },
  );
  return result.matchedCount === 1;
}

export async function recordAppointmentSmsDelivery(
  providerMessageId: string,
  status: 'delivered' | 'failed',
): Promise<void> {
  if (!providerMessageId) return;
  await Promise.all(
    SMS_NOTICE_FIELDS.map((field) =>
      Appointment.updateOne(
        { [`${field}.providerMessageId`]: providerMessageId, [`${field}.status`]: { $in: ['accepted', 'unknown'] } },
        {
          $set: {
            [`${field}.status`]: status,
            [`${field}.reason`]: status === 'failed' ? SMS_CARRIER_FAILED_REASON : null,
            [`${field}.updatedAt`]: new Date(),
          },
        },
        { timestamps: false },
      ),
    ),
  );
}
