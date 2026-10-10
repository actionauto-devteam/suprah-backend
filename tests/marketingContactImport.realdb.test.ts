import request from 'supertest';
import app from '../src/server';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import MarketingContact from '../src/models/MarketingContact.model';
import EmailOptOut from '../src/models/EmailOptOut.model';
import tokenService from '../src/services/token.service';

function csvBuffer(rows: string[][], headers = ['email', 'firstName', 'lastName']): Buffer {
  const lines = [headers.join(','), ...rows.map((row) => row.join(','))];
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function makeOrgAndAdmin(label: string) {
  const org = await Organization.create({
    name: `${label} Org`,
    slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    status: 'active',
  });
  const user = await User.create({
    email: `${label.toLowerCase().replace(/\s+/g, '-')}-admin-${Date.now()}@example.com`,
    password: 'Password123!',
    name: `${label} Admin`,
    role: 'admin',
    organizationId: org._id,
    organizationRole: 'admin',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  const token = tokenService.generateAccessToken(user);
  return { org, user, token };
}

describe('Marketing Contacts import & management (real-DB)', () => {
  jest.setTimeout(30000);

  let org: any;
  let adminUser: any;
  let adminToken: string;
  let nonAdminUser: any;
  let nonAdminToken: string;
  let otherOrg: any;
  let otherAdminToken: string;

  const createdContactIds: any[] = [];
  const createdOptOutIds: any[] = [];

  beforeAll(async () => {
    ({ org, user: adminUser, token: adminToken } = await makeOrgAndAdmin('MktImport'));

    nonAdminUser = await User.create({
      email: `mktimport-employee-${Date.now()}@example.com`,
      password: 'Password123!',
      name: 'Non Admin',
      role: 'employee',
      organizationId: org._id,
      organizationRole: 'employee',
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    nonAdminToken = tokenService.generateAccessToken(nonAdminUser);

    ({ org: otherOrg, token: otherAdminToken } = await makeOrgAndAdmin('MktImportOther'));
  });

  afterAll(async () => {
    await MarketingContact.deleteMany({ organizationId: { $in: [String(org._id), String(otherOrg._id)] } });
    await EmailOptOut.deleteMany({ organizationId: { $in: [String(org._id), String(otherOrg._id)] } });
    await User.deleteMany({ _id: { $in: [adminUser._id, nonAdminUser._id] } });
    await Organization.deleteMany({ _id: { $in: [org._id, otherOrg._id] } });
  });

  it('rejects import for a non-admin user', async () => {
    const buf = csvBuffer([['nonadmin-test@example.com', 'Jordan', 'Lee']]);
    await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .field('importLabel', 'Non Admin Attempt')
      .field('source', 'Synthetic Test')
      .field('consentStatus', 'unknown')
      .attach('file', buf, 'contacts.csv')
      .expect(403);
  });

  it('preview performs no database writes and returns correct counts', async () => {
    const buf = csvBuffer([
      ['preview-one@example.com', 'Alex', 'One'],
      ['preview-two@example.com', 'Alex', 'Two'],
      ['not-an-email', 'Bad', 'Row'],
      ['preview-two@example.com', 'Alex', 'TwoAgain'],
    ]);

    const before = await MarketingContact.countDocuments({ organizationId: String(org._id) });

    const res = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('importLabel', 'Preview Batch')
      .field('source', 'Synthetic Test')
      .field('consentStatus', 'unknown')
      .attach('file', buf, 'contacts.csv')
      .expect(200);

    expect(res.body.data.counts).toMatchObject({
      totalRows: 4,
      validNew: 2,
      duplicateInFile: 1,
      invalidFormat: 1,
    });
    expect(typeof res.body.data.fingerprint).toBe('string');

    const after = await MarketingContact.countDocuments({ organizationId: String(org._id) });
    expect(after).toBe(before);
  });

  it('rejects confirm with a missing fingerprint', async () => {
    const buf = csvBuffer([['missing-fingerprint@example.com', 'A', 'B']]);
    await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('importLabel', 'Missing FP')
      .field('source', 'Synthetic Test')
      .field('consentStatus', 'unknown')
      .field('confirm', 'true')
      .attach('file', buf, 'contacts.csv')
      .expect(400);
  });

  it('rejects confirm when the settings changed since the preview (fingerprint mismatch)', async () => {
    const buf = csvBuffer([['fp-mismatch@example.com', 'A', 'B']]);

    const preview = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('importLabel', 'Original Label')
      .field('source', 'Synthetic Test')
      .field('consentStatus', 'unknown')
      .attach('file', buf, 'contacts.csv')
      .expect(200);

    const staleFingerprint = preview.body.data.fingerprint;

    await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('importLabel', 'Changed Label After Preview')
      .field('source', 'Synthetic Test')
      .field('consentStatus', 'unknown')
      .field('confirm', 'true')
      .field('fingerprint', staleFingerprint)
      .attach('file', buf, 'contacts.csv')
      .expect(409);

    const stored = await MarketingContact.findOne({ organizationId: String(org._id), email: 'fp-mismatch@example.com' });
    expect(stored).toBeNull();
  });

  it('commits a valid import with correct consent/source/importLabel metadata', async () => {
    const buf = csvBuffer([
      ['commit-one@example.com', 'Commit', 'One'],
      ['commit-two@example.com', 'Commit', 'Two'],
    ]);

    const preview = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('importLabel', 'Commit Batch')
      .field('source', 'Raffle 2026')
      .field('consentStatus', 'claimed_verbal')
      .field('consentNote', 'Verbal confirmation only, no documentary record')
      .attach('file', buf, 'contacts.csv')
      .expect(200);

    const fingerprint = preview.body.data.fingerprint;

    const commit = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('importLabel', 'Commit Batch')
      .field('source', 'Raffle 2026')
      .field('consentStatus', 'claimed_verbal')
      .field('consentNote', 'Verbal confirmation only, no documentary record')
      .field('confirm', 'true')
      .field('fingerprint', fingerprint)
      .attach('file', buf, 'contacts.csv')
      .expect(201);

    expect(commit.body.data.imported).toBe(2);

    const stored = await MarketingContact.find({ organizationId: String(org._id), importLabel: 'Commit Batch' }).lean();
    createdContactIds.push(...stored.map((c: any) => c._id));
    expect(stored).toHaveLength(2);
    expect(stored[0].source).toBe('Raffle 2026');
    expect(stored[0].consentStatus).toBe('claimed_verbal');
    expect(stored[0].consentNote).toBe('Verbal confirmation only, no documentary record');
  });

  it('is idempotent: re-confirming the same file and settings does not create duplicates', async () => {
    const buf = csvBuffer([
      ['commit-one@example.com', 'Commit', 'One'],
      ['commit-two@example.com', 'Commit', 'Two'],
    ]);
    const settings = {
      importLabel: 'Commit Batch',
      source: 'Raffle 2026',
      consentStatus: 'claimed_verbal',
      consentNote: 'Verbal confirmation only, no documentary record',
    };

    const preview = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field(settings)
      .attach('file', buf, 'contacts.csv')
      .expect(200);

    expect(preview.body.data.counts.duplicateExisting).toBe(2);
    expect(preview.body.data.counts.validNew).toBe(0);

    const commit = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field(settings)
      .field('confirm', 'true')
      .field('fingerprint', preview.body.data.fingerprint)
      .attach('file', buf, 'contacts.csv')
      .expect(201);

    expect(commit.body.data.imported).toBe(0);

    const stored = await MarketingContact.find({ organizationId: String(org._id), importLabel: 'Commit Batch' }).lean();
    expect(stored).toHaveLength(2);
  });

  it('excludes suppressed addresses (EmailOptOut) from import', async () => {
    const optOut = await EmailOptOut.create({
      organizationId: String(org._id),
      email: 'suppressed-contact@example.com',
      optedOut: true,
    });
    createdOptOutIds.push(optOut._id);

    const buf = csvBuffer([
      ['suppressed-contact@example.com', 'Should', 'Skip'],
      ['not-suppressed@example.com', 'Should', 'Import'],
    ]);
    const settings = { importLabel: 'Suppression Batch', source: 'Synthetic Test', consentStatus: 'unknown' };

    const preview = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field(settings)
      .attach('file', buf, 'contacts.csv')
      .expect(200);

    expect(preview.body.data.counts.suppressed).toBe(1);
    expect(preview.body.data.counts.validNew).toBe(1);

    const commit = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field(settings)
      .field('confirm', 'true')
      .field('fingerprint', preview.body.data.fingerprint)
      .attach('file', buf, 'contacts.csv')
      .expect(201);

    expect(commit.body.data.imported).toBe(1);

    const suppressedStored = await MarketingContact.findOne({
      organizationId: String(org._id),
      email: 'suppressed-contact@example.com',
    });
    expect(suppressedStored).toBeNull();

    const importedStored = await MarketingContact.findOne({
      organizationId: String(org._id),
      email: 'not-suppressed@example.com',
    });
    expect(importedStored).not.toBeNull();
    if (importedStored) createdContactIds.push(importedStored._id);
  });

  it('removing a MarketingContact never removes the authoritative EmailOptOut suppression record', async () => {
    const contact = await MarketingContact.create({
      organizationId: String(org._id),
      email: 'delete-me-stays-suppressed@example.com',
      source: 'Synthetic Test',
      consentStatus: 'unknown',
      importLabel: 'Deletion Test',
      importedBy: adminUser._id,
    });
    const optOut = await EmailOptOut.create({
      organizationId: String(org._id),
      email: 'delete-me-stays-suppressed@example.com',
      optedOut: true,
    });
    createdOptOutIds.push(optOut._id);

    await request(app)
      .delete(`/api/crm/marketing-contacts/${contact._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const stillSuppressed = await EmailOptOut.findOne({
      organizationId: String(org._id),
      email: 'delete-me-stays-suppressed@example.com',
      optedOut: true,
    });
    expect(stillSuppressed).not.toBeNull();
  });

  it('enforces organization isolation: the same email can exist independently in two orgs', async () => {
    const sharedEmail = 'cross-org-shared@example.com';
    const buf = csvBuffer([[sharedEmail, 'Shared', 'Contact']]);
    const settings = { importLabel: 'Org A Batch', source: 'Synthetic Test', consentStatus: 'unknown' };

    const previewA = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field(settings)
      .attach('file', buf, 'contacts.csv')
      .expect(200);
    await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field(settings)
      .field('confirm', 'true')
      .field('fingerprint', previewA.body.data.fingerprint)
      .attach('file', buf, 'contacts.csv')
      .expect(201);

    const previewB = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${otherAdminToken}`)
      .field({ importLabel: 'Org B Batch', source: 'Synthetic Test', consentStatus: 'unknown' })
      .attach('file', buf, 'contacts.csv')
      .expect(200);

    expect(previewB.body.data.counts.validNew).toBe(1);
    expect(previewB.body.data.counts.duplicateExisting).toBe(0);

    const commitB = await request(app)
      .post('/api/crm/marketing-contacts/import')
      .set('Authorization', `Bearer ${otherAdminToken}`)
      .field({ importLabel: 'Org B Batch', source: 'Synthetic Test', consentStatus: 'unknown' })
      .field('confirm', 'true')
      .field('fingerprint', previewB.body.data.fingerprint)
      .attach('file', buf, 'contacts.csv')
      .expect(201);

    expect(commitB.body.data.imported).toBe(1);

    const inOrgA = await MarketingContact.findOne({ organizationId: String(org._id), email: sharedEmail });
    const inOrgB = await MarketingContact.findOne({ organizationId: String(otherOrg._id), email: sharedEmail });
    expect(inOrgA).not.toBeNull();
    expect(inOrgB).not.toBeNull();
    if (inOrgA) createdContactIds.push(inOrgA._id);
  });

  it('lists and searches imported contacts, scoped to the caller organization', async () => {
    const res = await request(app)
      .get('/api/crm/marketing-contacts')
      .query({ search: 'commit-one' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.data.contacts.some((c: any) => c.email === 'commit-one@example.com')).toBe(true);
    expect(res.body.data.contacts.every((c: any) => c.organizationId === String(org._id))).toBe(true);
  });

  it('does not allow deleting a contact belonging to a different organization', async () => {
    const contact = await MarketingContact.findOne({ organizationId: String(org._id), email: 'commit-one@example.com' });
    expect(contact).not.toBeNull();

    await request(app)
      .delete(`/api/crm/marketing-contacts/${contact!._id}`)
      .set('Authorization', `Bearer ${otherAdminToken}`)
      .expect(404);

    const stillThere = await MarketingContact.findById(contact!._id);
    expect(stillThere).not.toBeNull();
  });
});
