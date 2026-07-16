import { findDepartmentEntry } from '../services/department.service';

export const isMandatoryLocationDept = async (
  organizationId: string | undefined | null,
  dept?: string | null
): Promise<boolean> => {
  const entry = await findDepartmentEntry(organizationId, dept);
  return !!entry?.isMandatoryLocationDept;
};
