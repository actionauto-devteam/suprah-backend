import mongoose from 'mongoose';
import LeadIntakeControl, { LEAD_INTAKE_MODES, LeadIntakeMode } from '../models/LeadIntakeControl.model';
import LeadIntakeAudit from '../models/LeadIntakeAudit.model';
import { ApiError } from '../utils/ApiError';

export type { LeadIntakeMode } from '../models/LeadIntakeControl.model';

const MODE_CACHE_MS = 5_000;
const modeCache = new Map<string, { mode: LeadIntakeMode; at: number }>();
const resumeListeners: Array<(organizationId: string) => void> = [];

export function onLeadIntakeResumed(listener: (organizationId: string) => void): void {
  resumeListeners.push(listener);
}

export function clearLeadIntakeModeCache(organizationId?: string): void {
  if (organizationId) modeCache.delete(String(organizationId));
  else modeCache.clear();
}

export async function getLeadIntakeMode(organizationId: unknown): Promise<LeadIntakeMode> {
  const orgId = String(organizationId || '');
  if (!mongoose.isValidObjectId(orgId)) return 'off';
  const cached = modeCache.get(orgId);
  if (cached && Date.now() - cached.at < MODE_CACHE_MS) return cached.mode;
  const control = await LeadIntakeControl.findOne({ organizationId: orgId }).select('mode').maxTimeMS(3000).lean();
  const mode = (control?.mode as LeadIntakeMode) || 'off';
  modeCache.set(orgId, { mode, at: Date.now() });
  return mode;
}

export async function getLeadIntakeControl(organizationId: unknown) {
  const orgId = String(organizationId || '');
  const [control, heldEvents] = await Promise.all([
    LeadIntakeControl.findOne({ organizationId: orgId }).lean(),
    mongoose.isValidObjectId(orgId)
      ? mongoose.model('LeadInquiry').countDocuments({ organizationId: orgId, 'association.state': 'received' }).catch(() => null)
      : Promise.resolve(0),
  ]);
  return {
    heldEvents,
    mode: (control?.mode as LeadIntakeMode) || 'off',
    reason: control?.reason || null,
    updatedBy: control?.updatedBy || null,
    updatedAt: control?.updatedAt || null,
  };
}

export async function setLeadIntakeMode(input: {
  organizationId: unknown;
  mode: unknown;
  reason: unknown;
  actor: { userId?: string | null; name?: string | null };
}): Promise<{ mode: LeadIntakeMode; previousMode: LeadIntakeMode }> {
  const orgId = String(input.organizationId || '');
  if (!mongoose.isValidObjectId(orgId)) throw new ApiError(400, 'A valid organization is required');
  const mode = String(input.mode || '') as LeadIntakeMode;
  if (!LEAD_INTAKE_MODES.includes(mode)) throw new ApiError(400, 'Choose off, active, or paused');
  const reason = String(input.reason || '').trim().slice(0, 1000);
  if (!reason) throw new ApiError(400, 'Please give a reason for changing lead intake');

  const current = await LeadIntakeControl.findOne({ organizationId: orgId }).lean();
  const previousMode = (current?.mode as LeadIntakeMode) || 'off';
  const filter = current
    ? { organizationId: orgId, version: current.version ?? 0 }
    : { organizationId: orgId };
  const updated = await LeadIntakeControl.findOneAndUpdate(
    filter,
    {
      $set: { mode, reason, updatedBy: { userId: input.actor.userId || null, name: input.actor.name || null } },
      $inc: { version: 1 },
      $setOnInsert: { organizationId: orgId },
    },
    { upsert: !current, new: true },
  ).catch((err: any) => {
    if (err?.code === 11000) return null;
    throw err;
  });
  if (!updated) throw new ApiError(409, 'Lead intake was just changed by someone else. Refresh and try again.');

  try {
    await LeadIntakeAudit.create({
      organizationId: orgId,
      event: 'intake_mode_changed',
      actor: { kind: 'staff', userId: input.actor.userId || null, name: input.actor.name || null },
      fromMode: previousMode,
      toMode: mode,
      reason,
    });
  } catch (err) {
    await LeadIntakeControl.updateOne(
      { organizationId: orgId, version: updated.version },
      { $set: { mode: previousMode, reason: current?.reason || null, updatedBy: current?.updatedBy || null }, $inc: { version: 1 } },
    ).catch(() => undefined);
    clearLeadIntakeModeCache(orgId);
    throw new ApiError(503, "We couldn't record this change, so lead intake was left as it was. Please try again.");
  }

  clearLeadIntakeModeCache(orgId);
  if (mode === 'active' && previousMode !== 'active') {
    for (const listener of resumeListeners) {
      Promise.resolve().then(() => listener(orgId)).catch(() => undefined);
    }
  }
  return { mode, previousMode };
}
