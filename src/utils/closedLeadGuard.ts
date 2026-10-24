import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import { LIFECYCLE_TERMINAL_STATUSES } from '../constants/leadStatus';
import { getLeadIntakeMode } from '../services/leadIntakeControl.service';
import { ApiError } from './ApiError';

export const CLOSED_LEAD_SEND_MESSAGE =
  "This lead is closed, so messages can't be sent from it. Open the customer's active lead, or reopen this lead first.";

export async function isClosedForManualSend(organizationId: unknown, lead: unknown): Promise<boolean> {
  const orgId = String(organizationId || '');
  if (!mongoose.isValidObjectId(orgId)) return false;
  let status: string | undefined;
  if (lead && typeof lead === 'object' && 'status' in (lead as any)) {
    status = (lead as any).status;
  } else {
    if (!lead || !mongoose.isValidObjectId(String(lead))) return false;
    const found: any = await Lead.findOne({ _id: lead, organizationId: orgId }).select('status').lean();
    status = found?.status;
  }
  if (!status || status === 'Do Not Contact' || !LIFECYCLE_TERMINAL_STATUSES.includes(status)) return false;
  return (await getLeadIntakeMode(orgId)) !== 'off';
}

export async function assertLeadOpenForManualSend(organizationId: unknown, lead: unknown): Promise<void> {
  if (await isClosedForManualSend(organizationId, lead)) {
    throw new ApiError(409, CLOSED_LEAD_SEND_MESSAGE, [{ code: 'lead_closed' }]);
  }
}
