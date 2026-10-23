import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import { MAX_MATCHED_LEADS, findContactRestriction, findLeadAssociation } from '../src/services/leadLifecycle.service';

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const createdBy = new mongoose.Types.ObjectId();
const phone = (suffix: string) => `+138555501${suffix}`;

const ids = {
  closed: new mongoose.Types.ObjectId(),
  inFinance: new mongoose.Types.ObjectId(),
  multiA: new mongoose.Types.ObjectId(),
  multiB: new mongoose.Types.ObjectId(),
  otherOrg: new mongoose.Types.ObjectId(),
  legacy: new mongoose.Types.ObjectId(),
  relay: new mongoose.Types.ObjectId(),
  dnc: new mongoose.Types.ObjectId(),
  dncLegacy: new mongoose.Types.ObjectId(),
  dncCustomer: new mongoose.Types.ObjectId(),
  dncOtherOrg: new mongoose.Types.ObjectId(),
  dncLegacyPhone: new mongoose.Types.ObjectId(),
  scaleTarget: new mongoose.Types.ObjectId(),
};
const orgC = new mongoose.Types.ObjectId();
const customerPat = new mongoose.Types.ObjectId();
const customerX = new mongoose.Types.ObjectId();
const customerY = new mongoose.Types.ObjectId();
const customerDnc = new mongoose.Types.ObjectId();

const lead = (id: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId, fields: Record<string, unknown>) => ({
  _id: id,
  organizationId,
  createdBy,
  firstName: 'Test',
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-05T10:00:00Z'),
  ...fields,
});

describe('Real-DB L1: lifecycle matching and Do Not Contact lookup', () => {
  beforeAll(async () => {
    jest.setTimeout(60000);
    await Customer.collection.insertMany([
      { _id: customerPat, organizationId: String(orgA), createdBy, firstName: 'Pat', email: 'pat@example.com', phone: phone('11'), isActive: true },
      { _id: customerX, organizationId: String(orgA), createdBy, firstName: 'X', phone: phone('14'), isActive: true },
      { _id: customerY, organizationId: String(orgA), createdBy, firstName: 'Y', email: 'y@example.com', isActive: true },
    ]);
    await Lead.collection.insertMany([
      lead(ids.closed, orgA, {
        status: 'Closed',
        customerId: customerPat,
        phone: phone('11'),
        email: 'pat@example.com',
        normalizedPhone: phone('11'),
        normalizedEmail: 'pat@example.com',
        statusHistory: [{ from: 'New', to: 'Closed', changedAt: new Date('2026-10-05T10:00:00Z') }],
      }),
      lead(ids.inFinance, orgA, { status: 'In Finance', phone: phone('12'), normalizedPhone: phone('12'), normalizedEmail: null }),
      lead(ids.multiA, orgA, { status: 'New', phone: phone('13'), normalizedPhone: phone('13'), normalizedEmail: null }),
      lead(ids.multiB, orgA, { status: 'Working', phone: phone('13'), normalizedPhone: phone('13'), normalizedEmail: null }),
      lead(ids.otherOrg, orgB, { status: 'New', phone: phone('15'), normalizedPhone: phone('15'), normalizedEmail: null }),
      lead(ids.legacy, orgA, { status: 'Contacted', phone: '(385) 555-0177' }),
      lead(ids.relay, orgA, {
        status: 'New',
        email: 'relay@dealer-mail.com',
        identityEmailExcluded: true,
        normalizedPhone: null,
        normalizedEmail: null,
      }),
      lead(ids.dnc, orgA, { status: 'Do Not Contact', phone: phone('18'), normalizedPhone: phone('18'), normalizedEmail: null }),
      lead(ids.dncLegacy, orgA, { status: 'Do Not Contact', email: 'Old.Customer@Example.com' }),
      lead(ids.dncCustomer, orgA, { status: 'Do Not Contact', customerId: customerDnc, normalizedPhone: null, normalizedEmail: null }),
      lead(ids.dncOtherOrg, orgB, { status: 'Do Not Contact', phone: phone('19'), normalizedPhone: phone('19'), normalizedEmail: null }),
      lead(ids.dncLegacyPhone, orgA, { status: 'Do Not Contact', phone: '(385) 555-0196' }),
    ]);
  });

  afterAll(async () => {
    await Lead.deleteMany({ organizationId: { $in: [orgA, orgB, orgC] } });
    await Customer.deleteMany({ organizationId: { $in: [String(orgA), String(orgB)] } });
  });

  it('creates a new lead when the customer only has a finished lead', async () => {
    const decision = await findLeadAssociation({ organizationId: String(orgA), phone: '385-555-0111', email: 'PAT@example.com' });
    expect(decision).toMatchObject({ action: 'create', reason: 'previous_lead_finished', previousLeadIds: [String(ids.closed)] });
    expect(decision.identity).toMatchObject({ status: 'linked', customerId: String(customerPat) });
    expect(decision.candidates[0].terminalAt).toEqual(new Date('2026-10-05T10:00:00Z'));
  });

  it('appends to a single active In Finance lead', async () => {
    const decision = await findLeadAssociation({ organizationId: String(orgA), phone: '(385) 555-0112' });
    expect(decision).toMatchObject({ action: 'append', leadId: String(ids.inFinance) });
  });

  it('holds for review with several active leads, unless a reliable context lead is given', async () => {
    const ambiguous = await findLeadAssociation({ organizationId: String(orgA), phone: phone('13') });
    expect(ambiguous).toMatchObject({ action: 'review', reason: 'multiple_active_leads' });
    expect(ambiguous.candidateLeadIds.sort()).toEqual([String(ids.multiA), String(ids.multiB)].sort());
    const withContext = await findLeadAssociation({ organizationId: String(orgA), phone: phone('13'), contextLeadId: ids.multiB });
    expect(withContext).toMatchObject({ action: 'append', leadId: String(ids.multiB), reason: 'context_lead' });
  });

  it('never associates when phone and email point to different customers', async () => {
    const decision = await findLeadAssociation({ organizationId: String(orgA), phone: phone('14'), email: 'y@example.com' });
    expect(decision).toMatchObject({ action: 'review', reason: 'identity_ambiguous' });
  });

  it('never matches or uses a lead from another organization', async () => {
    const decision = await findLeadAssociation({ organizationId: String(orgA), phone: phone('15'), contextLeadId: ids.otherOrg });
    expect(decision).toMatchObject({ action: 'create', reason: 'no_matching_lead', candidateLeadIds: [] });
    const own = await findLeadAssociation({ organizationId: String(orgB), phone: phone('15') });
    expect(own).toMatchObject({ action: 'append', leadId: String(ids.otherOrg) });
  });

  it('matches an older lead that has no normalized contact fields', async () => {
    const decision = await findLeadAssociation({ organizationId: String(orgA), phone: '+1 385 555 0177' });
    expect(decision).toMatchObject({ action: 'append', leadId: String(ids.legacy) });
  });

  it('does not match a lead whose email is a relay address excluded from identity', async () => {
    const decision = await findLeadAssociation({ organizationId: String(orgA), email: 'relay@dealer-mail.com' });
    expect(decision).toMatchObject({ action: 'create', reason: 'no_matching_lead' });
  });

  it('finds Do Not Contact by phone, by email on an older lead, and by customer', async () => {
    expect(await findContactRestriction({ organizationId: String(orgA), phone: '385-555-0118' })).toEqual({
      restricted: true,
      leadIds: [String(ids.dnc)],
    });
    expect(await findContactRestriction({ organizationId: String(orgA), email: 'old.customer@example.com' })).toEqual({
      restricted: true,
      leadIds: [String(ids.dncLegacy)],
    });
    expect(await findContactRestriction({ organizationId: String(orgA), customerId: customerDnc })).toEqual({
      restricted: true,
      leadIds: [String(ids.dncCustomer)],
    });
  });

  it('keeps Do Not Contact inside its organization and ignores other customers', async () => {
    expect((await findContactRestriction({ organizationId: String(orgA), phone: phone('19') })).restricted).toBe(false);
    expect((await findContactRestriction({ organizationId: String(orgB), phone: phone('19') })).restricted).toBe(true);
    expect((await findContactRestriction({ organizationId: String(orgA), phone: phone('12') })).restricted).toBe(false);
    expect(await findContactRestriction({ organizationId: String(orgA) })).toEqual({ restricted: false, leadIds: [] });
  });

  it('records a new contact from a Do Not Contact customer as a new lead while the restriction still applies', async () => {
    const decision = await findLeadAssociation({ organizationId: String(orgA), phone: phone('18') });
    const restriction = await findContactRestriction({ organizationId: String(orgA), phone: phone('18') });
    expect(decision).toMatchObject({ action: 'create', previousLeadIds: [String(ids.dnc)] });
    expect(restriction.restricted).toBe(true);
  });

  it('finds Do Not Contact on an older lead by its unformatted phone', async () => {
    expect(await findContactRestriction({ organizationId: String(orgA), phone: '+1 385 555 0196' })).toEqual({
      restricted: true,
      leadIds: [String(ids.dncLegacyPhone)],
    });
  });

  it('finds an older active lead even when thousands of older leads exist', async () => {
    const filler = Array.from({ length: 2100 }, (_, index) => ({
      organizationId: orgC,
      createdBy,
      firstName: `Old ${index}`,
      status: 'Contacted',
      phone: `(801) 4${String(index).padStart(2, '0').slice(-2)}-${String(1000 + index).slice(-4)}`,
    }));
    await Lead.collection.insertMany(filler);
    await Lead.collection.insertOne({ _id: ids.scaleTarget, organizationId: orgC, createdBy, firstName: 'Target', status: 'Working', phone: '385.555.0199' });
    const decision = await findLeadAssociation({ organizationId: String(orgC), phone: '(385) 555-0199' });
    expect(decision).toMatchObject({ action: 'append', leadId: String(ids.scaleTarget), lookupComplete: true });
  });

  it('returns an incomplete lookup for review instead of guessing when too many leads match', async () => {
    const indexedPhone = phone('98');
    await Lead.collection.insertMany(
      Array.from({ length: MAX_MATCHED_LEADS + 1 }, (_, index) => ({
        organizationId: orgC,
        createdBy,
        firstName: `Shared ${index}`,
        status: 'Closed',
        phone: indexedPhone,
        normalizedPhone: indexedPhone,
        normalizedEmail: null,
      })),
    );
    const indexed = await findLeadAssociation({ organizationId: String(orgC), phone: indexedPhone });
    expect(indexed).toMatchObject({ action: 'review', reason: 'lookup_incomplete', lookupComplete: false });

    await Lead.collection.insertMany(
      Array.from({ length: MAX_MATCHED_LEADS + 1 }, (_, index) => ({
        organizationId: orgC,
        createdBy,
        firstName: `Old shared ${index}`,
        status: 'Closed',
        phone: '385-555-0197',
      })),
    );
    const legacy = await findLeadAssociation({ organizationId: String(orgC), phone: phone('97') });
    expect(legacy).toMatchObject({ action: 'review', reason: 'lookup_incomplete', lookupComplete: false });
  });

  it('leaves every seeded record unchanged', async () => {
    const docs: any[] = await Lead.find({ organizationId: { $in: [orgA, orgB] } }).lean();
    expect(docs).toHaveLength(12);
    expect(docs.every((doc) => doc.sourceInquiryId === undefined && doc.inquiryCount === undefined)).toBe(true);
    const closed = docs.find((doc) => String(doc._id) === String(ids.closed));
    expect(closed.status).toBe('Closed');
  });
});
