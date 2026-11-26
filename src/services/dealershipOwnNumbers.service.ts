import mongoose from 'mongoose';
import Organization from '../models/Organization.model';
import DealershipPhoneNumber from '../models/DealershipPhoneNumber.model';
import { ApiError } from '../utils/ApiError';
import { normalizeIdentityPhone } from '../utils/contactIdentity';

const SETTING = 'otherSystemNumbers';
const MAX_NUMBERS = 20;
const US_E164 = /^\+1[2-9]\d{9}$/;

export const DEALERSHIP_NUMBER_REASON = 'Dealership phone number';

export function normalizeOwnNumber(value: unknown): string | null {
  const normalized = normalizeIdentityPhone(value);
  return normalized && US_E164.test(normalized) ? normalized : null;
}

export async function listOtherSystemNumbers(organizationId: unknown): Promise<string[]> {
  const orgId = String(organizationId ?? '');
  if (!mongoose.isValidObjectId(orgId)) return [];
  const org: any = await Organization.findById(orgId).select(`metadata.${SETTING}`).lean();
  const saved = Array.isArray(org?.metadata?.[SETTING]) ? org.metadata[SETTING] : [];
  return [...new Set(saved.map(normalizeOwnNumber).filter(Boolean) as string[])];
}

export async function saveOtherSystemNumbers(organizationId: string, raw: unknown): Promise<string[]> {
  const input = (raw as any)?.numbers;
  if (!Array.isArray(input)) throw new ApiError(400, 'Send the list of numbers.');
  const numbers: string[] = [];
  for (const value of input) {
    if (!String(value ?? '').trim()) continue;
    const normalized = normalizeOwnNumber(value);
    if (!normalized) throw new ApiError(400, `"${String(value).slice(0, 40)}" is not a valid US phone number.`);
    if (!numbers.includes(normalized)) numbers.push(normalized);
  }
  if (numbers.length > MAX_NUMBERS) throw new ApiError(400, `You can save up to ${MAX_NUMBERS} numbers.`);
  await Organization.updateOne({ _id: organizationId, metadata: null }, { $set: { metadata: {} } });
  const saved = await Organization.updateOne(
    { _id: organizationId },
    numbers.length ? { $set: { [`metadata.${SETTING}`]: numbers } } : { $unset: { [`metadata.${SETTING}`]: 1 } },
  );
  if (!saved.matchedCount) throw new ApiError(404, 'Organization not found');
  return numbers;
}

export async function isDealershipNumber(organizationId: unknown, phone: unknown): Promise<boolean> {
  const normalized = normalizeOwnNumber(phone);
  const orgId = String(organizationId ?? '');
  if (!normalized || !mongoose.isValidObjectId(orgId)) return false;
  if ((await listOtherSystemNumbers(orgId)).includes(normalized)) return true;
  return Boolean(await DealershipPhoneNumber.exists({ organizationId: orgId, number: normalized }));
}
