import crypto from 'crypto';
import mongoose from 'mongoose';
import CustomerPurchase, { PurchaseSource, PurchaseVehicle } from '../models/CustomerPurchase.model';
import Customer from '../models/Customer.model';
import Lead from '../models/lead.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import { CrmStaff, isManagerOrAdmin, listStaffTeam, orgIdVariants, requireTeamMember, staffName } from '../utils/crmStaff';
import { matchableIdentityEmail, matchableIdentityPhone } from '../utils/contactIdentity';
import logger from '../utils/logger';

export const PURCHASE_SOURCE_LABELS: Record<PurchaseSource, string> = {
  deal: 'Deal won',
  lead_sold: 'Lead marked Sold',
  manual: 'Added by staff',
  import: 'Imported',
};

const MAX_PRICE = 10_000_000;
const MAX_NOTES = 1000;
const MAX_IMPORT_ROWS = 2000;
const MAX_PROBLEMS = 50;

type Actor = { userId: string; name: string };

function text(value: unknown, max = 160): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '';
}

function vehicleFromLead(lead: any): PurchaseVehicle {
  const vehicle = lead?.vehicle || {};
  return {
    vehicleId: lead?.vehicleId || null,
    label: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ').slice(0, 160),
    year: text(vehicle.year, 10),
    make: text(vehicle.make, 60),
    model: text(vehicle.model, 60),
    trim: text(vehicle.trim, 60),
    vin: text(vehicle.vin, 40).toUpperCase(),
    stock: text(vehicle.stock, 40),
  };
}

function vehicleLabel(vehicle: any): string {
  return String(vehicle?.label || [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' ') || 'Vehicle');
}

function serialize(doc: any) {
  return {
    id: String(doc._id),
    customerId: doc.customerId ? String(doc.customerId) : null,
    leadId: doc.leadId ? String(doc.leadId) : null,
    dealId: doc.dealId ? String(doc.dealId) : null,
    vehicle: {
      label: vehicleLabel(doc.vehicle),
      year: doc.vehicle?.year || '',
      make: doc.vehicle?.make || '',
      model: doc.vehicle?.model || '',
      trim: doc.vehicle?.trim || '',
      vin: doc.vehicle?.vin || '',
      stock: doc.vehicle?.stock || '',
    },
    salePrice: doc.salePrice ?? null,
    soldAt: doc.soldAt,
    salesperson: { id: doc.salespersonId ? String(doc.salespersonId) : null, name: doc.salespersonName || '' },
    source: doc.source,
    sourceLabel: PURCHASE_SOURCE_LABELS[doc.source as PurchaseSource] || doc.source,
    notes: doc.notes || '',
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function memberName(orgId: string, userId: unknown): Promise<string> {
  if (!userId || !mongoose.isValidObjectId(String(userId))) return '';
  const user: any = await User.findOne({ _id: userId, organizationId: { $in: orgIdVariants(orgId) } }).select('name email').lean();
  return user ? staffName(user) : '';
}

export async function recordPurchaseFromDeal(orgId: string, deal: any, actor: Actor): Promise<void> {
  if (!deal?.leadId) return;
  const lead: any = await Lead.findOne({ _id: deal.leadId, organizationId: { $in: orgIdVariants(orgId) } }).select('customerId vehicle vehicleId').lean();
  const fromLead = vehicleFromLead(lead);
  const vehicle: PurchaseVehicle = {
    ...fromLead,
    vehicleId: deal.vehicle?.vehicleId || fromLead.vehicleId,
    label: text(deal.vehicle?.label) || fromLead.label,
    vin: text(deal.vehicle?.vin, 40).toUpperCase() || fromLead.vin,
    stock: text(deal.vehicle?.stock, 40) || fromLead.stock,
  };
  const fields = {
    customerId: lead?.customerId || deal.customerId || null,
    leadId: deal.leadId,
    vehicle,
    salePrice: typeof deal.amount === 'number' ? deal.amount : null,
    soldAt: deal.wonAt || new Date(),
    salespersonId: deal.assignedTo || null,
    salespersonName: deal.assignedName || '',
  };
  const fromLeadSold = await CustomerPurchase.findOne({ organizationId: orgId, leadId: deal.leadId, dealId: null, source: 'lead_sold' });
  if (fromLeadSold) {
    fromLeadSold.set({ ...fields, dealId: deal._id, source: 'deal' });
    await fromLeadSold.save();
    return;
  }
  try {
    await CustomerPurchase.updateOne(
      { organizationId: orgId, dealId: deal._id },
      { $set: fields, $setOnInsert: { source: 'deal', notes: '', importKey: null, createdBy: actor } },
      { upsert: true },
    );
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }
}

export async function removeDealPurchase(orgId: string, dealId: unknown): Promise<void> {
  if (!dealId) return;
  await CustomerPurchase.deleteOne({ organizationId: orgId, dealId, source: 'deal' });
}

export async function recordPurchaseFromSoldLead(orgId: string, leadId: unknown, actor: Actor): Promise<void> {
  if (!leadId || !mongoose.isValidObjectId(String(leadId))) return;
  if (await CustomerPurchase.exists({ organizationId: orgId, leadId })) return;
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: { $in: orgIdVariants(orgId) } }).select('customerId vehicle vehicleId assignedTo status').lean();
  if (!lead || lead.status !== 'Sold') return;
  await CustomerPurchase.create({
    organizationId: orgId,
    customerId: lead.customerId || null,
    leadId: lead._id,
    dealId: null,
    vehicle: vehicleFromLead(lead),
    salePrice: null,
    soldAt: new Date(),
    salespersonId: lead.assignedTo || null,
    salespersonName: await memberName(orgId, lead.assignedTo),
    source: 'lead_sold',
    notes: '',
    importKey: null,
    createdBy: actor,
  });
}

export function recordPurchaseFromSoldLeadSafely(orgId: string, leadId: unknown, actor: Actor): void {
  recordPurchaseFromSoldLead(orgId, leadId, actor).catch((err) => logger.warn({ err, leadId: String(leadId) }, '[Purchases] Sold lead purchase was not recorded'));
}

async function loadCustomer(orgId: string, customerId: string) {
  if (!mongoose.isValidObjectId(customerId)) throw new ApiError(404, 'Customer not found');
  const customer = await Customer.findOne({ _id: customerId, organizationId: orgId }).select('_id').lean();
  if (!customer) throw new ApiError(404, 'Customer not found');
  return customer;
}

function cleanPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const price = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) throw new ApiError(400, `The sale price must be between $0 and $${MAX_PRICE.toLocaleString('en-US')}`);
  return Math.round(price * 100) / 100;
}

function cleanSoldDate(value: unknown): Date {
  const raw = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ApiError(400, 'Pick the date of the sale');
  const date = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new ApiError(400, 'Pick a valid date of the sale');
  return date;
}

function cleanVehicle(body: any): PurchaseVehicle {
  const vehicle = {
    vehicleId: null,
    label: text(body?.label),
    year: text(body?.year, 10),
    make: text(body?.make, 60),
    model: text(body?.model, 60),
    trim: text(body?.trim, 60),
    vin: text(body?.vin, 40).toUpperCase(),
    stock: text(body?.stock, 40),
  };
  if (!vehicle.label) vehicle.label = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
  if (!vehicle.label && !vehicle.vin && !vehicle.stock) throw new ApiError(400, 'Enter the vehicle, its VIN or its stock number');
  return vehicle;
}

async function cleanLeadForCustomer(orgId: string, customerId: string, leadId: unknown): Promise<mongoose.Types.ObjectId | null> {
  if (!leadId) return null;
  if (!mongoose.isValidObjectId(String(leadId))) throw new ApiError(400, 'That lead is not valid');
  const lead = await Lead.exists({ _id: leadId, organizationId: { $in: orgIdVariants(orgId) }, customerId });
  if (!lead) throw new ApiError(400, 'That lead does not belong to this customer');
  return new mongoose.Types.ObjectId(String(leadId));
}

function requireEditor(staff: CrmStaff, doc: any) {
  if (isManagerOrAdmin(staff) || doc.createdBy?.userId === staff.actorId) return;
  throw new ApiError(403, 'Only managers, admins and the person who added this purchase can change it');
}

export async function listCustomerPurchases(orgId: string, customerId: string) {
  await loadCustomer(orgId, customerId);
  const leads = await Lead.find({ organizationId: { $in: orgIdVariants(orgId) }, customerId }).select('_id').lean();
  const [docs, team] = await Promise.all([
    CustomerPurchase.find({
      organizationId: orgId,
      $or: [{ customerId: new mongoose.Types.ObjectId(customerId) }, { leadId: { $in: leads.map((lead: any) => lead._id) } }],
    })
      .sort({ soldAt: -1 })
      .limit(200)
      .lean(),
    listStaffTeam(orgId),
  ]);
  return { items: docs.map(serialize), team };
}

export async function createPurchase(orgId: string, customerId: string, staff: CrmStaff, body: any) {
  await loadCustomer(orgId, customerId);
  const vehicle = cleanVehicle(body?.vehicle || {});
  const salePrice = cleanPrice(body?.salePrice);
  const soldAt = cleanSoldDate(body?.soldAt);
  const salesperson = await requireTeamMember(orgId, body?.salespersonId);
  const leadId = await cleanLeadForCustomer(orgId, customerId, body?.leadId);
  const notes = text(body?.notes, MAX_NOTES);
  const doc = await CustomerPurchase.create({
    organizationId: orgId,
    customerId,
    leadId,
    dealId: null,
    vehicle,
    salePrice,
    soldAt,
    salespersonId: salesperson?.id || null,
    salespersonName: salesperson?.name || '',
    source: 'manual',
    notes,
    importKey: null,
    createdBy: { userId: staff.actorId, name: staff.name },
  });
  return serialize(doc.toObject());
}

async function loadPurchase(orgId: string, customerId: string, purchaseId: string) {
  await loadCustomer(orgId, customerId);
  if (!mongoose.isValidObjectId(purchaseId)) throw new ApiError(404, 'Purchase not found');
  const leads = await Lead.find({ organizationId: { $in: orgIdVariants(orgId) }, customerId }).select('_id').lean();
  const doc = await CustomerPurchase.findOne({
    _id: purchaseId,
    organizationId: orgId,
    $or: [{ customerId: new mongoose.Types.ObjectId(customerId) }, { leadId: { $in: leads.map((lead: any) => lead._id) } }],
  });
  if (!doc) throw new ApiError(404, 'Purchase not found');
  return doc;
}

export async function updatePurchase(orgId: string, customerId: string, purchaseId: string, staff: CrmStaff, body: any) {
  const doc = await loadPurchase(orgId, customerId, purchaseId);
  requireEditor(staff, doc);
  if (body?.vehicle !== undefined) doc.vehicle = { ...cleanVehicle(body.vehicle), vehicleId: doc.vehicle?.vehicleId || null } as any;
  if (body?.salePrice !== undefined) doc.salePrice = cleanPrice(body.salePrice);
  if (body?.soldAt !== undefined) doc.soldAt = cleanSoldDate(body.soldAt);
  if (body?.salespersonId !== undefined) {
    const salesperson = await requireTeamMember(orgId, body.salespersonId);
    doc.salespersonId = salesperson?.id || null;
    doc.salespersonName = salesperson?.name || '';
  }
  if (body?.notes !== undefined) doc.notes = text(body.notes, MAX_NOTES);
  if (!doc.customerId) doc.customerId = new mongoose.Types.ObjectId(customerId);
  await doc.save();
  return serialize(doc.toObject());
}

export async function deletePurchase(orgId: string, customerId: string, purchaseId: string, staff: CrmStaff) {
  const doc = await loadPurchase(orgId, customerId, purchaseId);
  requireEditor(staff, doc);
  await doc.deleteOne();
}

function parseImportDate(value: unknown): Date | null {
  const raw = text(value, 40);
  if (!raw) return null;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (match) return safeDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(raw);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return safeDate(year, Number(match[1]), Number(match[2]));
  }
  return null;
}

function safeDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export async function importPurchases(orgId: string, staff: CrmStaff, rows: unknown) {
  if (staff.role !== 'admin') throw new ApiError(403, 'Only admins can import sales');
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(400, 'The file has no sales to import');
  if (rows.length > MAX_IMPORT_ROWS) throw new ApiError(400, `Send up to ${MAX_IMPORT_ROWS} rows at a time`);

  const parsed = rows.map((raw: any, index: number) => ({
    row: Number(raw?.row) || index + 1,
    email: matchableIdentityEmail(raw?.email),
    phone: matchableIdentityPhone(raw?.phone),
    vehicle: {
      vehicleId: null,
      label: '',
      year: text(raw?.year, 10),
      make: text(raw?.make, 60),
      model: text(raw?.model, 60),
      trim: text(raw?.trim, 60),
      vin: text(raw?.vin, 40).toUpperCase(),
      stock: text(raw?.stock, 40),
    } as PurchaseVehicle,
    soldAt: parseImportDate(raw?.soldAt),
    price: raw?.salePrice,
    salesperson: text(raw?.salesperson, 120),
    notes: text(raw?.notes, MAX_NOTES),
  }));

  const emails = Array.from(new Set(parsed.map((row) => row.email).filter(Boolean))) as string[];
  const phones = Array.from(new Set(parsed.map((row) => row.phone).filter(Boolean))) as string[];
  const customers = emails.length || phones.length
    ? await Customer.find({
        organizationId: orgId,
        $or: [
          ...(emails.length ? [{ normalizedEmail: { $in: emails } }] : []),
          ...(phones.length ? [{ normalizedPhone: { $in: phones } }, { normalizedAlternatePhone: { $in: phones } }] : []),
        ],
      }).select('_id normalizedEmail normalizedPhone normalizedAlternatePhone').lean()
    : [];
  const team = await listStaffTeam(orgId);
  const teamByName = new Map(team.map((member) => [member.name.trim().toLowerCase(), member]));

  const result = { added: 0, duplicates: 0, unmatched: 0, invalid: 0, problems: [] as Array<{ row: number; reason: string }> };
  const problem = (row: number, reason: string) => {
    if (result.problems.length < MAX_PROBLEMS) result.problems.push({ row, reason });
  };

  for (const row of parsed) {
    row.vehicle.label = [row.vehicle.year, row.vehicle.make, row.vehicle.model].filter(Boolean).join(' ');
    if (!row.vehicle.vin && !row.vehicle.stock && !row.vehicle.label) {
      result.invalid += 1;
      problem(row.row, 'No vehicle, VIN or stock number');
      continue;
    }
    if (!row.soldAt) {
      result.invalid += 1;
      problem(row.row, 'The sale date is missing or not a date');
      continue;
    }
    let salePrice: number | null;
    try {
      salePrice = cleanPrice(row.price);
    } catch {
      result.invalid += 1;
      problem(row.row, 'The sale price is not a number');
      continue;
    }
    const matches = customers.filter((customer: any) =>
      (row.email && customer.normalizedEmail === row.email)
      || (row.phone && (customer.normalizedPhone === row.phone || customer.normalizedAlternatePhone === row.phone)));
    const ids = Array.from(new Set(matches.map((customer: any) => String(customer._id))));
    if (ids.length !== 1) {
      result.unmatched += 1;
      problem(row.row, ids.length ? 'The phone and email match more than one customer' : 'No customer record has this phone or email');
      continue;
    }
    const customerId = ids[0];
    const vehicleKey = row.vehicle.vin || row.vehicle.stock || row.vehicle.label.toLowerCase();
    const importKey = crypto.createHash('sha256').update(`${customerId}|${vehicleKey}|${row.soldAt.toISOString().slice(0, 10)}`).digest('hex');
    const member = row.salesperson ? teamByName.get(row.salesperson.toLowerCase()) : null;
    try {
      const outcome = await CustomerPurchase.updateOne(
        { organizationId: orgId, importKey },
        {
          $setOnInsert: {
            organizationId: orgId,
            customerId: new mongoose.Types.ObjectId(customerId),
            leadId: null,
            dealId: null,
            vehicle: row.vehicle,
            salePrice,
            soldAt: row.soldAt,
            salespersonId: member ? new mongoose.Types.ObjectId(member.id) : null,
            salespersonName: member?.name || row.salesperson,
            source: 'import',
            notes: row.notes,
            importKey,
            createdBy: { userId: staff.actorId, name: staff.name },
          },
        },
        { upsert: true },
      );
      if (outcome.upsertedCount) result.added += 1;
      else result.duplicates += 1;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      result.duplicates += 1;
    }
  }
  return result;
}
