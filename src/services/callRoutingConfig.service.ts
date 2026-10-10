import mongoose from 'mongoose';
import { z } from 'zod';
import CallRoutingConfig, { RoutingConfig } from '../models/CallRoutingConfig.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';

export function routingPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return `+${digits.length === 10 ? '1' : ''}${digits}`;
}

const phone = z.string().transform(routingPhone).refine(value => /^\+[1-9]\d{7,14}$/.test(value), 'Invalid phone number');
const group = z.string().refine(value => mongoose.isValidObjectId(value), 'Invalid Lead Group').nullable();
const inputSchema = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(120),
  inboundNumber: phone,
  mainNumber: phone,
  greeting: z.string().trim().min(1).max(3000),
  ringTimeoutSeconds: z.number().int().min(10).max(120),
  retryCount: z.number().int().min(0).max(3),
  receptionGroupId: group,
  allOrgFallback: z.boolean(),
  options: z.array(z.object({
    digit: z.string().regex(/^[0-9]$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(['location', 'department', 'language']),
    groupId: group,
    leadLocation: z.string().trim().max(120),
    language: z.string().trim().max(40),
    externalDestination: z.string().trim().max(30),
  }).strict()).min(1).max(10),
}).strict();

export function parseRoutingConfig(input: unknown, currentIngress = ''): RoutingConfig {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map(issue => issue.message).join('; '));
  const config = parsed.data;
  if (new Set(config.options.map(option => option.digit)).size !== config.options.length) {
    throw new ApiError(400, 'Each IVR digit must be unique');
  }
  if (config.enabled && (!config.receptionGroupId || config.options.some(option => !option.groupId && !(option.digit === '0' && option.type === 'language')))) {
    throw new ApiError(400, 'Reception and every enabled option require a Lead Group');
  }
  for (const option of config.options) {
    if (option.type !== 'location' && option.leadLocation) {
      throw new ApiError(400, 'Only location routes may set Lead location');
    }
    if (option.externalDestination) {
      const external = phone.safeParse(option.externalDestination);
      if (!external.success) throw new ApiError(400, 'Invalid external destination');
      option.externalDestination = external.data;
      const blocked = [config.inboundNumber, config.mainNumber, currentIngress].filter(Boolean).map(routingPhone);
      if (blocked.includes(external.data)) throw new ApiError(400, 'External destination cannot be Main or an ingress number');
    }
  }
  return config;
}

export async function validateRoutingGroups(orgId: string, config: RoutingConfig): Promise<void> {
  const ids = [...new Set([config.receptionGroupId, ...config.options.map(option => option.groupId)].filter(Boolean))];
  if (!ids.length) return;
  const count = await CrmLeadGroup.countDocuments({ _id: { $in: ids }, organizationId: orgId, ...(config.enabled ? { isActive: true } : {}) });
  if (count !== ids.length) throw new ApiError(400, 'Routing groups must be active and belong to this organization');
}

export async function getInboundRoutingConfig(number: string): Promise<{ orgId: string; config: RoutingConfig } | null> {
  try {
    const row = await CallRoutingConfig.findOne({ inboundNumber: routingPhone(number), enabled: true }).lean();
    if (!row) return null;
    const config = parseRoutingConfig({
      enabled: row.enabled, name: row.name, inboundNumber: row.inboundNumber, mainNumber: row.mainNumber,
      greeting: row.greeting, ringTimeoutSeconds: row.ringTimeoutSeconds, retryCount: row.retryCount,
      receptionGroupId: row.receptionGroupId, allOrgFallback: row.allOrgFallback, options: row.options.map(option => ({
        digit: option.digit, label: option.label, type: option.type, groupId: option.groupId,
        leadLocation: option.leadLocation, language: option.language, externalDestination: option.externalDestination,
      })),
    });
    await validateRoutingGroups(String(row.organizationId), config);
    return { orgId: String(row.organizationId), config };
  } catch (error) {
    console.error('[ivr] Configuration unavailable; using legacy inbound flow', error);
    return null;
  }
}

export async function getConfiguredInboundOrganization(number: string): Promise<string | null> {
  try {
    const row = await CallRoutingConfig.findOne({ inboundNumber: routingPhone(number) }).select('organizationId').lean();
    return row ? String(row.organizationId) : null;
  } catch { return null; }
}

export async function routingGroupRecipients(orgId: string, groupId: string | null): Promise<string[]> {
  if (!groupId) return [];
  const groupRow = await CrmLeadGroup.findOne({ _id: groupId, organizationId: orgId, isActive: true }).lean();
  if (!groupRow) return [];
  const members = await User.find({ _id: { $in: groupRow.memberIds }, organizationId: orgId, isActive: true }).select('_id email').lean();
  const linked = await CrmUser.find({ organizationId: orgId, email: { $in: members.map(member => member.email.toLowerCase()) } }).select('_id email isActive isOffboarded').lean();
  const ids = new Set<string>();
  for (const member of members) {
    const crm = linked.find(user => user.email.toLowerCase() === member.email.toLowerCase());
    if (crm && (!crm.isActive || crm.isOffboarded)) continue;
    ids.add(String(member._id));
    if (crm) ids.add(String(crm._id));
  }
  return [...ids];
}
