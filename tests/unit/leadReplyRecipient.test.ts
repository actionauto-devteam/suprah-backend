import { LEAD_SOURCE_EMAILS, resolveLeadReplyRecipient } from '../../src/utils/leadReplyRecipient';

describe('resolveLeadReplyRecipient', () => {
  it('uses the saved customer email for an ADF lead and never the lead-source senderEmail', () => {
    const lead = { email: 'Jane.Doe@Example.com ', senderEmail: 'leads@dealerscloud.com', channel: 'adf', centralIngestion: true };
    expect(resolveLeadReplyRecipient(lead)).toBe('jane.doe@example.com');
  });

  it('returns null for an ADF lead that has no customer email, even though senderEmail is set', () => {
    const lead = { email: '', senderEmail: 'leads@dealerscloud.com', channel: 'adf', centralIngestion: true };
    expect(resolveLeadReplyRecipient(lead)).toBeNull();
  });

  it('returns null for a central-ingestion email lead without a customer email, even when senderEmail looks like a person', () => {
    const lead = { email: '', senderEmail: 'AutoTrader <noreply@autotrader.com>', channel: 'email', centralIngestion: true };
    expect(resolveLeadReplyRecipient(lead)).toBeNull();
  });

  it('never falls back to senderEmail, even for a legacy direct-email lead that is not centrally ingested', () => {
    const lead = { email: '', senderEmail: 'buyer@example.com', channel: 'email', centralIngestion: false };
    expect(resolveLeadReplyRecipient(lead)).toBeNull();
  });

  it('uses the saved customer email on a legacy lead and ignores a different senderEmail', () => {
    const lead = { email: 'buyer@example.com', senderEmail: 'noreply@aggregator.example', channel: 'email', centralIngestion: false };
    expect(resolveLeadReplyRecipient(lead)).toBe('buyer@example.com');
  });

  it('rejects a saved email that is a known lead-source address instead of falling back', () => {
    for (const source of LEAD_SOURCE_EMAILS) {
      expect(resolveLeadReplyRecipient({ email: source.toUpperCase(), senderEmail: 'buyer@example.com', channel: 'email' })).toBeNull();
    }
  });

  it('rejects the dealership inbox and lead-source addresses passed in for the organization', () => {
    const dealership = ['Sales@ActionAuto.com', 'inbound-leads@actionauto.com', null, undefined, ''];
    expect(resolveLeadReplyRecipient({ email: 'sales@actionauto.com' }, dealership)).toBeNull();
    expect(resolveLeadReplyRecipient({ email: '', senderEmail: 'inbound-leads@actionauto.com', channel: 'email' }, dealership)).toBeNull();
    expect(resolveLeadReplyRecipient({ email: 'buyer@example.com' }, dealership)).toBe('buyer@example.com');
  });

  it('returns null for malformed or missing addresses', () => {
    expect(resolveLeadReplyRecipient({ email: 'not-an-email', senderEmail: 'also bad', channel: 'email' })).toBeNull();
    expect(resolveLeadReplyRecipient({})).toBeNull();
    expect(resolveLeadReplyRecipient(null)).toBeNull();
  });
});
