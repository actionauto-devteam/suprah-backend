import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import { parseEmailBody } from '../utils/adfParser';
import { leadCustomerArea, postalAddressLine, sameCustomerArea } from '../utils/customerArea';

export interface LeadCustomerAreaBackfillSummary {
  apply: boolean;
  scanned: number;
  toUpdate: number;
  saved: number;
  changedMeanwhile: number;
  addressFilled: number;
  areaSet: number;
  areaCleared: number;
  byArea: Record<string, number>;
  byBasis: Record<string, number>;
  noArea: number;
}

const WRITE_BATCH = 500;
const MAX_ADDRESS_LENGTH = 300;
const CONTACT_HEADER = '— Contact Information —';
const ADDRESS_ENTRY = /\nAddress:[ \t]*([\s\S]+)$/;

const add = (bucket: Record<string, number>, key: string) => {
  bucket[key] = (bucket[key] || 0) + 1;
};

function addressFromSummary(parsedContent: unknown): string {
  const text = String(parsedContent || '').replace(/\r\n/g, '\n');
  const start = text.indexOf(CONTACT_HEADER);
  if (start < 0) return '';
  const afterHeader = text.slice(start + CONTACT_HEADER.length);
  const end = afterHeader.indexOf('\n\n');
  const block = end < 0 ? afterHeader : afterHeader.slice(0, end);
  const entry = ADDRESS_ENTRY.exec(block)?.[1] || '';
  return entry.replace(/\s+/g, ' ').trim().slice(0, MAX_ADDRESS_LENGTH);
}

async function addressFromSavedAdf(lead: any): Promise<string> {
  if (lead.channel !== 'adf' || String(lead.address || '').trim()) return '';
  const fromSummary = addressFromSummary(lead.parsedContent);
  if (fromSummary) return fromSummary;
  if (String(lead.firstName || '').trim().toLowerCase() !== 'unknown') return '';
  const saved: any = await Lead.findById(lead._id).select('body subject senderEmail').lean();
  if (!saved?.body) return '';
  const parsed = await parseEmailBody(String(saved.body), String(saved.subject || ''), String(saved.senderEmail || '')).catch(() => null);
  return postalAddressLine(parsed?.adfData?.rawFields);
}

export async function runLeadCustomerAreaBackfill(options: { apply?: boolean; organizationId?: string } = {}): Promise<LeadCustomerAreaBackfillSummary> {
  const apply = options.apply === true;
  const summary: LeadCustomerAreaBackfillSummary = {
    apply,
    scanned: 0,
    toUpdate: 0,
    saved: 0,
    changedMeanwhile: 0,
    addressFilled: 0,
    areaSet: 0,
    areaCleared: 0,
    byArea: {},
    byBasis: {},
    noArea: 0,
  };

  const filter: Record<string, unknown> = {};
  if (options.organizationId) filter.organizationId = new mongoose.Types.ObjectId(options.organizationId);

  const cursor = Lead.find(filter)
    .select('_id firstName phone address customerArea channel parsedContent')
    .lean()
    .cursor();

  let ops: any[] = [];
  const flush = async () => {
    if (!ops.length) return;
    if (apply) {
      const result: any = await Lead.bulkWrite(ops, { ordered: false });
      const matched = Number(result?.matchedCount ?? 0);
      summary.saved += matched;
      summary.changedMeanwhile += ops.length - matched;
    }
    ops = [];
  };

  for await (const lead of cursor as AsyncIterable<any>) {
    summary.scanned += 1;
    const filledAddress = await addressFromSavedAdf(lead);
    const area = leadCustomerArea({ address: filledAddress || lead.address, phone: lead.phone });
    if (area) {
      add(summary.byArea, area.code);
      add(summary.byBasis, area.basis);
    } else {
      summary.noArea += 1;
    }

    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (filledAddress) {
      set.address = filledAddress;
      summary.addressFilled += 1;
    }
    if (!sameCustomerArea(area, lead.customerArea)) {
      if (area) {
        set.customerArea = area;
        summary.areaSet += 1;
      } else {
        unset.customerArea = 1;
        summary.areaCleared += 1;
      }
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) continue;

    summary.toUpdate += 1;
    ops.push({
      updateOne: {
        filter: { _id: lead._id, phone: lead.phone ?? null, address: lead.address ?? null },
        update: {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        timestamps: false,
      },
    });
    if (ops.length >= WRITE_BATCH) await flush();
  }

  await flush();
  return summary;
}
