import mongoose from 'mongoose';
import { emitToOrg } from './socketEmitter';

export async function touchLeadActivity(leadId: unknown, organizationId?: unknown, at?: Date | string | null): Promise<void> {
  const id = leadId ? String((leadId as any)?._id ?? leadId) : '';
  if (!mongoose.isValidObjectId(id)) return;
  const when = at ? new Date(at) : new Date();
  const stamp = Number.isNaN(when.getTime()) ? new Date() : when;
  try {
    const result = await mongoose.model('Lead').updateOne({ _id: id }, { $max: { 'followUp.lastActivityAt': stamp } });
    if (result.modifiedCount && organizationId) emitToOrg(String(organizationId), 'lead:update', { leadId: id });
  } catch {
    return;
  }
}
