export const CRM_STAFF_EVENTS = new Set<string>([
  'lead:new',
  'lead:update',
  'lead:review',
  'lead:delete',
  'comm:message:new',
  'comm:message:status',
  'comm:ai_paused',
  'comm:call:incoming',
  'comm:call:update',
  'comm:call:removed',
  'webchat:message',
  'webchat:ai_paused',
  'email:message:new',
  'email:ai_paused',
  'appointment:new',
  'appointment:status_updated',
  'referral:new_lead',
  'deal:created',
  'deal:updated',
  'deal:moved',
  'deal:deleted',
]);

export function crmStaffRoom(orgId: string): string {
  return `org:${orgId}:crm-staff`;
}

export function orgEventRoom(orgId: string, event: string): string {
  return CRM_STAFF_EVENTS.has(event) ? crmStaffRoom(orgId) : `org:${orgId}`;
}
