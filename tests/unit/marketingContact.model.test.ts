import mongoose from 'mongoose';
import MarketingContact from '../../src/models/MarketingContact.model';
import EmailCampaignRecipient from '../../src/models/EmailCampaignRecipient.model';

describe('MarketingContact schema', () => {
  const baseDoc = {
    organizationId: 'org-1',
    email: 'Jordan@Example.com',
    source: 'Raffle 2026',
    importLabel: 'Raffle Batch 1',
    importedBy: new mongoose.Types.ObjectId(),
  };

  it('accepts a minimal valid document and defaults consentStatus to unknown', () => {
    const doc = new MarketingContact(baseDoc);
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.consentStatus).toBe('unknown');
  });

  it('normalizes email to lowercase and trims it', () => {
    const doc = new MarketingContact({ ...baseDoc, email: '  Jordan@Example.com  ' });
    doc.validateSync();
    expect(doc.email).toBe('jordan@example.com');
  });

  it.each(['organizationId', 'email', 'source', 'importLabel', 'importedBy'])(
    'requires %s',
    (field) => {
      const doc = new MarketingContact({ ...baseDoc, [field]: undefined });
      const err = doc.validateSync();
      expect(err?.errors?.[field]).toBeDefined();
    },
  );

  it.each(['unknown', 'claimed_verbal', 'documented'])('accepts consentStatus=%s', (consentStatus) => {
    const doc = new MarketingContact({ ...baseDoc, consentStatus });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('rejects an invalid consentStatus value', () => {
    const doc = new MarketingContact({ ...baseDoc, consentStatus: 'verified_opt_in' });
    const err = doc.validateSync();
    expect(err?.errors?.consentStatus).toBeDefined();
  });

  it('never defaults consentStatus to documented or claimed_verbal', () => {
    const doc = new MarketingContact(baseDoc);
    expect(doc.consentStatus).not.toBe('documented');
    expect(doc.consentStatus).not.toBe('claimed_verbal');
  });
});

describe('EmailCampaignRecipient schema — leadId/marketingContactId exclusivity', () => {
  const base = {
    campaignId: new mongoose.Types.ObjectId(),
    organizationId: 'org-1',
    email: 'jordan@example.com',
    customerName: 'Jordan',
  };

  it('is valid with only leadId set (existing Lead-based campaigns, unchanged)', async () => {
    const doc = new EmailCampaignRecipient({ ...base, leadId: new mongoose.Types.ObjectId() });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('is valid with only marketingContactId set (new Marketing Contacts path)', async () => {
    const doc = new EmailCampaignRecipient({ ...base, marketingContactId: new mongoose.Types.ObjectId() });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('is invalid with neither leadId nor marketingContactId set', async () => {
    const doc = new EmailCampaignRecipient({ ...base });
    await expect(doc.validate()).rejects.toThrow(/Exactly one of leadId or marketingContactId/);
  });

  it('is invalid with both leadId and marketingContactId set', async () => {
    const doc = new EmailCampaignRecipient({
      ...base,
      leadId: new mongoose.Types.ObjectId(),
      marketingContactId: new mongoose.Types.ObjectId(),
    });
    await expect(doc.validate()).rejects.toThrow(/Exactly one of leadId or marketingContactId/);
  });
});
