import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Department from '../models/Department.model';
import User, { IUser } from '../models/User.model';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import { getOrgDepartments, getActiveOrgDepartments, invalidateOrgDepartmentCache } from '../services/department.service';

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

// GET /crm/departments — admin management view, includes inactive.
const listAllDepartments = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = actorOrgId(req);
  const departments = await getOrgDepartments(orgId);
  res.json(new ApiResponse(200, departments, 'Departments fetched'));
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
  const { label, color, isMobileMonitoringDept, isTimeEditExempt, isMandatoryLocationDept, isActive } = req.body as {
    label?: string; color?: string; isActive?: boolean;
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

  await department.save();
  invalidateOrgDepartmentCache(orgId);
  res.json(new ApiResponse(200, department, 'Department updated'));
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
  deactivateDepartment,
};
