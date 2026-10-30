import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import Customer from '../models/Customer.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';

export interface LicensePossibleMatch {
  kind: 'lead' | 'customer';
  id: string;
  name: string;
  status: string | null;
  email: string;
  phone: string;
  address: string;
  createdAt: Date | null;
  sameAddress: boolean | null;
}

const MAX_MATCHES = 5;
const SCAN_LIMIT = 20;
const DIRECTIONS: Record<string, string> = {
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
const exactName = (value: string) => new RegExp(`^\\s*${escapeRegex(value)}\\s*$`, 'i');

export function streetKey(raw: unknown): string {
  const firstLine = String(raw ?? '').toLowerCase().split(/[,\n]/)[0];
  const parts = firstLine.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length < 2 || !/^\d+[a-z]?$/.test(parts[0])) return '';
  const direction = DIRECTIONS[parts[1]];
  if (direction && parts.length > 2) return [parts[0], direction, parts[2]].join(' ');
  return parts.slice(0, 2).join(' ');
}

const formatCustomerAddress = (address: any) => {
  if (!address) return '';
  const stateZip = [address.state, address.postalCode].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  return [address.street, address.city, stateZip].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
};

const compareAddress = (licenseKey: string, other: string): boolean | null => {
  const otherKey = streetKey(other);
  if (!licenseKey || !otherKey) return null;
  return licenseKey === otherKey;
};

export async function findLicensePossibleMatches(
  orgId: string,
  input: { firstName?: unknown; lastName?: unknown; address?: unknown },
): Promise<{ matches: LicensePossibleMatch[]; checked: boolean }> {
  if (!orgId || !mongoose.isValidObjectId(orgId)) throw new ApiError(400, 'Organization context missing');
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (!firstName || !lastName) return { matches: [], checked: true };
  const licenseKey = streetKey(input.address);

  try {
    const [leads, customers] = await Promise.all([
      Lead.find({
        organizationId: new mongoose.Types.ObjectId(orgId),
        firstName: exactName(firstName),
        lastName: exactName(lastName),
        'combinedInto.leadId': { $exists: false },
      })
        .select('firstName lastName email phone address status createdAt')
        .sort({ createdAt: -1 })
        .limit(SCAN_LIMIT)
        .maxTimeMS(3000)
        .lean(),
      Customer.find({ organizationId: orgId, firstName: exactName(firstName), lastName: exactName(lastName) })
        .select('firstName lastName email phone address isActive createdAt')
        .sort({ createdAt: -1 })
        .limit(SCAN_LIMIT)
        .maxTimeMS(3000)
        .lean(),
    ]);

    const matches: LicensePossibleMatch[] = [
      ...customers.map((customer: any) => {
        const address = formatCustomerAddress(customer.address);
        return {
          kind: 'customer' as const,
          id: String(customer._id),
          name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
          status: customer.isActive === false ? 'Inactive' : null,
          email: String(customer.email || ''),
          phone: String(customer.phone || ''),
          address,
          createdAt: customer.createdAt || null,
          sameAddress: compareAddress(licenseKey, customer.address?.street || address),
        };
      }),
      ...leads.map((lead: any) => ({
        kind: 'lead' as const,
        id: String(lead._id),
        name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
        status: lead.status ? String(lead.status) : null,
        email: String(lead.email || ''),
        phone: String(lead.phone || ''),
        address: String(lead.address || ''),
        createdAt: lead.createdAt || null,
        sameAddress: compareAddress(licenseKey, lead.address),
      })),
    ];

    const rank = (match: LicensePossibleMatch) => (match.sameAddress === true ? 0 : match.sameAddress === null ? 1 : 2);
    matches.sort((a, b) => rank(a) - rank(b) || (a.kind === b.kind ? 0 : a.kind === 'customer' ? -1 : 1));
    return { matches: matches.slice(0, MAX_MATCHES), checked: true };
  } catch (err) {
    logger.warn({ err, orgId }, '[LicensePossibleMatch] Duplicate check failed');
    return { matches: [], checked: false };
  }
}
