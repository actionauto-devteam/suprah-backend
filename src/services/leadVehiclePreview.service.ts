import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import Vehicle from '../models/Vehicle.model';
import LeadInquiry from '../models/LeadInquiry.model';
import { ApiError } from '../utils/ApiError';
import { matchesVehicle, normalizeToken } from '../utils/vehicleMatch';
import { LEAD_SOURCE } from '../constants/leadSource';

export type VehiclePreviewState = 'matched' | 'not_found' | 'unconfirmed';
export type VehiclePreviewMatch = 'linked' | 'vin' | 'stock';
export type VehiclePreviewReason = 'vin' | 'stock' | 'linked' | 'duplicate_stock' | 'not_verified' | 'no_identifier';
export type VehicleAvailability = 'listed' | 'recon' | 'in_transit' | 'sold' | 'archived' | 'unknown';

export interface RequestedVehicle {
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
  vin?: string;
  stock?: string;
}

export interface InventoryVehicleSummary {
  id: string;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  vin: string;
  stockNumber: string | null;
  mileage: number | null;
  price: number | null;
  exteriorColor: string | null;
  photoUrl: string | null;
  status: string | null;
  availability: VehicleAvailability;
  archivedAt: string | null;
  inventoryPath: string;
}

export interface VehiclePreviewEntry {
  key: string;
  origin: 'lead' | 'inquiry';
  receivedAt: string | null;
  label: string;
  requested: RequestedVehicle;
  state: VehiclePreviewState;
  match: VehiclePreviewMatch | null;
  reason: VehiclePreviewReason | null;
  similarCount: number | null;
  searchPath: string | null;
  vehicle: InventoryVehicleSummary | null;
}

export interface LeadVehiclePreview {
  leadId: string;
  primary: VehiclePreviewEntry | null;
  others: VehiclePreviewEntry[];
}

const DIRECT_LINK_SOURCES = new Set<string>([LEAD_SOURCE.WEBSITE_BOOKING, LEAD_SOURCE.WEBSITE_CHAT, LEAD_SOURCE.WEBSITE_INQUIRY]);
const VEHICLE_FIELDS = 'year make modelName trim vin stockNumber mileage price exteriorColor images status isArchived archivedAt';
const NOT_DELETED = { isDeleted: { $ne: true } };
const MAX_OTHERS = 4;
const MAX_INQUIRIES = 25;
const SIMILAR_CANDIDATE_LIMIT = 200;

const clean = (value: unknown, max = 60): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalizeVin(value: unknown): string {
  const vin = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin) ? vin : '';
}

export function normalizeStock(value: unknown): string {
  return clean(value, 40);
}

export function requestedVehicleFrom(raw: any): RequestedVehicle {
  const requested: RequestedVehicle = {};
  const year = clean(raw?.year, 4);
  const make = clean(raw?.make);
  const model = clean(raw?.model);
  const trim = clean(raw?.trim);
  const vin = normalizeVin(raw?.vin);
  const stock = normalizeStock(raw?.stock);
  if (/^\d{4}$/.test(year)) requested.year = year;
  if (make) requested.make = make;
  if (model) requested.model = model;
  if (trim) requested.trim = trim;
  if (vin) requested.vin = vin;
  if (stock) requested.stock = stock;
  return requested;
}

export function requestedLabel(requested: RequestedVehicle): string {
  return [requested.year, requested.make, requested.model, requested.trim].filter(Boolean).join(' ');
}

export function requestedKey(requested: RequestedVehicle): string {
  if (requested.vin) return `vin:${requested.vin}`;
  if (requested.stock) return `stock:${requested.stock.toLowerCase()}`;
  if (requested.make || requested.model) {
    return `ymm:${normalizeToken(requested.year)}|${normalizeToken(requested.make)}|${normalizeToken(requested.model)}`;
  }
  return '';
}

export function availabilityOf(vehicle: any): VehicleAvailability {
  if (vehicle?.isArchived === true) return 'archived';
  switch (vehicle?.status) {
    case 'Ready for Sale': return 'listed';
    case 'In Recon': return 'recon';
    case 'In Transit': return 'in_transit';
    case 'Sold': return 'sold';
    default: return 'unknown';
  }
}

export function summarizeVehicle(vehicle: any): InventoryVehicleSummary {
  const photo = Array.isArray(vehicle.images)
    ? vehicle.images.find((url: unknown) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()))
    : undefined;
  const vin = String(vehicle.vin || '');
  const archived = vehicle.isArchived === true;
  const params = new URLSearchParams({ search: vin });
  if (archived) params.set('view', 'archived');
  return {
    id: String(vehicle._id),
    year: typeof vehicle.year === 'number' ? vehicle.year : null,
    make: String(vehicle.make || ''),
    model: String(vehicle.modelName || ''),
    trim: vehicle.trim ? String(vehicle.trim) : null,
    vin,
    stockNumber: vehicle.stockNumber ? String(vehicle.stockNumber) : null,
    mileage: typeof vehicle.mileage === 'number' && vehicle.mileage > 0 ? vehicle.mileage : null,
    price: typeof vehicle.price === 'number' && vehicle.price > 0 ? vehicle.price : null,
    exteriorColor: vehicle.exteriorColor ? String(vehicle.exteriorColor) : null,
    photoUrl: photo ? String(photo).trim() : null,
    status: vehicle.status ? String(vehicle.status) : null,
    availability: availabilityOf(vehicle),
    archivedAt: archived && vehicle.archivedAt ? new Date(vehicle.archivedAt).toISOString() : null,
    inventoryPath: `/inventory?${params.toString()}`,
  };
}

function searchPathFor(requested: RequestedVehicle): string | null {
  if (!requested.make && !requested.model) return null;
  const params = new URLSearchParams();
  if (requested.make) params.set('make', requested.make);
  if (requested.model) params.set('model', requested.model);
  if (requested.year) params.set('year', requested.year);
  return `/inventory?${params.toString()}`;
}

async function findByVin(organizationId: string, vin: string) {
  return Vehicle.find({ organizationId, vin: new RegExp(`^${vin}$`, 'i'), ...NOT_DELETED }).select(VEHICLE_FIELDS).limit(2).lean();
}

async function findByStock(organizationId: string, stock: string) {
  return Vehicle.find({ organizationId, stockNumber: new RegExp(`^${escapeRegex(stock)}$`, 'i'), ...NOT_DELETED })
    .select(VEHICLE_FIELDS)
    .limit(2)
    .lean();
}

async function similarVehicles(organizationId: string, requested: RequestedVehicle): Promise<any[]> {
  const year = parseInt(String(requested.year || ''), 10);
  if (!Number.isFinite(year) || !requested.make || !requested.model) return [];
  const candidates = await Vehicle.find({ organizationId, year, isArchived: { $ne: true }, ...NOT_DELETED })
    .select('_id year make modelName')
    .limit(SIMILAR_CANDIDATE_LIMIT)
    .lean();
  return candidates.filter((candidate: any) => matchesVehicle(requested, candidate));
}

function baseEntry(requested: RequestedVehicle, origin: 'lead' | 'inquiry', receivedAt: Date | null): VehiclePreviewEntry {
  return {
    key: requestedKey(requested),
    origin,
    receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
    label: requestedLabel(requested),
    requested,
    state: 'unconfirmed',
    match: null,
    reason: null,
    similarCount: null,
    searchPath: null,
    vehicle: null,
  };
}

function matched(entry: VehiclePreviewEntry, vehicle: any, match: VehiclePreviewMatch): VehiclePreviewEntry {
  return { ...entry, state: 'matched', match, reason: null, vehicle: summarizeVehicle(vehicle) };
}

async function unconfirmed(organizationId: string, entry: VehiclePreviewEntry, reason: VehiclePreviewReason): Promise<VehiclePreviewEntry> {
  const similar = await similarVehicles(organizationId, entry.requested);
  return { ...entry, state: 'unconfirmed', reason, similarCount: similar.length, searchPath: searchPathFor(entry.requested) };
}

async function resolveByIdentifiers(organizationId: string, entry: VehiclePreviewEntry): Promise<VehiclePreviewEntry | null> {
  const { vin, stock } = entry.requested;
  if (vin) {
    const rows = await findByVin(organizationId, vin);
    if (rows.length === 1) return matched(entry, rows[0], 'vin');
    if (rows.length > 1) return { ...entry, state: 'unconfirmed', reason: 'not_verified', searchPath: searchPathFor(entry.requested) };
    return { ...entry, state: 'not_found', reason: 'vin', searchPath: searchPathFor(entry.requested) };
  }
  if (stock) {
    const rows = await findByStock(organizationId, stock);
    if (rows.length === 1) return matched(entry, rows[0], 'stock');
    if (rows.length > 1) return { ...entry, state: 'unconfirmed', reason: 'duplicate_stock', searchPath: searchPathFor(entry.requested) };
    return { ...entry, state: 'not_found', reason: 'stock', searchPath: searchPathFor(entry.requested) };
  }
  return null;
}

function identifiersAgree(requested: RequestedVehicle, vehicle: any): boolean | null {
  if (requested.vin) return normalizeVin(vehicle.vin) === requested.vin;
  if (requested.stock) return normalizeStock(vehicle.stockNumber).toLowerCase() === requested.stock.toLowerCase();
  return null;
}

async function resolveLeadVehicle(organizationId: string, lead: any): Promise<VehiclePreviewEntry | null> {
  const requested = requestedVehicleFrom(lead.vehicle);
  const entry = baseEntry(requested, 'lead', lead.createdAt || null);
  const linkedId = lead.vehicleId && mongoose.isValidObjectId(String(lead.vehicleId)) ? String(lead.vehicleId) : '';

  if (linkedId) {
    const linked: any = await Vehicle.findOne({ _id: linkedId, organizationId, ...NOT_DELETED }).select(VEHICLE_FIELDS).lean();
    if (linked) {
      const agree = identifiersAgree(requested, linked);
      if (agree === true) return matched(entry, linked, 'linked');
      if (agree === null) {
        const label = entry.label || requestedLabel({ year: String(linked.year || ''), make: linked.make, model: linked.modelName });
        if (DIRECT_LINK_SOURCES.has(String(lead.source || ''))) return matched({ ...entry, label }, linked, 'linked');
        if (requested.make || requested.model) {
          const similar = await similarVehicles(organizationId, requested);
          const linkedFits = matchesVehicle(requested, linked);
          if (linkedFits && similar.length === 1 && String(similar[0]._id) === linkedId) return matched(entry, linked, 'linked');
          return { ...entry, state: 'unconfirmed', reason: 'not_verified', similarCount: similar.length, searchPath: searchPathFor(requested) };
        }
        return { ...entry, state: 'unconfirmed', reason: 'not_verified', similarCount: null, searchPath: null };
      }
    }
  }

  const byIdentifiers = await resolveByIdentifiers(organizationId, entry);
  if (byIdentifiers) return byIdentifiers;
  if (linkedId) return { ...entry, state: 'not_found', reason: 'linked', searchPath: searchPathFor(requested) };
  if (!entry.key) return null;
  return unconfirmed(organizationId, entry, 'no_identifier');
}

async function resolveInquiryVehicles(organizationId: string, lead: any, primary: VehiclePreviewEntry | null): Promise<VehiclePreviewEntry[]> {
  const inquiries: any[] = await LeadInquiry.find({
    organizationId,
    'association.leadId': lead._id,
    'association.state': 'associated',
  })
    .select('vehicle receivedAt')
    .sort({ receivedAt: 1 })
    .limit(MAX_INQUIRIES)
    .lean();

  const seen = new Set<string>();
  if (primary?.key) seen.add(primary.key);
  if (primary?.vehicle?.vin) seen.add(`vin:${normalizeVin(primary.vehicle.vin)}`);
  if (primary?.vehicle?.stockNumber) seen.add(`stock:${normalizeStock(primary.vehicle.stockNumber).toLowerCase()}`);

  const others: VehiclePreviewEntry[] = [];
  for (const inquiry of inquiries) {
    if (others.length >= MAX_OTHERS) break;
    const requested = requestedVehicleFrom(inquiry.vehicle);
    const entry = baseEntry(requested, 'inquiry', inquiry.receivedAt || null);
    if (!entry.key || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const resolved = (await resolveByIdentifiers(organizationId, entry)) || (await unconfirmed(organizationId, entry, 'no_identifier'));
    if (resolved.vehicle?.vin) {
      const vinKey = `vin:${normalizeVin(resolved.vehicle.vin)}`;
      if (vinKey !== entry.key && seen.has(vinKey)) continue;
      seen.add(vinKey);
    }
    others.push(resolved);
  }
  return others;
}

export async function getLeadVehiclePreview(organizationId: unknown, leadId: unknown): Promise<LeadVehiclePreview> {
  const orgId = String(organizationId || '');
  const id = String(leadId || '');
  if (!mongoose.isValidObjectId(orgId) || !mongoose.isValidObjectId(id)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: id, organizationId: orgId }).select('vehicle vehicleId source createdAt').lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  const primary = await resolveLeadVehicle(orgId, lead);
  const others = await resolveInquiryVehicles(orgId, lead, primary);
  return { leadId: id, primary, others };
}
