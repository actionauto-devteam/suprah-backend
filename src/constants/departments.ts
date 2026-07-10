export const MANDATORY_LOCATION_DEPARTMENTS = ['LotTechTeam'];

export const isMandatoryLocationDept = (dept?: string | null): boolean =>
    !!dept && MANDATORY_LOCATION_DEPARTMENTS.includes(dept);
