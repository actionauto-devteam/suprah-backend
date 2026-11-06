import mongoose from 'mongoose';
import LeadInquiry from '../models/LeadInquiry.model';

const INTEREST_LABEL_MAX = 80;
const MAX_OTHER_VEHICLES = 4;
const MAX_INQUIRIES_READ = 25;

function interestLabel(vehicle: any): string {
  return [vehicle?.year, vehicle?.make, vehicle?.model]
    .map((part) => String(part ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, INTEREST_LABEL_MAX)
    .trim();
}

export async function describeVehicleInterest(lead: any, organizationId?: unknown): Promise<string | undefined> {
  const primary = interestLabel(lead?.vehicle);
  const orgId = String(organizationId || lead?.organizationId || '');
  if (!lead?._id || !mongoose.isValidObjectId(orgId) || mongoose.connection.readyState !== 1) return primary || undefined;
  let inquiries: any[] = [];
  try {
    inquiries = await LeadInquiry.find({
      organizationId: orgId,
      'association.leadId': lead._id,
      'association.state': 'associated',
    })
      .select('vehicle receivedAt')
      .sort({ receivedAt: -1 })
      .limit(MAX_INQUIRIES_READ)
      .lean();
  } catch {
    return primary || undefined;
  }
  const seen = new Set<string>(primary ? [primary.toLowerCase()] : []);
  const others: string[] = [];
  for (const inquiry of inquiries) {
    const label = interestLabel(inquiry.vehicle);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    others.push(label);
    if (others.length >= MAX_OTHER_VEHICLES) break;
  }
  if (!others.length) return primary || undefined;
  const list = others.join('; ');
  return primary
    ? `${primary}; the customer also asked about (newest first): ${list}`
    : `The customer asked about (newest first): ${list}`;
}
