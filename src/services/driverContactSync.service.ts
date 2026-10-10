import User from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import logger from "../utils/logger";

/*
 * A driver's phone is stored twice: on the account (Profile page,
 * User.personalInfo.phone) and on the verification record (Driver Verification
 * form, DriverProfile.phone), and Dispatch shows the verification one first.
 * When the driver changes it on either page, the other copy follows, so
 * Dispatch always has the latest number. Only a change is copied: saving the
 * page for another reason never pushes an older number over a newer one.
 *
 * The verification address also fills the Profile page's "location" ("City,
 * ST", the format that page already uses). The other way round isn't possible:
 * "location" is free text, not an address.
 *
 * Phone and address aren't verification-critical, so syncing them never
 * reopens a driver's verification.
 */

/** Text from a request or record; anything that isn't text or a number counts as empty. */
const plainText = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** A US phone as the Profile page stores it (10 digits), or null. */
export function usPhoneDigits(value: unknown): string | null {
  let digits = plainText(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

const cityState = (city: unknown, state: unknown) =>
  [city, state].map((part) => plainText(part).trim()).filter(Boolean).join(", ");

/** After the Driver Verification form is saved: copy a changed phone or city/state to the account. */
export async function syncVerificationContactToAccount(input: {
  userId: string;
  previous: { phone?: unknown; city?: unknown; state?: unknown };
  current: { phone?: unknown; city?: unknown; state?: unknown };
}): Promise<void> {
  const set: Record<string, string> = {};

  const phone = usPhoneDigits(input.current.phone);
  if (phone && phone !== usPhoneDigits(input.previous.phone)) {
    set["personalInfo.phone"] = phone;
    // The Profile page shows the number after its country code; this is a US number.
    set["personalInfo.phoneCountryCode"] = "+1";
  }

  const location = cityState(input.current.city, input.current.state);
  if (location && location !== cityState(input.previous.city, input.previous.state)) {
    set["personalInfo.location"] = location;
  }

  if (Object.keys(set).length === 0) return;
  try {
    await User.updateOne({ _id: input.userId, role: "driver" }, { $set: set });
  } catch (error) {
    // The verification save already succeeded; a failed copy is retried the
    // next time the driver changes it.
    logger.warn({ error, userId: input.userId }, "Driver contact sync to account failed");
  }
}

/**
 * After the Profile page is saved: copy a changed phone to the driver's
 * verification record. Only US numbers (+1, or no country code chosen): the
 * Profile page lets drivers pick other country codes, and 10 digits from, say,
 * +63 would otherwise reach Dispatch looking like a US number.
 */
export async function syncAccountPhoneToVerification(input: {
  userId: string;
  previousPhone: unknown;
  newPhone: unknown;
  countryCode: unknown;
}): Promise<void> {
  const countryCode = plainText(input.countryCode).trim();
  if (countryCode !== "" && countryCode !== "+1") return;
  const phone = usPhoneDigits(input.newPhone);
  if (!phone || phone === usPhoneDigits(input.previousPhone)) return;
  try {
    await DriverProfile.updateOne({ userId: input.userId }, { $set: { phone } });
  } catch (error) {
    logger.warn({ error, userId: input.userId }, "Driver phone sync to verification record failed");
  }
}
