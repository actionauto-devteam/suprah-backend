import AiAgentTask from '../models/AiAgentTask.model';
import { AI_AGENT_FALLBACK_LABEL } from '../utils/aiAgentIdentity';
import AiTechnicalAlertState from '../models/AiTechnicalAlertState.model';
import { AttentionTechnicalCode, TECHNICAL_ATTENTION_CODES } from '../models/aiHumanAttention';
import { notifyOrgAdmins } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import logger from '../utils/logger';

export const TECHNICAL_ALERT_WINDOW_MINUTES = 60;
const DEFAULT_THRESHOLD = 5;

const CODE_LABELS: Record<AttentionTechnicalCode, string> = {
  local_qa_blocked: 'blocked in local QA',
  missing_api_key: 'not configured',
  timeout: 'timed out',
  provider_error: 'service error',
  unreadable_response: 'unreadable result',
  uncertain: 'inconclusive',
};

export type TechnicalAlertResult =
  | { alerted: true; count: number }
  | { alerted: false; count: number; reason: 'below_threshold' | 'recently_alerted' };

export function technicalAlertThreshold(): number {
  const value = Number(process.env.AI_TECHNICAL_ALERT_THRESHOLD);
  return Number.isInteger(value) && value >= 2 && value <= 100 ? value : DEFAULT_THRESHOLD;
}

function alertStateId(organizationId: string): string {
  return `ai-technical-alert:${organizationId}`;
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ''));
}

async function claimAlert(organizationId: string, count: number, now: Date, windowStart: Date): Promise<boolean> {
  try {
    await AiTechnicalAlertState.findOneAndUpdate(
      { _id: alertStateId(organizationId), $or: [{ lastAlertAt: { $lt: windowStart } }, { lastAlertAt: null }] },
      { $set: { organizationId, lastAlertAt: now, lastCount: count } },
      { upsert: true, new: true },
    );
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

function describeCodes(rows: Array<{ _id?: string; n: number }>): string {
  const parts = rows
    .filter(row => row._id && (TECHNICAL_ATTENTION_CODES as string[]).includes(row._id))
    .sort((a, b) => b.n - a.n)
    .map(row => `${CODE_LABELS[row._id as AttentionTechnicalCode]} (${row.n})`);
  return parts.length ? parts.join(', ') : 'unknown';
}

export async function maybeAlertTechnicalFailures(input: {
  organizationId: string;
  agentName?: string;
  now?: Date;
}): Promise<TechnicalAlertResult> {
  const now = input.now || new Date();
  const windowStart = new Date(now.getTime() - TECHNICAL_ALERT_WINDOW_MINUTES * 60 * 1000);
  const threshold = technicalAlertThreshold();
  const filter = { organizationId: input.organizationId, attentionKind: 'technical', createdAt: { $gte: windowStart } };
  const count = await AiAgentTask.countDocuments(filter);
  if (count < threshold) return { alerted: false, count, reason: 'below_threshold' };
  if (!(await claimAlert(input.organizationId, count, now, windowStart))) {
    return { alerted: false, count, reason: 'recently_alerted' };
  }

  const codes = await AiAgentTask.aggregate([{ $match: filter }, { $group: { _id: '$attentionCode', n: { $sum: 1 } } }]);
  const agentName = input.agentName || AI_AGENT_FALLBACK_LABEL;
  const codeCounts = Object.fromEntries(codes
    .filter(row => row._id && (TECHNICAL_ATTENTION_CODES as string[]).includes(row._id))
    .map(row => [row._id, row.n]));
  const template = notificationTemplates.ai_technical_failures_alert({ agentName, count, causes: describeCodes(codes) });
  await notifyOrgAdmins(
    input.organizationId,
    'ai_technical_failures_alert',
    template.title,
    template.message,
    {
      route: '/crm/ai-tasks?kind=technical',
      count,
      threshold,
      windowMinutes: TECHNICAL_ALERT_WINDOW_MINUTES,
      codes: codeCounts,
      alertedAt: now.toISOString(),
    },
  );
  logger.warn({ organizationId: input.organizationId, count, threshold, codes: codeCounts },
    '[AiTechnicalAlert] Aggregated technical-failure alert sent');
  return { alerted: true, count };
}
