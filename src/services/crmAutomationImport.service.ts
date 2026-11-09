import crypto from 'crypto';
import mongoose from 'mongoose';
import CrmAutomationRun from '../models/CrmAutomationRun.model';
import { ApiError } from '../utils/ApiError';

export const PODIUM_BATCH_LIMIT = 500;
export const PODIUM_KEEP_DAYS = 180;
export const PODIUM_REQUIRED_COLUMNS = ['Automation Type', 'Created At', 'Status'];
export const PODIUM_KEY_COLUMNS = ['Automation Type', 'Data Feed Name', 'Automation Display Name', 'Created At', 'Customer Phone Number', 'Customer Email', 'Customer Name', 'Location Name'];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COLUMNS = 40;
const MAX_CELL = 500;
const MAX_OCCURRENCE = 10000;

type RunStatus = 'completed' | 'waiting' | 'filtered' | 'failed';
type LogStatus = 'sent' | 'done' | 'skipped' | 'failed';

const STATUSES: Record<string, { status: RunStatus; sent: boolean; log: LogStatus | null }> = {
  'message sent': { status: 'completed', sent: true, log: 'sent' },
  processed: { status: 'completed', sent: false, log: 'done' },
  scheduled: { status: 'waiting', sent: false, log: null },
  filtered: { status: 'filtered', sent: false, log: 'skipped' },
  failed: { status: 'failed', sent: false, log: 'failed' },
};

export interface PodiumImportResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  tooOld: number;
}

function bad(message: string): never {
  throw new ApiError(400, message);
}

function cell(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.toLowerCase() === 'null' ? '' : text.slice(0, MAX_CELL);
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function podiumAutomationId(orgId: string, name: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`podium:${orgId}:${name.toLowerCase()}`).digest('hex').slice(0, 24));
}

function logTypeFor(type: string, channel: string): string {
  if (/ai follow/i.test(type)) return 'send_ai_follow_up';
  if (channel === 'email') return 'send_email';
  if (['phone', 'sms', 'text'].includes(channel)) return 'send_message';
  return 'podium';
}

export async function importPodiumRows(orgId: string, body: any, now: Date = new Date()): Promise<PodiumImportResult> {
  const headers: unknown[] = Array.isArray(body?.headers) ? body.headers : bad('The file has no column names');
  if (!headers.length || headers.length > MAX_COLUMNS) bad('The file has no usable columns');
  const rows: unknown[] = Array.isArray(body?.rows) ? body.rows : bad('The file has no rows');
  if (rows.length > PODIUM_BATCH_LIMIT) bad(`Send up to ${PODIUM_BATCH_LIMIT} rows at a time`);
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const key = cell(header).toLowerCase();
    if (key && !index.has(key)) index.set(key, position);
  });
  const missing = PODIUM_REQUIRED_COLUMNS.filter((column) => !index.has(column.toLowerCase()));
  if (missing.length) bad(`This file is missing the ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}. Use the automations export from Podium.`);

  const cutoff = now.getTime() - PODIUM_KEEP_DAYS * DAY_MS;
  const result: PodiumImportResult = { added: 0, updated: 0, unchanged: 0, skipped: 0, tooOld: 0 };
  const ops: any[] = [];
  for (const raw of rows as any[]) {
    const cells: unknown[] | null = Array.isArray(raw?.cells) ? raw.cells : null;
    const occurrence = Number(raw?.n ?? 1);
    if (!cells || cells.length > MAX_COLUMNS || !Number.isInteger(occurrence) || occurrence < 1 || occurrence > MAX_OCCURRENCE) {
      result.skipped++;
      continue;
    }
    const get = (column: string) => {
      const position = index.get(column.toLowerCase());
      return position === undefined ? '' : cell(cells[position]);
    };
    const created = parseDate(get('Created At'));
    const mapped = STATUSES[get('Status').toLowerCase()];
    if (!created || !mapped || created.getTime() > now.getTime() + DAY_MS) {
      result.skipped++;
      continue;
    }
    if (created.getTime() < cutoff) {
      result.tooOld++;
      continue;
    }
    const updated = parseDate(get('Updated At')) || created;
    const type = get('Automation Type');
    const name = (get('Data Feed Name') || get('Automation Display Name') || type || 'Podium automation').slice(0, 120);
    const description = get('Status Description');
    const customer = get('Customer Name');
    const key = crypto.createHash('sha256').update([orgId, ...PODIUM_KEY_COLUMNS.map((column) => get(column).toLowerCase()), occurrence].join('\u001f')).digest('hex');
    ops.push({
      updateOne: {
        filter: { automationId: podiumAutomationId(orgId, name), eventKey: `podium:${key}`, organizationId: orgId, mode: 'podium' },
        update: {
          $setOnInsert: {
            automationName: name,
            event: 'podium_import',
            triggerAt: created,
            targetAt: null,
            appointmentId: null,
            contact: { leadId: null, name: customer, firstName: customer.split(' ')[0] || '', phone: get('Customer Phone Number'), email: get('Customer Email') },
            location: get('Location Name'),
            repeatKey: null,
            pathRepeatKeys: [],
            settings: {},
            steps: [],
            stepIndex: 0,
            notBefore: null,
            nextRunAt: null,
            leaseUntil: null,
            stopAfterMessage: false,
            vehicle: null,
            retrySteps: [],
            createdAt: created,
          },
          $set: {
            status: mapped.status,
            sentAnyMessage: mapped.sent,
            reason: description || null,
            log: mapped.log ? [{ stepId: 'podium', type: logTypeFor(type, get('Channel Type').toLowerCase()), status: mapped.log, detail: description, at: updated }] : [],
            updatedAt: updated,
          },
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return result;
  let write: any;
  try {
    write = await CrmAutomationRun.collection.bulkWrite(ops, { ordered: false });
  } catch (error: any) {
    const errors: any[] = error?.writeErrors || [];
    if (!error?.result || !errors.length || errors.some((item) => item?.code !== 11000)) throw error;
    write = error.result;
    result.unchanged += errors.length;
  }
  result.added = write.upsertedCount || 0;
  result.updated = write.modifiedCount || 0;
  result.unchanged += Math.max(0, (write.matchedCount || 0) - (write.modifiedCount || 0));
  return result;
}
