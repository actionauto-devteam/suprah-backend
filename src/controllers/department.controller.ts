import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Department from '../models/Department.model';
import User, { IUser } from '../models/User.model';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import { getOrgDepartments, getActiveOrgDepartments, getDefaultDepartmentKey, invalidateOrgDepartmentCache } from '../services/department.service';
import { cascadeDepartmentToLinkedUser } from '../utils/departmentSync.util';
import { invalidateUserCache } from '../utils/cache.util';

function requireAdmin(req: Request) {
  const crmUser = req.crmUser as ICrmUser | undefined;
  const mainUser = req.user as IUser | undefined;
  const actor = crmUser || mainUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!['admin', 'super_admin'].includes(actor.role)) {
    throw new ApiError(403, 'Only admins can manage departments');
  }
  return actor;
}

function actorOrgId(req: Request): string | undefined {
  const crmUser = req.crmUser as ICrmUser | undefined;
  const mainUser = req.user as IUser | undefined;
  const orgId = crmUser?.organizationId || mainUser?.organizationId || (req as any).orgId;
  return orgId ? orgId.toString() : undefined;
}

// GET /api/departments — read-only, dual-auth (User or CrmUser), active departments only.
const listActiveDepartments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = actorOrgId(req);
  const departments = await getActiveOrgDepartments(orgId);
  res.json(new ApiResponse(200, departments, 'Departments fetched'));
});

// Headcount per department key, deduped by email (a person can have both a CrmUser and a
// linked main-site User — the CrmUser row wins as the canonical identity, same rule as
// listDepartmentMembers below) so the count an admin sees always matches who they'd actually
// find inside "Manage Members".
async function getMemberCountsByDepartment(orgId: string | undefined): Promise<Record<string, number>> {
  const [crmUsers, mainUsers] = await Promise.all([
    CrmUser.find({ organizationId: orgId }).select('email department').lean(),
    User.find({ organizationId: orgId }).select('email personalInfo.department').lean(),
  ]);

  const emailToDept = new Map<string, string | undefined>();
  for (const u of crmUsers) emailToDept.set(u.email.toLowerCase(), u.department);
  for (const u of mainUsers) {
    const email = u.email.toLowerCase();
    if (!emailToDept.has(email)) emailToDept.set(email, u.personalInfo?.department);
  }

  const counts: Record<string, number> = {};
  for (const dept of emailToDept.values()) {
    if (!dept) continue;
    counts[dept] = (counts[dept] || 0) + 1;
  }
  return counts;
}

// GET /crm/departments — admin management view, includes inactive, enriched with live headcount.
const listAllDepartments = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const [departments, counts] = await Promise.all([
    getOrgDepartments(orgId),
    getMemberCountsByDepartment(orgId),
  ]);
  const enriched = departments.map((d) => ({ ...d, memberCount: counts[d.key] || 0 }));
  res.json(new ApiResponse(200, enriched, 'Departments fetched'));
});

function slugifyKey(label: string): string {
  return label
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

const createDepartment = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const { label, color, isMobileMonitoringDept, isTimeEditExempt, isMandatoryLocationDept } = req.body as {
    label?: string; color?: string;
    isMobileMonitoringDept?: boolean; isTimeEditExempt?: boolean; isMandatoryLocationDept?: boolean;
  };

  if (!label?.trim()) throw new ApiError(400, 'Department label is required');

  const key = slugifyKey(label);
  if (!key) throw new ApiError(400, 'Department label must contain at least one letter or number');

  const existing = await Department.findOne({ organizationId: orgId, key });
  if (existing) throw new ApiError(409, 'A department with that name already exists');

  const count = await Department.countDocuments({ organizationId: orgId });

  const department = await Department.create({
    organizationId: orgId,
    key,
    label: label.trim(),
    color: color || 'emerald',
    isMobileMonitoringDept: !!isMobileMonitoringDept,
    isTimeEditExempt: !!isTimeEditExempt,
    isMandatoryLocationDept: !!isMandatoryLocationDept,
    isActive: true,
    sortOrder: count,
  });

  invalidateOrgDepartmentCache(orgId);
  res.status(201).json(new ApiResponse(201, department, 'Department created'));
});

const updateDepartment = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const { id } = req.params;
  const { label, color, isMobileMonitoringDept, isTimeEditExempt, isMandatoryLocationDept, isActive, isDefault } = req.body as {
    label?: string; color?: string; isActive?: boolean; isDefault?: boolean;
    isMobileMonitoringDept?: boolean; isTimeEditExempt?: boolean; isMandatoryLocationDept?: boolean;
  };

  const department = await Department.findOne({ _id: id, organizationId: orgId });
  if (!department) throw new ApiError(404, 'Department not found');

  if (label?.trim()) department.label = label.trim();
  if (color !== undefined) department.color = color;
  if (isMobileMonitoringDept !== undefined) department.isMobileMonitoringDept = !!isMobileMonitoringDept;
  if (isTimeEditExempt !== undefined) department.isTimeEditExempt = !!isTimeEditExempt;
  if (isMandatoryLocationDept !== undefined) department.isMandatoryLocationDept = !!isMandatoryLocationDept;
  if (isActive !== undefined) department.isActive = !!isActive;
  if (isDefault !== undefined) {
    if (isDefault) {
      await Department.updateMany({ organizationId: orgId, _id: { $ne: id } }, { $set: { isDefault: false } });
    }
    department.isDefault = !!isDefault;
  }

  await department.save();
  invalidateOrgDepartmentCache(orgId);
  res.json(new ApiResponse(200, department, 'Department updated'));
});

// Bulk sortOrder update — body is the full ordered list of department ids for this org.
const reorderDepartments = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const { order } = req.body as { order?: string[] };
  if (!Array.isArray(order) || order.length === 0) {
    throw new ApiError(400, 'order must be a non-empty array of department ids');
  }

  await Promise.all(
    order.map((id, index) => Department.updateOne({ _id: id, organizationId: orgId }, { $set: { sortOrder: index } }))
  );

  invalidateOrgDepartmentCache(orgId);
  const departments = await getOrgDepartments(orgId);
  res.json(new ApiResponse(200, departments, 'Departments reordered'));
});

// GET /crm/departments/:id/members — merges CrmUser + linked-User rows on this department key,
// deduped by email (a physical person can have both accounts linked by email; the CrmUser row
// is the canonical admin-facing identity, so it wins).
const listDepartmentMembers = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const { id } = req.params;

  const department = await Department.findOne({ _id: id, organizationId: orgId });
  if (!department) throw new ApiError(404, 'Department not found');

  const [crmMembers, userMembers] = await Promise.all([
    CrmUser.find({ organizationId: orgId, department: department.key })
      .select('fullName email avatar role isActive')
      .lean(),
    User.find({ organizationId: orgId, 'personalInfo.department': department.key })
      .select('name email avatar role isActive')
      .lean(),
  ]);

  const seenEmails = new Set<string>();
  const members: Array<{ id: string; source: 'crm' | 'user'; name: string; email: string; avatar?: string; role: string; isActive: boolean }> = [];

  for (const m of crmMembers) {
    members.push({ id: String(m._id), source: 'crm', name: m.fullName, email: m.email, avatar: m.avatar, role: m.role, isActive: m.isActive });
    seenEmails.add(m.email.toLowerCase());
  }
  for (const m of userMembers) {
    if (seenEmails.has(m.email.toLowerCase())) continue;
    members.push({ id: String(m._id), source: 'user', name: m.name, email: m.email, avatar: m.avatar, role: m.role, isActive: m.isActive });
  }

  res.json(new ApiResponse(200, { department: department.key, members }, 'Members fetched'));
});

// PATCH /crm/departments/:id/members/:memberId — one-click removal instead of hunting the
// member down in the full team table: moves them to the org's default department (or clears
// the field entirely if no default is set).
const removeDepartmentMember = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const { memberId } = req.params;
  const { source } = req.body as { source?: 'crm' | 'user' };
  if (source !== 'crm' && source !== 'user') throw new ApiError(400, 'source must be "crm" or "user"');

  const fallbackKey = await getDefaultDepartmentKey(orgId);

  if (source === 'crm') {
    const member = await CrmUser.findOne({ _id: memberId, organizationId: orgId });
    if (!member) throw new ApiError(404, 'Member not found');
    member.department = fallbackKey;
    await member.save();
    await cascadeDepartmentToLinkedUser({
      email: member.email,
      organizationId: member.organizationId,
      crmUserId: member._id,
      department: fallbackKey,
    });
  } else {
    const member = await User.findOne({ _id: memberId, organizationId: orgId });
    if (!member) throw new ApiError(404, 'Member not found');
    member.personalInfo = { ...(member.personalInfo || {}), department: fallbackKey };
    await member.save();
    invalidateUserCache((member._id as any).toString());
  }

  invalidateOrgDepartmentCache(orgId);
  res.json(new ApiResponse(200, { fallbackKey }, fallbackKey ? 'Member moved to default department' : 'Member removed from department'));
});

// Deletes for real when nobody is currently assigned to this department (safe — nothing can be
// orphaned). If anyone is still on it, falls back to a soft deactivate instead: hidden from
// selection dropdowns but stays resolvable so those members keep a real label/color instead of
// a blank badge. Re-clicking delete once everyone's been moved off will remove it for real.
const deactivateDepartment = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const { id } = req.params;

  const department = await Department.findOne({ _id: id, organizationId: orgId });
  if (!department) throw new ApiError(404, 'Department not found');

  const [crmUserCount, userCount] = await Promise.all([
    CrmUser.countDocuments({ organizationId: orgId, department: department.key }),
    User.countDocuments({ organizationId: orgId, 'personalInfo.department': department.key }),
  ]);
  const memberCount = crmUserCount + userCount;

  if (memberCount === 0) {
    await Department.deleteOne({ _id: id });
    invalidateOrgDepartmentCache(orgId);
    res.json(new ApiResponse(200, { ...department.toObject(), deleted: true }, 'Department deleted'));
    return;
  }

  department.isActive = false;
  await department.save();
  invalidateOrgDepartmentCache(orgId);
  res.json(new ApiResponse(200, { ...department.toObject(), deleted: false, memberCount }, `Department deactivated — ${memberCount} member(s) still assigned`));
});

export default {
  listActiveDepartments,
  listAllDepartments,
  createDepartment,
  updateDepartment,
  reorderDepartments,
  listDepartmentMembers,
  removeDepartmentMember,
  deactivateDepartment,
};
