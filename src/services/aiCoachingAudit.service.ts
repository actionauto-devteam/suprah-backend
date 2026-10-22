import mongoose from 'mongoose';
import AiAgentCoachingRule from '../models/AiAgentCoachingRule.model';
import Organization from '../models/Organization.model';
import { strictInstructionIssues } from './aiTrainingSafetyGate';
import {
  TARGET_ENVIRONMENTS,
  type CredentialAccess,
  type CredentialSummary,
  type TargetEnvironment,
  credentialRefusal as baseCredentialRefusal,
  resolveTarget,
} from '../utils/readOnlyDbTarget';

export { describeCredentials, isLoopbackHost, uriDatabase, uriHosts } from '../utils/readOnlyDbTarget';
export type { CredentialAccess, CredentialSummary } from '../utils/readOnlyDbTarget';

export const COACHING_AUDIT_URI_VARIABLE = 'COACHING_AUDIT_MONGODB_URI';
export const AUDIT_ENVIRONMENTS = TARGET_ENVIRONMENTS;
export type AuditEnvironment = TargetEnvironment;

const AUDIT_MAX_TIME_MS = 60000;
const AUDIT_BATCH_SIZE = 500;
const MAX_LISTED_IN_TEXT = 500;

export const COACHING_AUDIT_ISSUE_LABELS: Record<string, string> = {
  guardrail_figure: 'Prices, payments, rates or other money figures',
  guardrail_topic: 'Pricing, financing, discount, trade-in or availability claims',
  safety_bypass: 'Tells Alex to skip a safety rule such as opt-outs, handoffs, AI disclosure or mandatory checks',
};

export interface CoachingAuditInput {
  _id: unknown;
  organizationId?: unknown;
  status: string;
  channel?: string;
  instruction?: unknown;
  usageCount?: number;
  lastUsedAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface CoachingAuditFinding {
  id: string;
  organizationId: string;
  status: 'active' | 'disabled';
  channel: string;
  issueCodes: string[];
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CoachingAuditCounts {
  examined: number;
  active: number;
  disabled: number;
  passing: number;
  failing: number;
  failingActive: number;
  failingDisabled: number;
  noText: number;
}

export interface CoachingAuditIssueSummary {
  code: string;
  label: string;
  records: number;
  activeRecords: number;
}

export interface CoachingAuditOrgSummary extends CoachingAuditCounts {
  organizationId: string;
  name: string | null;
  issues: Record<string, number>;
}

export interface CoachingAuditReport {
  generatedAt: string;
  organizationFilter: string | null;
  totals: CoachingAuditCounts;
  notExamined: { deleted: number; otherStatus: number };
  issues: CoachingAuditIssueSummary[];
  organizations: CoachingAuditOrgSummary[];
  failing: CoachingAuditFinding[];
}

export interface AuditTarget {
  uri: string;
  environment: AuditEnvironment;
  database: string;
  hosts: string[];
  organizationId: string | null;
  json: boolean;
}

const emptyCounts = (): CoachingAuditCounts => ({
  examined: 0, active: 0, disabled: 0, passing: 0, failing: 0, failingActive: 0, failingDisabled: 0, noText: 0,
});

const isoOrNull = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function evaluateCoachingRecord(record: Pick<CoachingAuditInput, 'instruction'>): { passed: boolean; noText: boolean; issueCodes: string[] } {
  const text = typeof record.instruction === 'string' ? record.instruction : '';
  if (!text.trim()) return { passed: true, noText: true, issueCodes: [] };
  const issueCodes = Array.from(new Set(strictInstructionIssues(text).map((issue) => issue.code)));
  return { passed: issueCodes.length === 0, noText: false, issueCodes };
}

function tally(counts: CoachingAuditCounts, status: 'active' | 'disabled', result: { passed: boolean; noText: boolean }) {
  counts.examined += 1;
  counts[status] += 1;
  if (result.noText) counts.noText += 1;
  if (result.passed) {
    counts.passing += 1;
  } else {
    counts.failing += 1;
    if (status === 'active') counts.failingActive += 1;
    else counts.failingDisabled += 1;
  }
}

export function createCoachingAuditAccumulator() {
  const totals = emptyCounts();
  const organizations = new Map<string, { counts: CoachingAuditCounts; issues: Map<string, number> }>();
  const issueTotals = new Map<string, { records: number; activeRecords: number }>();
  const failing: CoachingAuditFinding[] = [];

  return {
    add(record: CoachingAuditInput): void {
      if (record.status !== 'active' && record.status !== 'disabled') return;
      const status = record.status;
      const organizationId = String(record.organizationId ?? '');
      const result = evaluateCoachingRecord(record);
      const org = organizations.get(organizationId) || { counts: emptyCounts(), issues: new Map<string, number>() };
      organizations.set(organizationId, org);
      tally(totals, status, result);
      tally(org.counts, status, result);
      for (const code of result.issueCodes) {
        const entry = issueTotals.get(code) || { records: 0, activeRecords: 0 };
        entry.records += 1;
        if (status === 'active') entry.activeRecords += 1;
        issueTotals.set(code, entry);
        org.issues.set(code, (org.issues.get(code) || 0) + 1);
      }
      if (!result.passed) {
        failing.push({
          id: String(record._id),
          organizationId,
          status,
          channel: String(record.channel || 'all'),
          issueCodes: result.issueCodes,
          usageCount: Number(record.usageCount || 0),
          lastUsedAt: isoOrNull(record.lastUsedAt),
          createdAt: isoOrNull(record.createdAt),
          updatedAt: isoOrNull(record.updatedAt),
        });
      }
    },
    organizationIds(): string[] {
      return Array.from(organizations.keys());
    },
    finish(context: {
      organizationFilter?: string | null;
      notExamined?: { deleted: number; otherStatus: number };
      names?: Map<string, string>;
      generatedAt?: Date;
    } = {}): CoachingAuditReport {
      const names = context.names || new Map<string, string>();
      return {
        generatedAt: (context.generatedAt || new Date()).toISOString(),
        organizationFilter: context.organizationFilter || null,
        totals: { ...totals },
        notExamined: context.notExamined || { deleted: 0, otherStatus: 0 },
        issues: Array.from(issueTotals.entries())
          .map(([code, entry]) => ({ code, label: COACHING_AUDIT_ISSUE_LABELS[code] || 'Other blocked wording', ...entry }))
          .sort((a, b) => b.records - a.records || a.code.localeCompare(b.code)),
        organizations: Array.from(organizations.entries())
          .map(([organizationId, org]) => ({
            organizationId,
            name: names.get(organizationId) || null,
            ...org.counts,
            issues: Object.fromEntries(Array.from(org.issues.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
          }))
          .sort((a, b) => b.failing - a.failing || b.examined - a.examined || a.organizationId.localeCompare(b.organizationId)),
        failing: failing.slice().sort((a, b) =>
          (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1)
          || b.usageCount - a.usageCount
          || a.id.localeCompare(b.id)),
      };
    },
  };
}

export function summarizeCoachingAudit(records: Iterable<CoachingAuditInput>, context: Parameters<ReturnType<typeof createCoachingAuditAccumulator>['finish']>[0] = {}): CoachingAuditReport {
  const audit = createCoachingAuditAccumulator();
  for (const record of records) audit.add(record);
  return audit.finish(context);
}

function organizationScope(organizationId?: string | null): Record<string, unknown> {
  if (!organizationId) return {};
  const values: unknown[] = [organizationId];
  if (mongoose.isValidObjectId(organizationId)) values.push(new mongoose.Types.ObjectId(organizationId));
  return { organizationId: { $in: values } };
}

async function organizationNames(ids: string[]): Promise<Map<string, string>> {
  const objectIds = ids.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const names = new Map<string, string>();
  if (!objectIds.length) return names;
  const rows = await Organization.collection
    .find({ _id: { $in: objectIds } }, { projection: { name: 1 }, maxTimeMS: AUDIT_MAX_TIME_MS })
    .toArray()
    .catch(() => []);
  for (const row of rows as any[]) if (row?.name) names.set(String(row._id), String(row.name));
  return names;
}

export async function runLegacyCoachingAudit(options: { organizationId?: string | null } = {}): Promise<CoachingAuditReport> {
  const scope = organizationScope(options.organizationId);
  const collection = AiAgentCoachingRule.collection;
  const audit = createCoachingAuditAccumulator();
  const cursor = collection.find(
    { ...scope, status: { $in: ['active', 'disabled'] } },
    {
      projection: { organizationId: 1, status: 1, channel: 1, instruction: 1, usageCount: 1, lastUsedAt: 1, createdAt: 1, updatedAt: 1 },
      sort: { _id: 1 },
      batchSize: AUDIT_BATCH_SIZE,
      maxTimeMS: AUDIT_MAX_TIME_MS,
    },
  );
  for await (const record of cursor) audit.add(record as unknown as CoachingAuditInput);
  const [deleted, otherStatus] = await Promise.all([
    collection.countDocuments({ ...scope, status: 'deleted' }, { maxTimeMS: AUDIT_MAX_TIME_MS }),
    collection.countDocuments({ ...scope, status: { $nin: ['active', 'disabled', 'deleted'] } }, { maxTimeMS: AUDIT_MAX_TIME_MS }),
  ]);
  return audit.finish({
    organizationFilter: options.organizationId || null,
    notExamined: { deleted, otherStatus },
    names: await organizationNames(audit.organizationIds()),
  });
}

export function resolveAuditTarget(argv: string[], uri: string | undefined): { target?: AuditTarget; error?: string; help?: boolean } {
  const resolved = resolveTarget(argv, uri, { uriVariable: COACHING_AUDIT_URI_VARIABLE, flags: ['--json'] });
  if (!resolved.target) return { error: resolved.error, help: resolved.help };
  const { uri: targetUri, environment, database, hosts, organizationId, flags } = resolved.target;
  return {
    target: {
      uri: targetUri,
      environment,
      database,
      hosts,
      organizationId,
      json: flags.includes('--json'),
    },
  };
}

export function credentialRefusal(target: Pick<AuditTarget, 'environment'>, credentials: CredentialSummary): string | null {
  return baseCredentialRefusal(target, credentials);
}

const CREDENTIAL_LABELS: Record<CredentialAccess, string> = {
  read_only: 'read-only',
  write_capable: 'can change data (the audit still only reads)',
  no_auth: 'not signed in (no database user)',
  unknown: 'could not be checked',
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function formatCoachingAuditReport(
  report: CoachingAuditReport,
  target: Pick<AuditTarget, 'environment' | 'database' | 'hosts'>,
  credentials: CredentialSummary,
): string {
  const { totals } = report;
  const lines: string[] = [];
  lines.push('Legacy coaching audit (read-only)');
  lines.push(`Environment: ${target.environment}`);
  lines.push(`Database: ${target.database}`);
  lines.push(`Hosts: ${target.hosts.join(', ')}`);
  lines.push(`Credentials: ${CREDENTIAL_LABELS[credentials.access]}${credentials.roles.length ? ` (roles: ${credentials.roles.join(', ')})` : ''}`);
  lines.push(`Scope: ${report.organizationFilter ? `organization ${report.organizationFilter}` : 'all organizations'}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`Coaching records examined: ${totals.examined} (active ${totals.active}, disabled ${totals.disabled})`);
  lines.push(`Passing current safety rules: ${totals.passing}${totals.noText ? ` (includes ${totals.noText} with no text, which Alex skips)` : ''}`);
  lines.push(`Failing current safety rules: ${totals.failing} (active ${totals.failingActive}, disabled ${totals.failingDisabled})`);
  lines.push(`Not examined: ${report.notExamined.deleted} deleted${report.notExamined.otherStatus ? `, ${report.notExamined.otherStatus} with an unexpected status` : ''}`);
  lines.push('');
  lines.push('Issue categories');
  if (!report.issues.length) lines.push('- none');
  for (const issue of report.issues) {
    lines.push(`- ${issue.code}: ${plural(issue.records, 'record')} (${issue.activeRecords} active). ${issue.label}`);
  }
  lines.push('');
  lines.push('By organization');
  if (!report.organizations.length) lines.push('- none');
  for (const org of report.organizations) {
    const issues = Object.entries(org.issues).map(([code, count]) => `${code} ${count}`).join(', ');
    lines.push(`- ${org.organizationId}${org.name ? ` (${org.name})` : ''}: ${org.examined} examined (active ${org.active}, disabled ${org.disabled}), ${org.passing} passing, ${org.failing} failing (active ${org.failingActive}, disabled ${org.failingDisabled})${issues ? `. Issues: ${issues}` : ''}`);
  }
  lines.push('');
  lines.push('Failing records (ids only, no coaching text)');
  if (!report.failing.length) lines.push('- none');
  for (const finding of report.failing.slice(0, MAX_LISTED_IN_TEXT)) {
    lines.push(`- ${finding.id} org ${finding.organizationId} ${finding.status}, channel ${finding.channel}, used ${plural(finding.usageCount, 'time')}${finding.lastUsedAt ? `, last used ${finding.lastUsedAt.slice(0, 10)}` : ''}: ${finding.issueCodes.join(', ')}`);
  }
  if (report.failing.length > MAX_LISTED_IN_TEXT) {
    lines.push(`- ${report.failing.length - MAX_LISTED_IN_TEXT} more not shown. Re-run with --json for the full list.`);
  }
  lines.push('');
  lines.push('Nothing was changed. This audit only reads coaching records.');
  return lines.join('\n');
}
