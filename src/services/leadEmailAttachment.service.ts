import mongoose from 'mongoose';
import { google } from 'googleapis';
import Lead from '../models/lead.model';
import { leadEmailThreadIds } from '../utils/gmailThread';
import { isLocalUiAcceptanceMode } from '../utils/aiOutboundSafety';

interface GmailPart {
  filename?: string | null;
  mimeType?: string | null;
  body?: { attachmentId?: string | null; data?: string | null } | null;
  parts?: GmailPart[] | null;
}

export interface LeadEmailAttachment {
  buffer: Buffer;
  name: string;
  contentType: string;
}

export function attachmentParts(payload: GmailPart | null | undefined): GmailPart[] {
  const found: GmailPart[] = [];
  const walk = (part?: GmailPart | null) => {
    if (!part) return;
    if (part.filename) found.push(part);
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  return found;
}

function decode(data: string): Buffer {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function readLeadEmailAttachment(input: {
  organizationId: string;
  leadId: string;
  gmailId: string;
  index: number;
  gmailClient?: any;
}): Promise<LeadEmailAttachment | null> {
  if (isLocalUiAcceptanceMode() && !input.gmailClient) return null;
  if (!mongoose.isValidObjectId(input.leadId) || !/^[A-Za-z0-9_-]{6,64}$/.test(input.gmailId)) return null;
  if (!Number.isInteger(input.index) || input.index < 0) return null;
  const lead: any = await Lead.findOne({ _id: input.leadId, organizationId: input.organizationId }).select('threadId previousThreadIds').lean();
  const threadIds = lead ? leadEmailThreadIds(lead) : [];
  if (!threadIds.length) return null;

  let gmail = input.gmailClient;
  if (!gmail) {
    const { getCentralOAuth2Client } = await import('../controllers/lead.controller');
    gmail = google.gmail({ version: 'v1', auth: await getCentralOAuth2Client(input.organizationId) });
  }
  const message: any = await gmail.users.messages.get({ userId: 'me', id: input.gmailId, format: 'full' }).catch(() => null);
  if (!message?.data || !threadIds.includes(String(message.data.threadId || ''))) return null;
  const part = attachmentParts(message.data.payload)[input.index];
  if (!part) return null;
  let data = part.body?.data || '';
  if (!data && part.body?.attachmentId) {
    const attachment: any = await gmail.users.messages.attachments.get({ userId: 'me', messageId: input.gmailId, id: part.body.attachmentId }).catch(() => null);
    data = attachment?.data?.data || '';
  }
  if (!data) return null;
  return {
    buffer: decode(data),
    name: String(part.filename || `attachment-${input.index + 1}`),
    contentType: String(part.mimeType || 'application/octet-stream'),
  };
}
