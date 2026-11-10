import mongoose from 'mongoose';
import Customer from '../models/Customer.model';
import Lead from '../models/lead.model';
import CustomerSupportRequest, {
  SUPPORT_REQUEST_STATUSES,
  SUPPORT_REQUEST_TYPES,
  SupportHistoryEntry,
  SupportRequestStatus,
  SupportRequestType,
} from '../models/CustomerSupportRequest.model';
import { ApiError } from '../utils/ApiError';
import { CrmStaff, listStaffTeam, orgIdVariants, requireTeamMember } from '../utils/crmStaff';
import { notifyUsers } from '../utils/safeNotification';
import logger from '../utils/logger';

export const SUPPORT_TYPE_LABELS: Record<SupportRequestType, string> = {
  vehicle_problem: 'Vehicle problem',
  paperwork: 'Paperwork or title',
  warranty: 'Warranty',
  payment: 'Payment or billing',
  other: 'Other',
};

export const SUPPORT_STATUS_LABELS: Record<SupportRequestStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_on_customer: 'Waiting on customer',
  resolved: 'Resolved',
};

const MAX_DETAILS = 2000;
const MAX_NOTE = 1000;

async function loadCustomer(orgId: string, customerId: string) {
  if (!mongoose.isValidObjectId(customerId)) throw new ApiError(404, 'Customer not found');
  const customer: any = await Customer.findOne({ _id: customerId, organizationId: orgId }).select('firstName lastName').lean();
  if (!customer) throw new ApiError(404, 'Customer not found');
  return customer;
}

function customerName(customer: any): string {
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'a customer';
}

function serialize(doc: any) {
  return {
    id: String(doc._id),
    customerId: String(doc.customerId),
    leadId: doc.leadId ? String(doc.leadId) : null,
    type: doc.type,
    typeLabel: SUPPORT_TYPE_LABELS[doc.type as SupportRequestType] || doc.type,
    details: doc.details,
    status: doc.status,
    statusLabel: SUPPORT_STATUS_LABELS[doc.status as SupportRequestStatus] || doc.status,
    assignedTo: doc.assignedTo ? String(doc.assignedTo) : null,
    assignedName: doc.assignedName || '',
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    resolvedAt: doc.resolvedAt || null,
    history: (doc.history || []).slice(-50).map((entry: SupportHistoryEntry) => ({
      action: entry.action,
      from: entry.from,
      to: entry.to,
      note: entry.note || '',
      by: entry.by,
      at: entry.at,
    })),
  };
}

async function notifyAssignee(orgId: string, customerId: string, assigneeId: string, staff: CrmStaff, customer: any, typeLabel: string) {
  if (staff.userId && staff.userId === assigneeId) return;
  await notifyUsers([assigneeId], orgId, 'crm_task_assigned', 'Support request assigned to you', `${staff.name} gave you a ${typeLabel.toLowerCase()} request for ${customerName(customer)}.`, {
    customerId,
    route: `/crm/customers/${customerId}?tab=support`,
  }).catch((err: unknown) => logger.warn({ err, customerId }, '[SupportRequest] Assignee was not notified'));
}

export async function listSupportRequests(orgId: string, customerId: string) {
  await loadCustomer(orgId, customerId);
  const [docs, team] = await Promise.all([
    CustomerSupportRequest.find({ organizationId: orgId, customerId }).sort({ createdAt: -1 }).limit(200).lean(),
    listStaffTeam(orgId),
  ]);
  return {
    items: docs.map(serialize),
    team,
    types: SUPPORT_REQUEST_TYPES.map((value) => ({ value, label: SUPPORT_TYPE_LABELS[value] })),
    statuses: SUPPORT_REQUEST_STATUSES.map((value) => ({ value, label: SUPPORT_STATUS_LABELS[value] })),
  };
}

export async function createSupportRequest(orgId: string, customerId: string, staff: CrmStaff, body: any) {
  const customer = await loadCustomer(orgId, customerId);
  const type = SUPPORT_REQUEST_TYPES.includes(body?.type) ? (body.type as SupportRequestType) : null;
  if (!type) throw new ApiError(400, 'Pick the type of request');
  const details = typeof body?.details === 'string' ? body.details.trim() : '';
  if (!details) throw new ApiError(400, 'Write what the customer needs');
  if (details.length > MAX_DETAILS) throw new ApiError(400, `Keep the details under ${MAX_DETAILS} characters`);
  const assignee = await requireTeamMember(orgId, body?.assignedTo);
  let leadId: mongoose.Types.ObjectId | null = null;
  if (body?.leadId) {
    if (!mongoose.isValidObjectId(String(body.leadId))) throw new ApiError(400, 'That lead is not valid');
    const lead = await Lead.exists({ _id: body.leadId, organizationId: { $in: orgIdVariants(orgId) }, customerId });
    if (!lead) throw new ApiError(400, 'That lead does not belong to this customer');
    leadId = new mongoose.Types.ObjectId(String(body.leadId));
  }
  const by = { userId: staff.actorId, name: staff.name };
  const now = new Date();
  const history: SupportHistoryEntry[] = [{ action: 'created', from: null, to: 'open', note: '', by, at: now }];
  if (assignee) history.push({ action: 'assigned', from: null, to: assignee.name, note: '', by, at: now });
  const doc = await CustomerSupportRequest.create({
    organizationId: orgId,
    customerId,
    leadId,
    type,
    details,
    status: 'open',
    assignedTo: assignee?.id || null,
    assignedName: assignee?.name || '',
    history,
    createdBy: by,
  });
  if (assignee) await notifyAssignee(orgId, customerId, String(assignee.id), staff, customer, SUPPORT_TYPE_LABELS[type]);
  return serialize(doc.toObject());
}

export async function updateSupportRequest(orgId: string, customerId: string, requestId: string, staff: CrmStaff, body: any) {
  const customer = await loadCustomer(orgId, customerId);
  if (!mongoose.isValidObjectId(requestId)) throw new ApiError(404, 'Support request not found');
  const doc = await CustomerSupportRequest.findOne({ _id: requestId, organizationId: orgId, customerId });
  if (!doc) throw new ApiError(404, 'Support request not found');
  const by = { userId: staff.actorId, name: staff.name };
  const now = new Date();
  let changed = false;
  let newAssignee: string | null = null;
  if (body?.status !== undefined) {
    const status = SUPPORT_REQUEST_STATUSES.includes(body.status) ? (body.status as SupportRequestStatus) : null;
    if (!status) throw new ApiError(400, 'Pick a status from the list');
    if (status !== doc.status) {
      doc.history.push({ action: 'status', from: doc.status, to: status, note: '', by, at: now });
      doc.status = status;
      doc.resolvedAt = status === 'resolved' ? now : null;
      changed = true;
    }
  }
  if (body?.assignedTo !== undefined) {
    const assignee = await requireTeamMember(orgId, body.assignedTo);
    const next = assignee ? String(assignee.id) : null;
    const current = doc.assignedTo ? String(doc.assignedTo) : null;
    if (next !== current) {
      doc.history.push({ action: 'assigned', from: doc.assignedName || null, to: assignee?.name || null, note: '', by, at: now });
      doc.assignedTo = assignee?.id || null;
      doc.assignedName = assignee?.name || '';
      newAssignee = next;
      changed = true;
    }
  }
  if (body?.note !== undefined) {
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > MAX_NOTE) throw new ApiError(400, `Keep the note under ${MAX_NOTE} characters`);
    if (note) {
      doc.history.push({ action: 'note', from: null, to: null, note, by, at: now });
      changed = true;
    }
  }
  if (!changed) return serialize(doc.toObject());
  await doc.save();
  if (newAssignee) await notifyAssignee(orgId, customerId, newAssignee, staff, customer, SUPPORT_TYPE_LABELS[doc.type]);
  return serialize(doc.toObject());
}
