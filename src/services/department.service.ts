import Department, { IDepartment } from '../models/Department.model';
import { departmentListCache, invalidateDepartmentCache } from '../utils/cache.util';

export type DepartmentEntry = {
  _id?: string;
  key: string;
  label: string;
  color: string;
  isMobileMonitoringDept: boolean;
  isTimeEditExempt: boolean;
  isMandatoryLocationDept: boolean;
  isActive: boolean;
  sortOrder: number;
};

// Seeded into the database the first time an organization's department list is read (see
// seedLegacyDepartments below) — NOT returned as an in-memory fallback. Every DepartmentEntry
// this service ever hands out is always a real, persisted document with a real _id, so admin
// edit/deactivate always has something valid to target and adding one department can never
// make the others disappear.
const LEGACY_DEPARTMENTS_SEED = [
  { key: 'SalesAndFinance', label: 'Sales & Finance', color: 'emerald', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 0 },
  { key: 'Accounting', label: 'Accounting', color: 'sky', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 1 },
  { key: 'Recon', label: 'Recon', color: 'amber', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 2 },
  { key: 'Marketing', label: 'Marketing', color: 'pink', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 3 },
  { key: 'OnlineTeam', label: 'Online Team', color: 'violet', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 4 },
  { key: 'WebDevTeam', label: 'Web Dev', color: 'blue', isMobileMonitoringDept: false, isTimeEditExempt: true, isMandatoryLocationDept: false, sortOrder: 5 },
  { key: 'WholesaleTeam', label: 'Wholesale', color: 'orange', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 6 },
  { key: 'BuyingTeam', label: 'Buying', color: 'teal', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 7 },
  { key: 'OperationsTeam', label: 'Operations', color: 'rose', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 8 },
  { key: 'LotTechTeam', label: 'Lot Tech', color: 'indigo', isMobileMonitoringDept: true, isTimeEditExempt: false, isMandatoryLocationDept: true, sortOrder: 9 },
  { key: 'FundingTeam', label: 'Funding', color: 'lime', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 10 },
  { key: 'ProspectsTeam', label: 'Prospects', color: 'cyan', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 11 },
  { key: 'PriceCheckTeam', label: 'Price Check', color: 'fuchsia', isMobileMonitoringDept: false, isTimeEditExempt: false, isMandatoryLocationDept: false, sortOrder: 12 },
];

function cacheKeyFor(organizationId?: string | null): string {
  return organizationId ? organizationId.toString() : 'none';
}

type DepartmentLike = Pick<
  IDepartment,
  'key' | 'label' | 'color' | 'isMobileMonitoringDept' | 'isTimeEditExempt' | 'isMandatoryLocationDept' | 'isActive' | 'sortOrder'
> & { _id?: unknown };

function toEntry(doc: DepartmentLike): DepartmentEntry {
  return {
    _id: doc._id ? String(doc._id) : undefined,
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

function departmentQuery(organizationId?: string | null): Record<string, unknown> {
  return organizationId ? { organizationId } : { organizationId: { $exists: false } };
}

// Upserts each legacy entry individually (insert only if that key doesn't already exist for
// this org) rather than an all-or-nothing bulk insert. This converges correctly no matter what
// state the org's Department collection is already in — zero rows, a partial/stray set from an
// earlier bug, or already fully seeded — since $setOnInsert never touches an existing document.
async function ensureLegacyDepartmentsSeeded(organizationId?: string | null): Promise<void> {
  const orgFilter = organizationId || { $exists: false };
  await Promise.all(
    LEGACY_DEPARTMENTS_SEED.map((d) =>
      Department.updateOne(
        { organizationId: orgFilter, key: d.key },
        { $setOnInsert: { ...d, organizationId: organizationId || undefined, isActive: true } },
        { upsert: true }
      ).catch((error) => {
        console.error(`ensureLegacyDepartmentsSeeded: failed to upsert "${d.key}":`, error);
      })
    )
  );
}

/** All departments (active + inactive) for the org, cached. Every read that misses the cache
 * ensures the legacy default set exists as real documents before returning — never fabricates
 * in-memory entries without a real _id, and self-heals an org whose Department collection is
 * empty, partially seeded, or already complete. */
export async function getOrgDepartments(organizationId?: string | null): Promise<DepartmentEntry[]> {
  const cacheKey = cacheKeyFor(organizationId);
  const cached = departmentListCache.get(cacheKey);
  if (cached) return cached as DepartmentEntry[];

  await ensureLegacyDepartmentsSeeded(organizationId);

  const query = departmentQuery(organizationId);
  const docs = await Department.find(query).sort({ sortOrder: 1, label: 1 }).lean();

  const result = docs.map(toEntry);
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
