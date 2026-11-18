import mongoose from 'mongoose';
import Organization from '../models/Organization.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import CallRoutingConfig from '../models/CallRoutingConfig.model';
import DealershipPhoneNumber from '../models/DealershipPhoneNumber.model';
import { routingGroupRecipients } from './callRoutingConfig.service';
import { ApiError } from '../utils/ApiError';

const SETTING = 'allLocationsRingGroupId';

export interface AllLocationsLine {
  type: 'number' | 'menu';
  label: string;
  number?: string;
  location?: string;
  digit?: string;
  menu?: string;
}

export function isLocationRoute(
  option: { type?: string } | null | undefined,
  line: { kind?: string; ringGroupId?: unknown } | null | undefined,
): boolean {
  if (option?.type === 'location') return true;
  return option?.type === 'number' && line?.kind === 'location' && Boolean(line.ringGroupId);
}

export async function allLocationsRingGroupId(organizationId: unknown): Promise<string | null> {
  const orgId = String(organizationId ?? '');
  if (!mongoose.isValidObjectId(orgId)) return null;
  const org: any = await Organization.findById(orgId).select(`metadata.${SETTING}`).lean();
  const groupId = String(org?.metadata?.[SETTING] || '').trim();
  return mongoose.isValidObjectId(groupId) ? groupId : null;
}

export async function allLocationsRing(organizationId: unknown): Promise<{ groupId: string; recipientIds: string[] } | null> {
  const groupId = await allLocationsRingGroupId(organizationId);
  if (!groupId) return null;
  const recipientIds = await routingGroupRecipients(String(organizationId), groupId);
  return recipientIds.length ? { groupId, recipientIds } : null;
}

export async function describeAllLocationsRing(organizationId: string) {
  const groupId = await allLocationsRingGroupId(organizationId);
  const [group, numbers, menus] = await Promise.all([
    groupId ? CrmLeadGroup.findOne({ _id: groupId, organizationId }).select('name isActive').lean() : null,
    DealershipPhoneNumber.find({ organizationId }).select('number label kind location ringGroupId').lean(),
    CallRoutingConfig.find({ organizationId, enabled: true }).select('name inboundNumber options').lean(),
  ]);
  const numberById = new Map(numbers.map((row: any) => [String(row._id), row]));
  const answeredByMenu = new Set(menus.map((menu: any) => String(menu.inboundNumber)));
  const directNumbers: AllLocationsLine[] = numbers
    .filter((row: any) => row.kind === 'location' && row.ringGroupId && !answeredByMenu.has(String(row.number)))
    .map((row: any) => ({ type: 'number' as const, label: String(row.label || ''), number: String(row.number), location: String(row.location || '') }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const menuKeys: AllLocationsLine[] = menus.flatMap((menu: any) => (menu.options || [])
    .filter((option: any) => isLocationRoute(option, numberById.get(String(option.phoneNumberId))))
    .map((option: any) => ({ type: 'menu' as const, label: String(option.label || ''), digit: String(option.digit), menu: String(menu.name || '').trim() || 'Phone Menu' })));
  const appliesTo = [...directNumbers, ...menuKeys];
  const active = Boolean((group as any)?.isActive);
  return {
    groupId,
    groupName: active ? String((group as any).name || '') : '',
    groupActive: active,
    appliesTo,
  };
}

export async function saveAllLocationsRingGroup(organizationId: string, raw: unknown) {
  const groupId = String((raw as any)?.groupId ?? '').trim() || null;
  if (groupId && !mongoose.isValidObjectId(groupId)) throw new ApiError(400, 'Choose a department from your Lead Groups.');
  if (groupId && !(await CrmLeadGroup.exists({ _id: groupId, organizationId, isActive: true }))) {
    throw new ApiError(400, 'Choose an active Lead Group.');
  }
  await Organization.updateOne({ _id: organizationId, metadata: null }, { $set: { metadata: {} } });
  const saved = await Organization.updateOne(
    { _id: organizationId },
    groupId ? { $set: { [`metadata.${SETTING}`]: groupId } } : { $unset: { [`metadata.${SETTING}`]: 1 } },
  );
  if (!saved.matchedCount) throw new ApiError(404, 'Organization not found');
  return describeAllLocationsRing(organizationId);
}
