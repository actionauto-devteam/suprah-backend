import mongoose from 'mongoose';
import Customer from '../models/Customer.model';
import Lead from '../models/lead.model';
import Appointment from '../models/Appointment.model';
import { CallLog, CommunicationMessage } from '../models/communication.model';
import { TERMINAL_LEAD_STATUSES } from '../constants/leadStatus';
import { normalizeLeadSourceForDisplay } from '../constants/leadSource';
import customerService from './customer.service';
import { countAdditionalInquiries, findReturningVisits, inventoryStatusFor, inventoryStatusOf, isSoldStatus, soldStatusDate } from './customerLifecycle.service';
import { ApiError } from '../utils/ApiError';
import { cleanSearchText, phoneSearchDigits } from '../utils/searchText';

export type CustomerRecordStatusFilter = 'active' | 'inactive' | 'all';
export type CustomerRecordSort = 'recent' | 'name' | 'newest';

export interface CustomerRecordsQuery {
  search?: unknown;
  status?: unknown;
  sort?: unknown;
  page?: unknown;
  limit?: unknown;
}

const LINKED = 'linked';
const CONTACT_FIELDS = 'firstName lastName email phone alternatePhone normalizedEmail normalizedPhone normalizedAlternatePhone address source sourceLeadId isActive createdAt updatedAt stats.firstContactedAt stats.lastContactedAt';
const PROFILE_FIELDS = `${CONTACT_FIELDS} notes preferredContactMethod vehicleInterest`;
const UPCOMING_STATUSES = ['scheduled', 'confirmed'];
const CONTACT_METHODS = ['email', 'phone', 'sms'];
const LIMITS = { name: 80, contact: 120, notes: 2000, street: 160, city: 80, state: 40, postalCode: 20 };

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const orgObjectId = (orgId: string) => new mongoose.Types.ObjectId(orgId);
const orgIdValues = (orgId: string) => [orgId, orgObjectId(orgId)];
const isTerminal = (status: unknown) => TERMINAL_LEAD_STATUSES.includes(String(status || ''));

const toInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const latest = (...values: Array<Date | string | null | undefined>) => {
  const times = values.map((value) => (value ? new Date(value).getTime() : 0)).filter((time) => Number.isFinite(time) && time > 0);
  return times.length ? new Date(Math.max(...times)) : null;
};

const earliest = (...values: Array<Date | string | null | undefined>) => {
  const times = values.map((value) => (value ? new Date(value).getTime() : 0)).filter((time) => Number.isFinite(time) && time > 0);
  return times.length ? new Date(Math.min(...times)) : null;
};

export function buildCustomerSearch(raw: unknown): Record<string, unknown> | null {
  const search = cleanSearchText(raw, 80);
  if (!search) return null;
  if (search.includes('@')) return { normalizedEmail: { $regex: escapeRegex(search.toLowerCase()) } };
  const digits = phoneSearchDigits(search);
  if (digits) {
    const pattern = escapeRegex(digits);
    return { $or: [{ normalizedPhone: { $regex: pattern } }, { normalizedAlternatePhone: { $regex: pattern } }] };
  }
  const tokens = search.split(/\s+/).filter(Boolean).slice(0, 4);
  return {
    $and: tokens.map((token) => {
      const pattern = new RegExp(escapeRegex(token), 'i');
      return { $or: [{ firstName: pattern }, { lastName: pattern }, { normalizedEmail: { $regex: escapeRegex(token.toLowerCase()) } }] };
    }),
  };
}

const formatAddress = (address: any) => {
  if (!address) return '';
  const stateZip = [address.state, address.postalCode].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  return [address.street, address.city, stateZip].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
};

const vehicleKey = (vehicle: any) => {
  const vin = String(vehicle?.vin || '').trim().toUpperCase();
  if (vin) return `vin:${vin}`;
  return modelKey(vehicle);
};

const modelKey = (vehicle: any) => {
  const parts = [vehicle?.year, vehicle?.make, vehicle?.model].map((part) => String(part || '').trim().toLowerCase());
  return parts.some(Boolean) ? `ymm:${parts.join('|')}` : '';
};

const contactSummary = (customer: any) => ({
  email: customer.normalizedEmail || customer.email || '',
  phone: customer.normalizedPhone ? customer.phone || customer.normalizedPhone : customer.phone || '',
  alternatePhone: customer.normalizedAlternatePhone ? customer.alternatePhone || customer.normalizedAlternatePhone : customer.alternatePhone || '',
  hasValidEmail: Boolean(customer.normalizedEmail),
  hasValidPhone: Boolean(customer.normalizedPhone),
});

async function linkedLeadSummaries(orgId: string, customerIds: mongoose.Types.ObjectId[]) {
  const summaries = new Map<string, { total: number; closed: number; lastActivity: Date | null; vehicles: number }>();
  if (!customerIds.length) return summaries;
  const rows = await Lead.aggregate([
    { $match: { organizationId: orgObjectId(orgId), customerId: { $in: customerIds }, 'customerLink.status': LINKED } },
    {
      $group: {
        _id: '$customerId',
        total: { $sum: 1 },
        closed: { $sum: { $cond: [{ $in: ['$status', TERMINAL_LEAD_STATUSES] }, 1, 0] } },
        lastActivity: { $max: { $ifNull: ['$followUp.lastCustomerActivityAt', '$createdAt'] } },
        vehicles: { $addToSet: { vin: '$vehicle.vin', year: '$vehicle.year', make: '$vehicle.make', model: '$vehicle.model' } },
      },
    },
  ]).option({ maxTimeMS: 5000 });
  for (const row of rows) {
    const keys = new Set((row.vehicles || []).map(vehicleKey).filter(Boolean));
    summaries.set(String(row._id), { total: row.total, closed: row.closed, lastActivity: row.lastActivity || null, vehicles: keys.size });
  }
  return summaries;
}

async function recentCustomerPage(orgId: string, filter: Record<string, unknown>, skip: number, limit: number): Promise<any[]> {
  const projection = Object.fromEntries(CONTACT_FIELDS.split(' ').filter(Boolean).map((field) => [field, 1]));
  return Customer.aggregate([
    { $match: filter },
    {
      $lookup: {
        from: Lead.collection.name,
        localField: '_id',
        foreignField: 'customerId',
        pipeline: [
          { $match: { organizationId: orgObjectId(orgId), 'customerLink.status': LINKED } },
          { $group: { _id: null, at: { $max: { $ifNull: ['$followUp.lastCustomerActivityAt', '$createdAt'] } } } },
        ],
        as: 'leadActivity',
      },
    },
    {
      $addFields: {
        recentActivityAt: {
          $ifNull: [{ $arrayElemAt: ['$leadActivity.at', 0] }, { $ifNull: ['$stats.lastContactedAt', '$createdAt'] }],
        },
      },
    },
    { $sort: { recentActivityAt: -1, _id: -1 } },
    { $skip: skip },
    { $limit: limit },
    { $project: projection },
  ]).option({ maxTimeMS: 5000 });
}

export async function listCustomerRecords(orgId: string, query: CustomerRecordsQuery) {
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const page = toInt(query.page, 1, 1, 100000);
  const limit = toInt(query.limit, 25, 1, 50);
  const status: CustomerRecordStatusFilter = ['active', 'inactive', 'all'].includes(String(query.status)) ? (query.status as CustomerRecordStatusFilter) : 'active';
  const sortKey: CustomerRecordSort = ['recent', 'name', 'newest'].includes(String(query.sort)) ? (query.sort as CustomerRecordSort) : 'recent';
  const filter: Record<string, unknown> = { organizationId: orgId };
  if (status === 'active') filter.isActive = { $ne: false };
  if (status === 'inactive') filter.isActive = false;
  const search = buildCustomerSearch(query.search);
  if (search) filter.$and = [search];
  const sort: Record<string, 1 | -1> = sortKey === 'name'
    ? { lastName: 1, firstName: 1, _id: 1 }
    : { createdAt: -1, _id: -1 };
  const skip = (page - 1) * limit;
  const [total, customers] = await Promise.all([
    Customer.countDocuments(filter).maxTimeMS(5000),
    sortKey === 'recent'
      ? recentCustomerPage(orgId, filter, skip, limit)
      : Customer.find(filter).select(CONTACT_FIELDS).sort(sort).skip(skip).limit(limit).maxTimeMS(5000).lean().exec(),
  ]);
  const summaries = await linkedLeadSummaries(orgId, customers.map((customer: any) => customer._id));
  return {
    customers: customers.map((customer: any) => {
      const summary = summaries.get(String(customer._id));
      return {
        id: String(customer._id),
        firstName: customer.firstName,
        lastName: customer.lastName || '',
        ...contactSummary(customer),
        city: String(customer.address?.city || '').trim(),
        state: String(customer.address?.state || '').trim(),
        source: customer.source || 'manual',
        isActive: customer.isActive !== false,
        createdAt: customer.createdAt,
        leads: { total: summary?.total || 0, open: (summary?.total || 0) - (summary?.closed || 0), closed: summary?.closed || 0 },
        vehiclesOfInterest: summary?.vehicles || 0,
        lastActivity: summary?.lastActivity || null,
      };
    }),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    status,
    sort: sortKey,
  };
}

export async function getCustomerProfile(orgId: string, id: string) {
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Customer not found');
  const customer: any = await Customer.findOne({ _id: id, organizationId: orgId }).select(PROFILE_FIELDS).maxTimeMS(5000).lean();
  if (!customer) throw new ApiError(404, 'Customer not found');

  const leads: any[] = await Lead.find({ organizationId: orgObjectId(orgId), customerId: customer._id, 'customerLink.status': LINKED })
    .select('firstName lastName status source sourceProvider channel createdAt updatedAt vehicle vehicleId statusHistory followUp.lastCustomerActivityAt assignedTo location notes._id')
    .populate('assignedTo', 'name')
    .sort({ createdAt: -1 })
    .limit(200)
    .maxTimeMS(5000)
    .lean();
  const leadIds = leads.map((lead) => lead._id);
  const now = Date.now();

  const [appointments, messageRows, calls, reviewCount, additionalInquiries, inventory] = await Promise.all([
    leadIds.length
      ? Appointment.find({ organizationId: orgId, leadId: { $in: leadIds }, entryType: { $in: ['appointment', null] } })
        .select('title type status startTime endTime leadId')
        .sort({ startTime: -1 }).limit(100).maxTimeMS(5000).lean()
      : Promise.resolve([] as any[]),
    leadIds.length
      ? CommunicationMessage.aggregate([
        { $match: { orgId: { $in: orgIdValues(orgId) }, leadId: { $in: leadIds }, origin: { $ne: 'inquiry' } } },
        { $group: { _id: '$direction', count: { $sum: 1 }, last: { $max: '$createdAt' } } },
      ]).option({ maxTimeMS: 5000 })
      : Promise.resolve([] as any[]),
    leadIds.length
      ? CallLog.countDocuments({ orgId: { $in: orgIdValues(orgId) }, leadId: { $in: leadIds } }).maxTimeMS(3000).catch(() => null)
      : Promise.resolve(0),
    Lead.countDocuments({ organizationId: orgObjectId(orgId), 'customerLink.candidateIds': customer._id, 'customerLink.status': { $in: ['ambiguous', 'conflict'] } })
      .maxTimeMS(3000).catch(() => null),
    countAdditionalInquiries(orgId, leadIds),
    inventoryStatusFor(orgId, leads),
  ]);

  const inbound = messageRows.find((row: any) => row._id === 'inbound');
  const outbound = messageRows.find((row: any) => row._id === 'outbound');
  const relatedLeads = leads.map((lead) => {
    const source = normalizeLeadSourceForDisplay({ source: lead.source, sourceProvider: lead.sourceProvider, channel: lead.channel });
    return {
      id: String(lead._id),
      name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
      status: lead.status || 'New',
      closed: isTerminal(lead.status),
      source: source.source,
      sourceProvider: source.sourceProvider || '',
      channel: lead.channel || '',
      vehicle: [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model].filter(Boolean).join(' '),
      assignedTo: lead.assignedTo && typeof lead.assignedTo === 'object' ? lead.assignedTo.name || '' : '',
      location: lead.location || '',
      createdAt: lead.createdAt,
      lastActivity: latest(lead.followUp?.lastCustomerActivityAt, lead.createdAt),
    };
  });

  const interest = new Map<string, any>();
  const seenModels = new Set<string>();
  for (const lead of leads) {
    const key = vehicleKey(lead.vehicle);
    const model = modelKey(lead.vehicle);
    if (model) seenModels.add(model);
    if (!key || interest.has(key)) continue;
    interest.set(key, {
      year: String(lead.vehicle?.year || ''),
      make: String(lead.vehicle?.make || ''),
      model: String(lead.vehicle?.model || ''),
      trim: String(lead.vehicle?.trim || ''),
      vin: String(lead.vehicle?.vin || '').toUpperCase(),
      stock: String(lead.vehicle?.stock || ''),
      leadId: String(lead._id),
      askedAt: lead.createdAt,
      leadStatus: lead.status || 'New',
      inventoryStatus: inventoryStatusOf(inventory, lead),
    });
  }
  const recordKey = vehicleKey(customer.vehicleInterest);
  const recordModel = modelKey(customer.vehicleInterest);
  const recordVin = String(customer.vehicleInterest?.vin || '').trim().toUpperCase();
  if (recordKey && !interest.has(recordKey) && !(recordModel && seenModels.has(recordModel) && !recordVin)) {
    interest.set(recordKey, {
      year: String(customer.vehicleInterest?.year || ''),
      make: String(customer.vehicleInterest?.make || ''),
      model: String(customer.vehicleInterest?.model || ''),
      trim: String(customer.vehicleInterest?.trim || ''),
      vin: String(customer.vehicleInterest?.vin || '').toUpperCase(),
      stock: '',
      leadId: null,
      askedAt: null,
      leadStatus: null,
      inventoryStatus: null,
    });
  }

  const appointmentList = (appointments as any[]).map((appointment) => ({
    id: String(appointment._id),
    title: appointment.title || 'Appointment',
    type: appointment.type || '',
    status: appointment.status || 'scheduled',
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    leadId: appointment.leadId ? String(appointment.leadId) : null,
    upcoming: UPCOMING_STATUSES.includes(appointment.status) && new Date(appointment.startTime).getTime() >= now,
  }));

  const closedLeads = relatedLeads.filter((lead) => lead.closed).length;
  const returningVisits = findReturningVisits(leads);
  const latestReturn = returningVisits[returningVisits.length - 1];
  const leadsMarkedSold = leads
    .filter((lead) => isSoldStatus(lead.status))
    .map((lead) => ({
      leadId: String(lead._id),
      status: lead.status,
      vehicle: [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model].filter(Boolean).join(' '),
      markedAt: soldStatusDate(lead),
    }));
  const sourceLeadLinked = Boolean(customer.sourceLeadId && leadIds.some((leadId) => String(leadId) === String(customer.sourceLeadId)));

  return {
    customer: {
      id: String(customer._id),
      firstName: customer.firstName,
      lastName: customer.lastName || '',
      ...contactSummary(customer),
      address: {
        street: String(customer.address?.street || ''),
        city: String(customer.address?.city || ''),
        state: String(customer.address?.state || ''),
        postalCode: String(customer.address?.postalCode || ''),
      },
      addressText: formatAddress(customer.address),
      notes: customer.notes || '',
      preferredContactMethod: customer.preferredContactMethod || null,
      source: customer.source || 'manual',
      sourceLeadId: sourceLeadLinked ? String(customer.sourceLeadId) : null,
      isActive: customer.isActive !== false,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    },
    relatedLeads,
    vehicles: {
      interest: [...interest.values()],
      owned: [],
      ownedAvailable: false,
    },
    purchases: { available: false, verified: [], leadsMarkedSold },
    appointments: appointmentList,
    service: { available: false, records: [] },
    summary: {
      leads: { total: relatedLeads.length, open: relatedLeads.length - closedLeads, closed: closedLeads },
      appointments: {
        total: appointmentList.length,
        upcoming: appointmentList.filter((appointment) => appointment.upcoming).length,
        completed: appointmentList.filter((appointment) => appointment.status === 'completed').length,
      },
      texts: { received: inbound?.count || 0, sent: outbound?.count || 0 },
      calls,
      notes: leads.reduce((sum, lead) => sum + (Array.isArray(lead.notes) ? lead.notes.length : 0), 0),
      vehiclesOfInterest: interest.size,
      verifiedVehicles: null,
      firstContact: earliest(...leads.map((lead) => lead.createdAt)),
      lastActivity: latest(...relatedLeads.map((lead) => lead.lastActivity), inbound?.last),
      leadsNeedingReview: reviewCount,
      additionalInquiries,
      returning: latestReturn
        ? {
          count: returningVisits.length,
          latest: {
            leadId: latestReturn.leadId,
            at: latestReturn.at,
            previousLeadId: latestReturn.previousLeadId,
            previousStatus: latestReturn.previousStatus,
            previousClosedAt: latestReturn.previousClosedAt,
          },
        }
        : null,
      verifiedPurchases: null,
      ownedVehicles: null,
      serviceVisits: null,
    },
  };
}

const cleanText = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export async function updateCustomerRecord(orgId: string, id: string, body: Record<string, unknown>, userId: string) {
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Customer not found');
  const input = body || {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const data: Record<string, unknown> = {};
  if (has('firstName')) {
    const firstName = cleanText(input.firstName, LIMITS.name);
    if (!firstName) throw new ApiError(400, 'First name is required');
    data.firstName = firstName;
  }
  if (has('lastName')) data.lastName = cleanText(input.lastName, LIMITS.name);
  for (const key of ['email', 'phone', 'alternatePhone']) {
    if (has(key)) data[key] = cleanText(input[key], LIMITS.contact);
  }
  if (has('notes')) data.notes = String(input.notes ?? '').replace(/\u0000/g, '').trim().slice(0, LIMITS.notes);
  if (has('preferredContactMethod')) {
    const method = String(input.preferredContactMethod ?? '');
    if (!CONTACT_METHODS.includes(method)) throw new ApiError(400, 'Choose email, phone, or text as the preferred contact method');
    data.preferredContactMethod = method;
  }
  if (has('address')) {
    const address = (input.address && typeof input.address === 'object' ? input.address : {}) as Record<string, unknown>;
    data.address = {
      street: cleanText(address.street, LIMITS.street),
      city: cleanText(address.city, LIMITS.city),
      state: cleanText(address.state, LIMITS.state),
      postalCode: cleanText(address.postalCode, LIMITS.postalCode),
    };
  }
  if (!Object.keys(data).length) throw new ApiError(400, 'No editable customer details were provided');
  const updated = await customerService.updateCustomer(id, orgId, { ...(data as any), updatedBy: userId });
  if (!updated) throw new ApiError(404, 'Customer not found');
  return getCustomerProfile(orgId, id);
}
