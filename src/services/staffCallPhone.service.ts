import StaffCallPhone from '../models/StaffCallPhone.model';
import DealershipPhoneNumber from '../models/DealershipPhoneNumber.model';
import { normalizeDealershipNumber, resolveOutboundNumber } from './dealershipPhoneNumber.service';
import * as telnyx from './telnyx.service';
import { ApiError } from '../utils/ApiError';

const VERIFY_COOLDOWN_MS = 60 * 1000;
const VERIFY_WINDOW_MS = 2 * 60 * 1000;

export function staffPhoneStatus(row: any) {
  const requestedAt = row?.verifyRequestedAt ? new Date(row.verifyRequestedAt).getTime() : 0;
  return {
    phone: String(row?.phone || ''),
    enabled: Boolean(row?.enabled),
    verified: Boolean(row?.verifiedAt),
    verifying: Boolean(row && !row.verifiedAt && requestedAt && Date.now() - requestedAt < VERIFY_WINDOW_MS),
  };
}

export async function getStaffCallPhone(organizationId: string, userId: string) {
  return staffPhoneStatus(await StaffCallPhone.findOne({ organizationId, userId }).lean());
}

export async function saveStaffCallPhone(organizationId: string, userId: string, raw: any) {
  const input = String(raw?.phone ?? '').trim();
  if (!input) {
    await StaffCallPhone.deleteOne({ organizationId, userId });
    return staffPhoneStatus(null);
  }
  const phone = normalizeDealershipNumber(input);
  if (!phone) throw new ApiError(400, 'Enter a 10-digit US mobile number, for example (801) 555-0123.');
  if (phone === normalizeDealershipNumber(telnyx.COMPANY_NUMBER) || await DealershipPhoneNumber.exists({ number: phone })) {
    throw new ApiError(400, "That's a dealership number. Enter your own mobile number.");
  }
  const existing: any = await StaffCallPhone.findOne({ organizationId, userId }).lean();
  const changed = !existing || existing.phone !== phone;
  const row = await StaffCallPhone.findOneAndUpdate(
    { organizationId, userId },
    { $set: { phone, enabled: raw?.enabled === true, ...(changed ? { verifiedAt: null, verifyCallControlId: null, verifyRequestedAt: null } : {}) } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return staffPhoneStatus(row);
}

export async function startStaffPhoneVerification(organizationId: string, userId: string) {
  const row = await StaffCallPhone.findOne({ organizationId, userId });
  if (!row) throw new ApiError(400, 'Save your mobile number first.');
  if (row.verifiedAt) return staffPhoneStatus(row.toObject());
  if (row.verifyRequestedAt && Date.now() - row.verifyRequestedAt.getTime() < VERIFY_COOLDOWN_MS) {
    throw new ApiError(429, 'We just called you. Wait a minute before trying again.');
  }
  const sender = await resolveOutboundNumber({ organizationId, channel: 'calls' }).catch(() => null);
  try {
    const { callControlId } = await telnyx.dialPhone({
      to: row.phone,
      from: sender?.number || telnyx.COMPANY_NUMBER,
      timeoutSecs: 30,
      clientState: { kind: 'phone-verify', settingId: String(row._id) },
    });
    row.verifyCallControlId = callControlId;
    row.verifyRequestedAt = new Date();
    await row.save();
  } catch (error) {
    if (error instanceof telnyx.LocalUiAcceptanceModeBlockedError) throw new ApiError(503, 'Test calls are not available on this test system.');
    throw new ApiError(502, "We couldn't call your phone right now. Try again in a few minutes.");
  }
  return staffPhoneStatus(row.toObject());
}

export async function handleStaffPhoneVerifyAnswered(payload: any, state: any) {
  const callControlId = String(payload?.call_control_id || '');
  const row = await StaffCallPhone.findOne({ _id: state?.settingId, verifyCallControlId: callControlId, verifiedAt: null });
  if (!row) {
    await telnyx.hangupCall(callControlId).catch(() => {});
    return;
  }
  await telnyx.gatherDigit(callControlId, 'This is Suprah CRM. Press 1 to confirm this phone for incoming customer calls.', {
    kind: 'phone-verify-gather', settingId: String(row._id),
  }).catch(() => telnyx.hangupCall(callControlId).catch(() => {}));
}

export async function handleStaffPhoneVerifyGather(payload: any, state: any) {
  const callControlId = String(payload?.call_control_id || '');
  const confirmed = String(payload?.digits || '') === '1'
    ? await StaffCallPhone.findOneAndUpdate(
      { _id: state?.settingId, verifyCallControlId: callControlId, verifiedAt: null },
      { $set: { verifiedAt: new Date() } },
      { new: true },
    )
    : null;
  if (!confirmed) {
    await telnyx.hangupCall(callControlId).catch(() => {});
    return;
  }
  await telnyx.speakFinal(callControlId, 'Thank you. Your phone is confirmed. Goodbye.')
    .catch(() => telnyx.hangupCall(callControlId).catch(() => {}));
}
