import {
  LEAD_SOURCE,
  LEAD_SOURCE_VALUES,
  REPORTABLE_LEAD_SOURCE_VALUES,
  UNMAPPED_LEAD_SOURCE_LABEL,
  normalizeLeadSourceForDisplay,
  isGenuineDemoLead,
} from '../../src/constants/leadSource';

describe('leadSource constants', () => {
  it('LEAD_SOURCE_VALUES has no duplicates and matches the LEAD_SOURCE object exactly', () => {
    const seen = new Set<string>();
    for (const value of LEAD_SOURCE_VALUES) {
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
    expect(LEAD_SOURCE_VALUES.sort()).toEqual(Object.values(LEAD_SOURCE).sort());
  });

  it('REPORTABLE_LEAD_SOURCE_VALUES excludes only Demo', () => {
    expect(REPORTABLE_LEAD_SOURCE_VALUES).not.toContain(LEAD_SOURCE.DEMO);
    expect(REPORTABLE_LEAD_SOURCE_VALUES.length).toBe(LEAD_SOURCE_VALUES.length - 1);
  });
});

describe('normalizeLeadSourceForDisplay', () => {
  it('every canonical value round-trips unchanged', () => {
    for (const value of LEAD_SOURCE_VALUES) {
      const result = normalizeLeadSourceForDisplay({ source: value, channel: 'web' });
      expect(result.source).toBe(value);
    }
  });

  it('maps legacy "Gmail Sync" to Email Inquiry', () => {
    const result = normalizeLeadSourceForDisplay({ source: 'Gmail Sync', channel: 'email' });
    expect(result.source).toBe(LEAD_SOURCE.EMAIL_INQUIRY);
    expect(result.sourceProvider).toBeUndefined();
  });

  it('maps the dead schema default "Email" to Email Inquiry', () => {
    const result = normalizeLeadSourceForDisplay({ source: 'Email', channel: 'email' });
    expect(result.source).toBe(LEAD_SOURCE.EMAIL_INQUIRY);
  });

  it('maps legacy "DealersCloud Lead" to Third-Party Lead with DealersCloud as the provider', () => {
    const result = normalizeLeadSourceForDisplay({ source: 'DealersCloud Lead', channel: 'email' });
    expect(result.source).toBe(LEAD_SOURCE.THIRD_PARTY_LEAD);
    expect(result.sourceProvider).toBe('DealersCloud');
  });

  it('maps legacy "ADF Lead (DealersCloud)" and "ADF Email" to Third-Party Lead', () => {
    expect(normalizeLeadSourceForDisplay({ source: 'ADF Lead (DealersCloud)' }).source).toBe(
      LEAD_SOURCE.THIRD_PARTY_LEAD,
    );
    expect(normalizeLeadSourceForDisplay({ source: 'ADF Email' }).source).toBe(LEAD_SOURCE.THIRD_PARTY_LEAD);
  });

  it('recovers an arbitrary legacy vendor name written straight into source (channel adf) as Third-Party Lead + sourceProvider', () => {
    const result = normalizeLeadSourceForDisplay({ source: 'AutoTrader', channel: 'adf' });
    expect(result.source).toBe(LEAD_SOURCE.THIRD_PARTY_LEAD);
    expect(result.sourceProvider).toBe('AutoTrader');
  });

  it('prefers an already-populated sourceProvider over a recovered one', () => {
    const result = normalizeLeadSourceForDisplay({
      source: 'AutoTrader',
      channel: 'adf',
      sourceProvider: 'Cars.com',
    });
    expect(result.sourceProvider).toBe('Cars.com');
  });

  it('falls back to Email Inquiry for an empty/missing source', () => {
    expect(normalizeLeadSourceForDisplay({ source: '' }).source).toBe(LEAD_SOURCE.EMAIL_INQUIRY);
    expect(normalizeLeadSourceForDisplay({ source: null }).source).toBe(LEAD_SOURCE.EMAIL_INQUIRY);
    expect(normalizeLeadSourceForDisplay({}).source).toBe(LEAD_SOURCE.EMAIL_INQUIRY);
  });

  it('falls back to Other for a genuinely unrecognized non-adf source, preserving the original text', () => {
    const result = normalizeLeadSourceForDisplay({ source: 'Some Weird Legacy Value', channel: 'web' });
    expect(result.source).toBe(UNMAPPED_LEAD_SOURCE_LABEL);
    expect(result.sourceProvider).toBe('Some Weird Legacy Value');
  });

  it('matches legacy literals case-insensitively and trims whitespace', () => {
    const result = normalizeLeadSourceForDisplay({ source: '  gmail sync  ' });
    expect(result.source).toBe(LEAD_SOURCE.EMAIL_INQUIRY);
  });
});

describe('isGenuineDemoLead', () => {
  it('is true only for a Demo source paired with a real demo-pattern phone number', () => {
    expect(isGenuineDemoLead(LEAD_SOURCE.DEMO, '+18015550142')).toBe(true);
  });

  it('is false when the source is Demo but the phone is not a demo-pattern number', () => {
    expect(isGenuineDemoLead(LEAD_SOURCE.DEMO, '+18015551234')).toBe(false);
  });

  it('is false when the phone matches the demo pattern but the source is not Demo', () => {
    expect(isGenuineDemoLead(LEAD_SOURCE.WEBSITE_CHAT, '+18015550142')).toBe(false);
  });

  it('is false for a source that merely says the word "Demo" typed into a real lead with a real phone number', () => {
    expect(isGenuineDemoLead('Demo', '+18015559012')).toBe(false);
  });
});
