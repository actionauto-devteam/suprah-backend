jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: jest.fn() }, messages: { get: jest.fn(), list: jest.fn(), send: jest.fn(), modify: jest.fn(), batchModify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), once: jest.fn(), credentials: {} })) },
    calendar: jest.fn(() => ({ events: {}, channels: {} })),
    oauth2: jest.fn(() => ({ userinfo: { get: jest.fn() } })),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));

import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import {
  NOTICE_CARD_REASON,
  foldRepeatedInquiries,
  moveNoticeCardsToOthers,
  previewOpenDuplicateCards,
} from '../src/services/leadDuplicateCleanup.service';

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);
const truck = { year: '2021', make: 'Ford', model: 'F-150', vin: '1FTFW1E50MFA00001' };
const sedan = { year: '2020', make: 'Honda', model: 'Civic', vin: '2HGFC2F59LH000002' };
let serial = 0;
const nextEmail = () => `p73clean${Date.now()}${++serial}@example.com`;

const noticeCard = (extra: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  firstName: 'Unknown',
  lastName: '',
  email: 'leads@dealerscloud.com',
  identityEmailExcluded: true,
  source: 'Email Inquiry',
  channel: 'adf',
  phone: '',
  status: 'New',
  subject: 'New Prospect 2023 HYUNDAI TUCSON',
  body: 'New Prospect\nName: Pat Doe\nVehicle: 2023 Hyundai Tucson',
  createdBy: new mongoose.Types.ObjectId(),
  ...extra,
});

async function seedLead(extra: Record<string, unknown> = {}) {
  const { insertedId } = await Lead.collection.insertOne({
    organizationId: orgId, firstName: 'Real', lastName: `Buyer${++serial}`, email: nextEmail(), phone: '', status: 'New',
    source: 'Email Lead', channel: 'email', createdBy: new mongoose.Types.ObjectId(), createdAt: new Date(), updatedAt: new Date(), ...extra,
  } as any);
  return insertedId;
}

async function seedInquiry(leadId: mongoose.Types.ObjectId, outcome: string, receivedAt: Date, extra: Record<string, unknown> = {}) {
  const doc = await LeadInquiry.create({
    organizationId: orgId,
    kind: 'provider_inquiry',
    receivedAt,
    channel: 'email',
    source: 'Email Lead',
    sourceProvider: 'Cars.com',
    contact: { email: 'buyer@example.com' },
    vehicle: truck,
    comments: 'Is the truck available?',
    association: { state: 'associated', outcome, leadId },
    ...extra,
  });
  return doc;
}

describe('Real-DB: Phase 73 one-time cleanup (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), OrgLeadConfig.init()]);
    await OrgLeadConfig.collection.insertMany([
      { organizationId: orgId, leadSourceEmail: 'leads@dealerscloud.com', gmailAddress: 'leads@dealer-p73.test', notLeadSenders: [] },
      { organizationId: otherOrgId, leadSourceEmail: 'leads@dealerscloud.com', gmailAddress: 'leads@other-p73.test', notLeadSenders: [] },
    ] as any[]);
  });

  describe('DealersCloud notice cards', () => {
    it('previews without changing anything, then moves only untouched or closed notice cards to Not a Lead with a reason', async () => {
      const ids = {
        fresh: (await Lead.collection.insertOne(noticeCard() as any)).insertedId,
        otherAddress: (await Lead.collection.insertOne(noticeCard({ email: 'notices@dealerscloud.com', firstName: '' }) as any)).insertedId,
        closed: (await Lead.collection.insertOne(noticeCard({ status: 'Bad Lead' }) as any)).insertedId,
        worked: (await Lead.collection.insertOne(noticeCard({ status: 'Contacted' }) as any)).insertedId,
        dnc: (await Lead.collection.insertOne(noticeCard({ status: 'Do Not Contact' }) as any)).insertedId,
        sold: (await Lead.collection.insertOne(noticeCard({ status: 'Sold' }) as any)).insertedId,
        adf: (await Lead.collection.insertOne(noticeCard({ body: '<?xml version="1.0"?><?adf version="1.0"?><adf><prospect></prospect></adf>' }) as any)).insertedId,
        named: (await Lead.collection.insertOne(noticeCard({ firstName: 'Pat', lastName: 'Doe' }) as any)).insertedId,
        withPhone: (await Lead.collection.insertOne(noticeCard({ phone: '+18015551234' }) as any)).insertedId,
        combined: (await Lead.collection.insertOne(noticeCard({ combinedInto: { leadId: new mongoose.Types.ObjectId(), at: new Date() } }) as any)).insertedId,
        otherOrg: (await Lead.collection.insertOne(noticeCard({ organizationId: otherOrgId }) as any)).insertedId,
      };

      const preview = await moveNoticeCardsToOthers({ apply: false, organizationId: ORG });
      expect(preview).toHaveLength(1);
      expect(preview[0]).toMatchObject({ organizationId: ORG, sender: '@dealerscloud.com', found: 6, moved: 0 });
      expect(preview[0].movable.map((lead) => lead.leadId).sort()).toEqual([ids.fresh, ids.otherAddress, ids.closed].map(String).sort());
      expect(preview[0].forStaff.map((lead) => lead.leadId).sort()).toEqual([ids.worked, ids.dnc, ids.sold].map(String).sort());
      expect((await Lead.findById(ids.fresh).lean<any>()).status).toBe('New');

      const applied = await moveNoticeCardsToOthers({ apply: true, organizationId: ORG });
      expect(applied[0]).toMatchObject({ moved: 3, changedMeanwhile: 0 });
      for (const id of [ids.fresh, ids.otherAddress, ids.closed]) {
        const lead = await Lead.findById(id).lean<any>();
        expect(lead.status).toBe('Not a Lead');
        expect(lead.statusHistory[lead.statusHistory.length - 1]).toMatchObject({ to: 'Not a Lead', reason: NOTICE_CARD_REASON });
      }
      for (const id of [ids.worked, ids.dnc, ids.sold, ids.adf, ids.named, ids.withPhone, ids.combined, ids.otherOrg]) {
        const lead = await Lead.findById(id).lean<any>();
        expect(lead.status).not.toBe('Not a Lead');
      }

      const again = await moveNoticeCardsToOthers({ apply: true, organizationId: ORG });
      expect(again[0]).toMatchObject({ found: 3, moved: 0 });
    });
  });

  describe('the same request saved twice on one lead', () => {
    it('folds only repeats within 2 hours that add no new words, fixes the inquiry count, and is safe to run twice', async () => {
      const leadId = await seedLead({ inquiryCount: 4 });
      const first = await seedInquiry(leadId, 'created_lead', minutesAgo(300));
      const copy = await seedInquiry(leadId, 'appended', minutesAgo(290), { comments: 'is the truck available', sourceIds: { mailbox: 'sales@dealer-p73.test' } });
      const newWords = await seedInquiry(leadId, 'appended', minutesAgo(280), { comments: 'Is the truck available? I want to trade my Accord.' });
      const later = await seedInquiry(leadId, 'appended', minutesAgo(60));

      const preview = await foldRepeatedInquiries({ apply: false, organizationId: ORG });
      const row = preview.leads.find((lead) => lead.leadId === String(leadId));
      expect(row).toMatchObject({ before: 4, after: 3, copies: 1 });
      expect((await LeadInquiry.findById(copy._id).lean<any>()).association.state).toBe('associated');
      expect((await Lead.findById(leadId).lean<any>()).inquiryCount).toBe(4);

      const applied = await foldRepeatedInquiries({ apply: true, organizationId: ORG });
      expect(applied.folded).toBeGreaterThanOrEqual(1);
      const folded = (await LeadInquiry.findById(copy._id).lean<any>()).association;
      expect(folded).toMatchObject({ state: 'resolved', outcome: 'dismissed', reason: 'duplicate_same_request' });
      expect(String(folded.leadId)).toBe(String(leadId));
      expect(String(folded.duplicateOf)).toBe(String(first._id));
      for (const kept of [first, newWords, later]) {
        expect((await LeadInquiry.findById(kept._id).lean<any>()).association.state).toBe('associated');
      }
      expect((await Lead.findById(leadId).lean<any>()).inquiryCount).toBe(3);

      const again = await foldRepeatedInquiries({ apply: true, organizationId: ORG });
      expect(again.leads.find((lead) => lead.leadId === String(leadId))).toBeUndefined();
      expect((await Lead.findById(leadId).lean<any>()).inquiryCount).toBe(3);
    });

    it('never folds the first inquiry, a chat kept separate, or a different vehicle', async () => {
      const leadId = await seedLead({ inquiryCount: 3 });
      await seedInquiry(leadId, 'created_lead', minutesAgo(50));
      await seedInquiry(leadId, 'appended', minutesAgo(45), { vehicle: sedan });
      await seedInquiry(leadId, 'appended', minutesAgo(40), { intakePolicy: 'isolate' });
      const preview = await foldRepeatedInquiries({ apply: false, organizationId: ORG });
      expect(preview.leads.find((lead) => lead.leadId === String(leadId))).toBeUndefined();
    });
  });

  it('reports open duplicate cards without changing them', async () => {
    const email = nextEmail();
    const one = await seedLead({ email, normalizedEmail: email });
    const two = await seedLead({ email, normalizedEmail: email });
    const result = await previewOpenDuplicateCards(ORG);
    expect(result).toHaveLength(1);
    expect(result[0].organizationId).toBe(ORG);
    expect(result[0].customers).toBeGreaterThanOrEqual(1);
    expect(await Lead.countDocuments({ _id: { $in: [one, two] }, 'combinedInto.leadId': { $exists: false } })).toBe(2);
  });
});
