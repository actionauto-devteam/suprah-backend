import { createHash, randomBytes } from 'crypto';
import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import CrmExtensionSignInCode from '../models/CrmExtensionSignInCode.model';
import { ApiError } from '../utils/ApiError';

export const EXTENSION_SIGN_IN_CODE_TTL_MS = 60 * 1000;
export const AUTOMATIC_SIGN_IN_UNAVAILABLE = "This account can't sign in to the extension automatically. Use your Employee ID instead.";
export const SIGN_IN_CODE_EXPIRED = 'This sign-in expired. Open Suprah CRM again to sign in.';

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export async function createExtensionSignInCode(crmUserId: unknown, organizationId: unknown, rawChallenge: unknown) {
  const challenge = typeof rawChallenge === 'string' ? rawChallenge.trim() : '';
  if (!CHALLENGE.test(challenge)) throw new ApiError(400, 'Open the Suprah CRM extension, then try again.');
  const userId = String(crmUserId ?? '');
  const orgId = String(organizationId ?? '');
  if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(orgId)) throw new ApiError(403, AUTOMATIC_SIGN_IN_UNAVAILABLE);
  const user: any = await CrmUser.findById(userId).select('username isActive organizationId').lean();
  if (!user || !user.isActive || !user.organizationId || String(user.organizationId) !== orgId) {
    throw new ApiError(403, AUTOMATIC_SIGN_IN_UNAVAILABLE);
  }
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + EXTENSION_SIGN_IN_CODE_TTL_MS);
  await CrmExtensionSignInCode.create({ codeHash: hashCode(code), challenge, crmUserId: user._id, organizationId: user.organizationId, expiresAt });
  return { code, expiresAt, username: String(user.username || '') };
}

export async function redeemExtensionSignInCode(rawCode: unknown, rawVerifier: unknown) {
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  const verifier = typeof rawVerifier === 'string' ? rawVerifier.trim() : '';
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(code) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new ApiError(401, SIGN_IN_CODE_EXPIRED);
  const now = new Date();
  const record: any = await CrmExtensionSignInCode.findOneAndUpdate(
    { codeHash: hashCode(code), challenge: challengeFor(verifier), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  ).lean();
  if (!record) throw new ApiError(401, SIGN_IN_CODE_EXPIRED);
  const user = await CrmUser.findById(record.crmUserId);
  if (!user || !user.isActive) throw new ApiError(403, 'Account has been deactivated. Contact your administrator.');
  if (!user.organizationId || String(user.organizationId) !== String(record.organizationId)) {
    throw new ApiError(403, 'Your account is not linked to a dealership');
  }
  return user;
}
