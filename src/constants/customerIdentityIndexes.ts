export type IdentityCollection = 'customers' | 'leads' | 'customeridentitylocks';
export interface IdentityIndex {
  collection: IdentityCollection;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

export const IDENTITY_SCHEMA_OPTIONS = { autoIndex: false, autoCreate: false };

export const CUSTOMER_IDENTITY_INDEXES: IdentityIndex[] = [
  { collection: 'customeridentitylocks', name: 'organizationId_1', key: { organizationId: 1 }, unique: true },
  { collection: 'customers', name: 'organizationId_1_identityCreationKey_1', key: { organizationId: 1, identityCreationKey: 1 }, unique: true, partialFilterExpression: { identityCreationKey: { $type: 'string' } } },
  { collection: 'customers', name: 'organizationId_1_normalizedEmail_1', key: { organizationId: 1, normalizedEmail: 1 } },
  { collection: 'customers', name: 'organizationId_1_normalizedPhone_1', key: { organizationId: 1, normalizedPhone: 1 } },
  { collection: 'customers', name: 'organizationId_1_normalizedAlternatePhone_1', key: { organizationId: 1, normalizedAlternatePhone: 1 } },
  { collection: 'leads', name: 'organizationId_1_customerId_1', key: { organizationId: 1, customerId: 1 } },
  { collection: 'leads', name: 'organizationId_1_normalizedPhone_1', key: { organizationId: 1, normalizedPhone: 1 } },
  { collection: 'leads', name: 'organizationId_1_normalizedEmail_1', key: { organizationId: 1, normalizedEmail: 1 } },
  { collection: 'leads', name: 'customerLink.status_1_customerLink.nextRetryAt_1', key: { 'customerLink.status': 1, 'customerLink.nextRetryAt': 1 } },
  { collection: 'customers', name: 'customer_org_email_present_unique', key: { organizationId: 1, email: 1 }, unique: true, partialFilterExpression: { email: { $type: 'string', $gt: '' } } },
];
