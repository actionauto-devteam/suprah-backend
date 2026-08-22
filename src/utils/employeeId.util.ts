import CrmUser from "../models/CrmUser.model";

// CrmUser.username doubles as the employee ID shown in User Management, in
// the "YYYY-00001" format. Shared so every path that creates a CrmUser
// (manual Create User, SupraSpace auto-provisioning, etc.) gets a real
// employee ID instead of an ad-hoc slug.
export const resolveNextEmployeeId = async (
  organizationId: string | undefined,
): Promise<string> => {
  const year = new Date().getFullYear();

  const lastUser = await CrmUser.findOne(
    { username: new RegExp(`^${year}-`) },
    { username: 1 },
    { sort: { username: -1 } },
  );

  if (!lastUser) return `${year}-00001`;

  const seq = parseInt(lastUser.username.split("-")[1], 10);
  return `${year}-${String(seq + 1).padStart(5, "0")}`;
};
