import Department, { IDepartment } from '../models/Department.model';
import { departmentListCache, invalidateDepartmentCache } from '../utils/cache.util';

export type DepartmentEntry = {
  key: string;
  label: string;
  color: string;
  isMobileMonitoringDept: boolean;
  isTimeEditExempt: boolean;
  isMandatoryLocationDept: boolean;
  isActive: boolean;
  sortOrder: number;
};

// Fallback used only for an organization that has never had its Department list seeded yet
// (e.g. a brand-new org, or before the one-time backfill/seed script has run) — keeps every
// department-aware feature working instead of showing an empty list.
const LEGACY_DEPARTMENTS: DepartmentEntry[] = [
  { key: 'SalesAndFinance', label: 'Sales & Finance', color: 'emerald', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 0 },
  { key: 'Accounting', label: 'Accounting', color: 'sky', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 1 },
  { key: 'Recon', label: 'Recon', color: 'amber', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 2 },
  { key: 'Marketing', label: 'Marketing', color: 'pink', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 3 },
  { key: 'OnlineTeam', label: 'Online Team', color: 'violet', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 4 },
  { key: 'WebDevTeam', label: 'Web Dev', color: 'blue', isMobileMonitoringDept: false, isTimeEditExempt: true, isMandatoryLocationDept: false, isActive: true, sortOrder: 5 },
  { key: 'WholesaleTeam', label: 'Wholesale', color: 'orange', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 6 },
  { key: 'BuyingTeam', label: 'Buying', color: 'teal', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 7 },
  { key: 'OperationsTeam', label: 'Operations', color: 'rose', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 8 },
  { key: 'LotTechTeam', label: 'Lot Tech', color: 'indigo', isMobileMonitoringDept: true, isTimeEditExempt: false, isMandatoryLocationDept: true, isActive: true, sortOrder: 9 },
  { key: 'FundingTeam', label: 'Funding', color: 'lime', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 10 },
  { key: 'ProspectsTeam', label: 'Prospects', color: 'cyan', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 11 },
  { key: 'PriceCheckTeam', label: 'Price Check', color: 'fuchsia', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, isActive: true, sortOrder: 12 },
];

function cacheKeyFor(organizationId?: string | null): string {
  return organizationId ? organizationId.toString() : 'none';
}

type DepartmentLike = Pick<
  IDepartment,
  'key' | 'label' | 'color' | 'isMobileMonitoringDept' | 'isTimeEditExempt' | 'isMandatoryLocationDept' | 'isActive' | 'sortOrder'
>;

function toEntry(doc: DepartmentLike): DepartmentEntry {
  return {
    key: doc.key,
    label: doc.label,
    color: doc.color,
    isMobileMonitoringDept: doc.isMobileMonitoringDept,
    isTimeEditExempt: doc.isTimeEditExempt,
    isMandatoryLocationDept: doc.isMandatoryLocationDept,
    isActive: doc.isActive,
    sortOrder: doc.sortOrder,
  };
}

/** All departments (active + inactive) for the org, cached. Falls back to the legacy hardcoded
 * list if the org has none yet, so nothing breaks before/without seeding. */
export async function getOrgDepartments(organizationId?: string | null): Promise<DepartmentEntry[]> {
  const cacheKey = cacheKeyFor(organizationId);
  const cached = departmentListCache.get(cacheKey);
  if (cached) return cached as DepartmentEntry[];

  const query: Record<string, unknown> = organizationId
    ? { organizationId }
    : { organizationId: { $exists: false } };

  const docs = await Department.find(query).sort({ sortOrder: 1, label: 1 }).lean();
  const result = docs.length > 0 ? docs.map(toEntry) : LEGACY_DEPARTMENTS;
  departmentListCache.set(cacheKey, result);
  return result;
}

export async function getActiveOrgDepartments(organizationId?: string | null): Promise<DepartmentEntry[]> {
  const all = await getOrgDepartments(organizationId);
  return all.filter((d) => d.isActive);
}

/** Resolves a raw stored department value (a current key, a legacy label, or unrecognized
 * free text) to its canonical entry, searching both active and inactive departments so an
 * employee on a deactivated department still resolves correctly. */
export async function findDepartmentEntry(
  organizationId: string | undefined | null,
  raw?: string | null
): Promise<DepartmentEntry | undefined> {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const all = await getOrgDepartments(organizationId);
  return all.find(
    (d) => d.key === trimmed || d.label.toLowerCase() === trimmed.toLowerCase()
  );
}

/** Normalizes an incoming department value to its canonical key. Unrecognized values are
 * passed through trimmed (legacy free-text data, not a new admin-created department — those
 * are only created via the Department CRUD endpoints). */
export async function normalizeDepartmentValue(
  organizationId: string | undefined | null,
  raw?: string | null
): Promise<string | undefined> {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const entry = await findDepartmentEntry(organizationId, trimmed);
  return entry ? entry.key : trimmed;
}

export function invalidateOrgDepartmentCache(organizationId?: string | null) {
  invalidateDepartmentCache(organizationId ? organizationId.toString() : undefined);
}
