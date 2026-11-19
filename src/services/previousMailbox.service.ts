import { google } from 'googleapis';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { decrypt, encrypt } from '../utils/crypto';
import { withRetry } from '../utils/withRetry';
import { isMissingGmailThread, isRevokedGoogleAccess } from '../utils/gmailThread';
import { cacheService } from './cache.service';

export const PREVIOUS_MAILBOX_READ_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StoredMailbox = {
  gmailAddress?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiryDate?: number | null;
  replacedAt?: Date | string | null;
};

type ConnectedMailbox = StoredMailbox & {
  previousMailbox?: StoredMailbox | null;
};

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export function previousMailboxReadUntil(previous?: StoredMailbox | null): Date | null {
  if (!previous?.refreshToken || !previous.replacedAt) return null;
  const replacedAt = new Date(previous.replacedAt).getTime();
  return Number.isFinite(replacedAt) ? new Date(replacedAt + PREVIOUS_MAILBOX_READ_DAYS * DAY_MS) : null;
}

export function isPreviousMailboxReadable(previous?: StoredMailbox | null, now = Date.now()): boolean {
  const until = previousMailboxReadUntil(previous);
  return Boolean(until && until.getTime() > now);
}

export function previousMailboxAfterSwitch(
  existing: ConnectedMailbox | null | undefined,
  newAddress: string,
  now = new Date(),
): { keep: true } | { clear: true } | { set: StoredMailbox } {
  const previous = existing?.previousMailbox?.refreshToken ? existing.previousMailbox : null;
  const switching = Boolean(existing?.refreshToken) && !sameAddress(existing?.gmailAddress, newAddress);
  const replacedAt = previous?.replacedAt ? new Date(previous.replacedAt).getTime() : NaN;
  const currentWasMistake = Number.isFinite(replacedAt) && now.getTime() - replacedAt < DAY_MS;
  if (switching && !currentWasMistake) {
    return {
      set: {
        gmailAddress: existing!.gmailAddress,
        accessToken: existing!.accessToken,
        refreshToken: existing!.refreshToken,
        expiryDate: existing!.expiryDate,
        replacedAt: now,
      },
    };
  }
  if (previous && sameAddress(previous.gmailAddress, newAddress)) return { clear: true };
  return { keep: true };
}

export function previousMailboxClient(orgId: string, previous: StoredMailbox) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  client.setCredentials({
    access_token: previous.accessToken ? decrypt(previous.accessToken) : undefined,
    refresh_token: decrypt(String(previous.refreshToken)),
    expiry_date: previous.expiryDate || undefined,
  });
  client.on('tokens', async (tokens) => {
    const update: Record<string, unknown> = {};
    if (tokens.access_token) update['previousMailbox.accessToken'] = encrypt(tokens.access_token);
    if (tokens.refresh_token) update['previousMailbox.refreshToken'] = encrypt(tokens.refresh_token);
    if (tokens.expiry_date) update['previousMailbox.expiryDate'] = tokens.expiry_date;
    if (!Object.keys(update).length) return;
    await OrgLeadConfig.updateOne(
      { organizationId: orgId, 'previousMailbox.refreshToken': previous.refreshToken },
      { $set: update },
    ).catch((error) => console.error(`[OrgSync] Could not save the refreshed sign-in of the previous email account for org ${orgId}:`, error));
  });
  return client;
}

export async function forgetRevokedPreviousMailbox(orgId: string, previous: StoredMailbox, error: unknown): Promise<boolean> {
  if (!isRevokedGoogleAccess(error)) return false;
  await OrgLeadConfig.updateOne(
    { organizationId: orgId, 'previousMailbox.refreshToken': previous.refreshToken },
    { $unset: { previousMailbox: 1 } },
  );
  await cacheService.del(`config:org:${orgId}`).catch(() => undefined);
  console.warn(`[OrgSync] Google no longer gives access to the previous email account of org ${orgId}; it will not be read again.`);
  return true;
}

export async function readPreviousMailboxThread(orgId: string, threadId: string): Promise<{ messages: any[]; gmailAddress: string } | null> {
  const config: any = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true }).select('previousMailbox').lean();
  const previous: StoredMailbox | undefined = config?.previousMailbox;
  if (!previous?.refreshToken) return null;
  const gmail = google.gmail({ version: 'v1', auth: previousMailboxClient(orgId, previous) });
  try {
    const thread: any = await withRetry(() => gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
    return { messages: thread.data.messages || [], gmailAddress: String(previous.gmailAddress || '') };
  } catch (error) {
    if (isMissingGmailThread(error)) return null;
    if (await forgetRevokedPreviousMailbox(orgId, previous, error)) return null;
    throw error;
  }
}
