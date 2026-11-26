import crypto from 'crypto';
import mongoose from 'mongoose';
import { Readable } from 'stream';
import config from '../config';
import { storageService, BucketType } from './storage.service';
import TextFileLink from '../models/TextFileLink.model';
import { CommunicationMessage, IMessageMedia } from '../models/communication.model';
import { isLocalUiAcceptanceMode } from '../utils/aiOutboundSafety';
import logger from '../utils/logger';

export interface OutgoingTextFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface PreparedTextFiles {
  media: IMessageMedia[];
  mediaUrls: string[];
  linkLines: string[];
}

export const MAX_TEXT_FILES = 5;
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_MMS_IMAGE_BYTES = 1024 * 1024;
const MMS_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
export const TEXT_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const LINK_DAYS = 30;
const MAX_INBOUND_MEDIA = 10;
const MAX_INBOUND_BYTES = 10 * 1024 * 1024;
const INBOUND_FETCH_MS = 10_000;
const MMS_URL_SECONDS = 60 * 60;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

function safeName(name: unknown, fallback: string): string {
  const cleaned = String(name || '').replace(/[\\/\r\n"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || fallback;
}

export function publicFileUrl(token: string): string {
  const base = String(config.frontendUrl || config.backendUrl || '').replace(/\/+$/, '');
  return `${base}/api/public/files/${token}`;
}

export function mediaLabel(media: Array<{ kind: string }>): string {
  if (!media.length) return '';
  const images = media.filter((item) => item.kind === 'image').length;
  if (images === media.length) return images === 1 ? 'Sent a photo' : `Sent ${images} photos`;
  return media.length === 1 ? 'Sent a file' : `Sent ${media.length} files`;
}

export function inboundMediaOf(payload: any): Array<{ url: string; contentType: string; size: number }> {
  const list = Array.isArray(payload?.media) ? payload.media : [];
  return list
    .map((item: any) => ({ url: String(item?.url || ''), contentType: String(item?.content_type || item?.contentType || '').toLowerCase(), size: Number(item?.size) || 0 }))
    .filter((item: { url: string }) => /^https?:\/\//i.test(item.url))
    .slice(0, MAX_INBOUND_MEDIA);
}

export function inboundTextOf(payload: any): string {
  const text = String(payload?.text || '');
  if (text.trim()) return text;
  const media = inboundMediaOf(payload);
  return mediaLabel(media.map((item) => ({ kind: item.contentType.startsWith('image/') ? 'image' : 'file' })));
}

export function isPictureOnly(payload: any): boolean {
  return !String(payload?.text || '').trim() && inboundMediaOf(payload).length > 0;
}

async function createLink(input: { organizationId: string; key: string; name: string; contentType: string; size: number; leadId?: unknown; createdBy?: string }) {
  const token = crypto.randomBytes(16).toString('base64url');
  await TextFileLink.create({
    token,
    organizationId: input.organizationId,
    key: input.key,
    name: input.name,
    contentType: input.contentType,
    size: input.size,
    leadId: input.leadId && mongoose.isValidObjectId(String(input.leadId)) ? new mongoose.Types.ObjectId(String(input.leadId)) : null,
    createdBy: input.createdBy,
    expiresAt: new Date(Date.now() + LINK_DAYS * 24 * 60 * 60 * 1000),
  });
  return token;
}

export async function prepareOutgoingTextFiles(input: { organizationId: string; leadId?: unknown; userId?: string; files: OutgoingTextFile[] }): Promise<PreparedTextFiles> {
  const prepared: PreparedTextFiles = { media: [], mediaUrls: [], linkLines: [] };
  for (const [index, file] of input.files.slice(0, MAX_TEXT_FILES).entries()) {
    const contentType = String(file.mimetype || '').toLowerCase();
    const name = safeName(file.originalname, `file-${index + 1}.${EXTENSIONS[contentType] || 'bin'}`);
    const key = await storageService.upload({ buffer: file.buffer, originalname: name, mimetype: contentType }, `text-files/${input.organizationId}`, BucketType.PRIVATE);
    const isImage = contentType.startsWith('image/');
    let mediaUrl: string | null = null;
    if (MMS_IMAGE_TYPES.has(contentType) && file.size <= MAX_MMS_IMAGE_BYTES) {
      const signed = await storageService.getSignedUrl(key, MMS_URL_SECONDS);
      if (signed && /^https:\/\//i.test(signed)) mediaUrl = signed;
    }
    if (mediaUrl) {
      prepared.mediaUrls.push(mediaUrl);
      prepared.media.push({ key, name, contentType, size: file.size, kind: 'image' });
      continue;
    }
    const linkToken = await createLink({ organizationId: input.organizationId, key, name, contentType, size: file.size, leadId: input.leadId, createdBy: input.userId });
    prepared.linkLines.push(`${name}: ${publicFileUrl(linkToken)}`);
    prepared.media.push({ key, name, contentType, size: file.size, kind: isImage ? 'image' : 'file', linkToken });
  }
  return prepared;
}

async function download(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INBOUND_FETCH_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_INBOUND_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_INBOUND_BYTES) return null;
    return { buffer, contentType: String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
  } finally {
    clearTimeout(timer);
  }
}

export async function storeIncomingTextMedia(organizationId: string, payload: any): Promise<IMessageMedia[]> {
  const items = inboundMediaOf(payload).filter((item) => isLocalUiAcceptanceMode() || /^https:\/\//i.test(item.url));
  const stored: IMessageMedia[] = [];
  let photo = 0;
  let file = 0;
  for (const item of items) {
    try {
      const fetched = await download(item.url);
      if (!fetched) continue;
      const contentType = item.contentType || fetched.contentType || 'application/octet-stream';
      if (contentType.startsWith('text/') || contentType === 'application/smil') continue;
      const isImage = contentType.startsWith('image/');
      const number = isImage ? ++photo : ++file;
      const name = `${isImage ? 'photo' : 'file'}-${number}.${EXTENSIONS[contentType] || 'bin'}`;
      const key = await storageService.upload({ buffer: fetched.buffer, originalname: name, mimetype: contentType }, `text-media/${organizationId}`, BucketType.PRIVATE);
      stored.push({ key, name, contentType, size: fetched.buffer.length, kind: isImage ? 'image' : 'file' });
    } catch (error) {
      logger.warn({ err: error, organizationId }, '[TextMedia] Could not save a picture from an incoming text');
    }
  }
  return stored;
}

function orgVariants(organizationId: string): any[] {
  return mongoose.isValidObjectId(organizationId) ? [organizationId, new mongoose.Types.ObjectId(organizationId)] : [organizationId];
}

export async function openMessageMedia(organizationId: string, messageId: string, index: number): Promise<{ stream: Readable; contentType: string; name: string } | null> {
  if (!mongoose.isValidObjectId(messageId) || !Number.isInteger(index) || index < 0) return null;
  const message: any = await CommunicationMessage.findOne({ _id: messageId, orgId: { $in: orgVariants(organizationId) } }).select('media').lean();
  const item = message?.media?.[index];
  if (!item?.key) return null;
  const opened = await storageService.streamPrivateFile(item.key);
  if (!opened) return null;
  return { stream: opened.stream, contentType: item.contentType || opened.contentType, name: item.name || `file-${index + 1}` };
}

export async function openSharedFile(token: string): Promise<{ stream: Readable; contentType: string; name: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  const link: any = await TextFileLink.findOne({ token, expiresAt: { $gt: new Date() } }).lean();
  if (!link) return null;
  const opened = await storageService.streamPrivateFile(link.key);
  if (!opened) return null;
  return { stream: opened.stream, contentType: link.contentType || opened.contentType, name: link.name || 'file' };
}
