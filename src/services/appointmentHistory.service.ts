import mongoose from 'mongoose';
import Appointment from '../models/Appointment.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';
import { COMPANY_TZ } from '../utils/companyTimezone';
import { addLeadNoteAndNotify } from '../utils/leadNote';

export interface AppointmentActor {
  userId?: string | null;
  name: string;
}

export interface AppointmentSalesperson {
  userId: mongoose.Types.ObjectId;
  crmUserId: mongoose.Types.ObjectId | null;
  name: string;
}

export interface AppointmentChange {
  field: string;
  label: string;
  from?: string;
  to?: string;
}

export type AppointmentHistoryAction = 'created' | 'updated' | 'cancelled' | 'status' | 'deleted';

const TYPE_LABELS: Record<string, string> = {
  'test-drive': 'Test Drive',
  meeting: 'Meeting',
  'in-person': 'In-Person',
  video: 'Video Call',
  phone: 'Phone Call',
  other: 'Other',
};

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  'no-show': 'No-Show',
};

const TRACKED_FIELDS: Array<[string, string]> = [
  ['title', 'Title'],
  ['type', 'Type'],
  ['startTime', 'Start'],
  ['endTime', 'End'],
  ['salesperson', 'Salesperson'],
  ['status', 'Status'],
  ['location', 'Location'],
  ['description', 'Description'],
  ['notes', 'Notes'],
  ['outcomeNotes', 'Outcome notes'],
  ['meetingLink', 'Meeting link'],
];

const STAFF_ROLES = ['employee', 'admin', 'super_admin'];

export function denverDateTime(value: unknown): string {
  if (!value) return '';
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    timeZone: COMPANY_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function denverTime(value: unknown): string {
  if (!value) return '';
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { timeZone: COMPANY_TZ, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

export function typeLabel(appointment: any): string {
  const type = String(appointment?.type || '');
  if (type === 'other' && appointment?.customTypeDetails) return String(appointment.customTypeDetails);
  return TYPE_LABELS[type] || type || 'Appointment';
}

export async function resolveSalesperson(organizationId: string, userId: unknown): Promise<AppointmentSalesperson> {
  const id = String(userId || '');
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Choose a salesperson from your team.');
  const user: any = await User.findOne({ _id: id, organizationId, isActive: true, role: { $in: STAFF_ROLES } })
    .select('_id name email')
    .lean();
  if (!user) throw new ApiError(400, 'Choose an active salesperson from your team.');
  const crmUser: any = user.email
    ? await CrmUser.findOne({ email: String(user.email).toLowerCase(), organizationId, isActive: true }).select('_id fullName').lean()
    : null;
  return {
    userId: user._id,
    crmUserId: crmUser?._id || null,
    name: String(user.name || crmUser?.fullName || user.email || 'Salesperson').trim(),
  };
}

export async function assertSalespersonAvailable(
  organizationId: string,
  salesperson: AppointmentSalesperson,
  start: Date,
  end: Date,
  excludeAppointmentId?: unknown,
) {
  const ids = [salesperson.userId, salesperson.crmUserId].filter(Boolean) as mongoose.Types.ObjectId[];
  const filter: Record<string, unknown> = {
    organizationId,
    status: { $ne: 'cancelled' },
    transparency: { $ne: 'transparent' },
    startTime: { $lt: end },
    endTime: { $gt: start },
    $or: [{ 'salesperson.userId': salesperson.userId }, { participants: { $in: ids } }],
    $expr: { $lt: [{ $subtract: ['$endTime', '$startTime'] }, 23 * 60 * 60 * 1000] },
  };
  if (excludeAppointmentId) filter._id = { $ne: excludeAppointmentId };
  const conflict: any = await Appointment.findOne(filter).select('title startTime endTime').lean();
  if (conflict) {
    throw new ApiError(
      409,
      `Double-Booking Conflict: ${salesperson.name} already has "${conflict.title}" from ${denverDateTime(conflict.startTime)} to ${denverTime(conflict.endTime)}. Pick another time or another salesperson.`,
    );
  }
}

export function appointmentSnapshot(appointment: any): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [field] of TRACKED_FIELDS) {
    let value: string;
    if (field === 'startTime' || field === 'endTime') value = denverDateTime(appointment?.[field]);
    else if (field === 'type') value = typeLabel(appointment);
    else if (field === 'status') value = STATUS_LABELS[String(appointment?.status || '')] || String(appointment?.status || '');
    else if (field === 'salesperson') value = String(appointment?.salesperson?.name || '');
    else value = String(appointment?.[field] ?? '').trim();
    snapshot[field] = value;
  }
  return snapshot;
}

export function diffAppointment(before: Record<string, string>, after: Record<string, string>): AppointmentChange[] {
  return TRACKED_FIELDS
    .filter(([field]) => (before[field] || '') !== (after[field] || ''))
    .map(([field, label]) => ({ field, label, from: before[field] || 'none', to: after[field] || 'none' }));
}

function shortText(value: string | undefined, max = 120): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function historyNoteText(action: AppointmentHistoryAction, appointment: any, changes: AppointmentChange[]): string {
  const what = `${typeLabel(appointment)} on ${denverDateTime(appointment?.startTime)}`;
  const withWho = appointment?.salesperson?.name ? ` with ${appointment.salesperson.name}` : '';
  if (action === 'created') return `Appointment booked: ${what}${withWho}.`;
  if (action === 'cancelled') return `Appointment cancelled: ${what}${withWho}.`;
  if (action === 'deleted') return `Appointment deleted: ${what}${withWho}.`;
  const lines = changes.map((change) => `${change.label}: ${shortText(change.from)} → ${shortText(change.to)}`);
  const heading = action === 'status' ? `Appointment status changed (${what})` : `Appointment changed (${what})`;
  return `${heading}:\n${lines.join('\n')}`;
}

export async function recordAppointmentHistory(
  appointment: any,
  actor: AppointmentActor,
  action: AppointmentHistoryAction,
  changes: AppointmentChange[] = [],
) {
  if ((action === 'updated' || action === 'status') && changes.length === 0) return;
  const entry = {
    at: new Date(),
    byUserId: actor.userId ? String(actor.userId) : null,
    byName: actor.name || 'Team member',
    action,
    changes,
  };
  if (action !== 'deleted') {
    await Appointment.updateOne({ _id: appointment._id }, { $push: { changeHistory: entry } }).catch((err) => {
      console.error('[AppointmentHistory] Could not save the change history:', err?.message);
    });
  }
  if (appointment.leadId && appointment.organizationId) {
    await addLeadNoteAndNotify({
      organizationId: String(appointment.organizationId),
      leadId: String(appointment.leadId),
      text: historyNoteText(action, appointment, changes),
      authorType: 'user',
      authorName: entry.byName,
      ...(actor.userId && mongoose.isValidObjectId(String(actor.userId)) ? { createdBy: String(actor.userId) } : {}),
      noteKind: 'appointment',
      suppressNotification: true,
    }).catch((err) => {
      console.error('[AppointmentHistory] Could not add the lead note:', err?.message);
    });
  }
}
