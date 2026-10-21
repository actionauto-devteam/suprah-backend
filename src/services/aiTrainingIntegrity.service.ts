import AiTrainingPolicy, { TrainingActorRef, TrainingPolicyStatus } from '../models/AiTrainingPolicy.model';
import {
  PolicyIntegrity,
  auditEntry,
  checkPolicyIntegrity,
  flushPolicyAudit,
  runTrainingWrite,
} from './aiTraining.service';

export const INTEGRITY_REPAIR_ACTOR: TrainingActorRef = { userId: 'system', name: 'Training integrity repair', role: 'system' };

export interface RepairPlan {
  set: Record<string, unknown>;
  unset: string[];
  fromStatus: TrainingPolicyStatus;
  toStatus: TrainingPolicyStatus;
  flushAudit: boolean;
  summary: string[];
}

export interface IntegrityReportRow {
  policyId: string;
  organizationId: string;
  title: string;
  status: string;
  currentVersion: number;
  integrity: PolicyIntegrity;
  plan: RepairPlan | null;
}

const REVIEWABLE: TrainingPolicyStatus[] = ['in_review', 'approved'];

export function planIntegrityRepair(policy: any, integrity: PolicyIntegrity): RepairPlan | null {
  const codes = new Set(integrity.issues.map((issue) => issue.code));
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const summary: string[] = [];
  let toStatus: TrainingPolicyStatus = policy.status;

  if (codes.has('missing_current_version') || codes.has('missing_adopted_version')) {
    const usable = integrity.adoptedVersions.filter((version) => version <= Number(policy.currentVersion));
    const target = usable.length ? Math.max(...usable) : 0;
    if (!target) {
      toStatus = 'withdrawn';
      summary.push('No usable version exists, so the proposal is withdrawn.');
    } else {
      if (target !== Number(policy.currentVersion)) {
        set.currentVersion = target;
        summary.push(`Point the proposal back to version ${target}, the latest version that exists.`);
      }
      set.adoptedVersions = usable;
      if (REVIEWABLE.includes(policy.status)) {
        toStatus = 'changes_requested';
        summary.push('Send it back to the author so a complete version is reviewed again.');
      }
    }
  }

  if (codes.has('missing_submitted_version')) {
    unset.push('submittedVersion');
    summary.push('Clear the reference to the missing submitted version.');
    if (policy.status === 'in_review' && toStatus === 'in_review') {
      toStatus = 'changes_requested';
      summary.push('Send it back to the author to resubmit.');
    }
  }

  if (codes.has('missing_approval_audit') && toStatus === 'approved') {
    toStatus = 'in_review';
    unset.push('approvedBy', 'approvedAt');
    summary.push('The approval has no audit record, so it goes back to review and must be approved again.');
  }

  const flushAudit = codes.has('stale_pending_audit');
  if (flushAudit) summary.push('Copy waiting audit entries into the audit log.');
  if (toStatus !== policy.status) set.status = toStatus;
  if (!summary.length) return null;
  return { set, unset, fromStatus: policy.status, toStatus, flushAudit, summary };
}

export async function scanTrainingPolicyIntegrity(options: { organizationId?: string; limit?: number } = {}): Promise<IntegrityReportRow[]> {
  const filter: Record<string, unknown> = {};
  if (options.organizationId) filter.organizationId = options.organizationId;
  const policies: any[] = await AiTrainingPolicy.find(filter).sort({ _id: 1 }).limit(options.limit || 5000).lean();
  const rows: IntegrityReportRow[] = [];
  for (const policy of policies) {
    const integrity = await checkPolicyIntegrity(policy.organizationId, policy);
    if (!integrity.issues.length) continue;
    rows.push({
      policyId: String(policy._id),
      organizationId: String(policy.organizationId),
      title: policy.title,
      status: policy.status,
      currentVersion: policy.currentVersion,
      integrity,
      plan: planIntegrityRepair(policy, integrity),
    });
  }
  return rows;
}

export async function applyIntegrityRepair(row: IntegrityReportRow): Promise<'repaired' | 'changed_since_scan' | 'nothing_to_do'> {
  if (!row.plan) return 'nothing_to_do';
  const plan = row.plan;
  const hasUpdate = Object.keys(plan.set).length > 0 || plan.unset.length > 0;
  if (hasUpdate) {
    const entry = auditEntry('integrity_repaired', INTEGRITY_REPAIR_ACTOR, {
      version: Number(plan.set.currentVersion ?? row.currentVersion),
      fromStatus: plan.fromStatus,
      toStatus: plan.toStatus,
      note: plan.summary.join(' '),
    });
    const updated = await runTrainingWrite((session) => AiTrainingPolicy.findOneAndUpdate(
      { _id: row.policyId, organizationId: row.organizationId, status: row.status, currentVersion: row.currentVersion },
      {
        ...(Object.keys(plan.set).length ? { $set: plan.set } : {}),
        ...(plan.unset.length ? { $unset: Object.fromEntries(plan.unset.map((key) => [key, ''])) } : {}),
        $push: { pendingAudit: entry },
      },
      { new: true, ...(session ? { session } : {}) },
    ));
    if (!updated) return 'changed_since_scan';
  }
  await flushPolicyAudit(row.organizationId, row.policyId);
  return 'repaired';
}
