import {
  parseMarketingContactCsv,
  computeImportFingerprint,
  MarketingContactImportError,
  MAX_IMPORT_ROWS,
} from '../../src/services/marketingContact.service';

function csv(rows: string[][], headers = ['email', 'firstName', 'lastName']): Buffer {
  return Buffer.from([headers.join(','), ...rows.map((r) => r.join(','))].join('\n'), 'utf8');
}

describe('parseMarketingContactCsv', () => {
  it('parses a well-formed CSV with email/name headers', () => {
    const rows = parseMarketingContactCsv(csv([['jordan@example.com', 'Jordan', 'Lee']]));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('jordan@example.com');
  });

  it('accepts case-insensitive and spaced email header variants', () => {
    const rows = parseMarketingContactCsv(csv([['jordan@example.com']], ['Email Address']));
    expect(rows).toHaveLength(1);
  });

  it('rejects a CSV with no email column', () => {
    expect(() => parseMarketingContactCsv(csv([['Jordan', 'Lee']], ['firstName', 'lastName']))).toThrow(
      MarketingContactImportError,
    );
  });

  it('rejects an empty CSV (no data rows)', () => {
    expect(() => parseMarketingContactCsv(Buffer.from('email,firstName\n', 'utf8'))).toThrow(
      MarketingContactImportError,
    );
  });

  it('rejects a CSV exceeding the row-count limit (synthetic data only)', () => {
    const rows: string[][] = [];
    for (let i = 0; i < MAX_IMPORT_ROWS + 1; i += 1) {
      rows.push([`synthetic-${i}@example.com`, 'Synthetic', String(i)]);
    }
    expect(() => parseMarketingContactCsv(csv(rows))).toThrow(MarketingContactImportError);
  });

  it('accepts a CSV right at the row-count limit', () => {
    const rows: string[][] = [];
    for (let i = 0; i < MAX_IMPORT_ROWS; i += 1) {
      rows.push([`synthetic-${i}@example.com`, 'Synthetic', String(i)]);
    }
    const parsed = parseMarketingContactCsv(csv(rows));
    expect(parsed).toHaveLength(MAX_IMPORT_ROWS);
  });
});

describe('computeImportFingerprint', () => {
  const settings = { importLabel: 'Batch 1', source: 'Synthetic', consentStatus: 'unknown' as const };

  it('is deterministic for the same file and settings', () => {
    const buf = csv([['jordan@example.com', 'Jordan', 'Lee']]);
    expect(computeImportFingerprint(buf, settings)).toBe(computeImportFingerprint(buf, settings));
  });

  it('changes when the file content changes', () => {
    const bufA = csv([['jordan@example.com', 'Jordan', 'Lee']]);
    const bufB = csv([['someone-else@example.com', 'Someone', 'Else']]);
    expect(computeImportFingerprint(bufA, settings)).not.toBe(computeImportFingerprint(bufB, settings));
  });

  it('changes when the import settings change', () => {
    const buf = csv([['jordan@example.com', 'Jordan', 'Lee']]);
    const otherSettings = { ...settings, importLabel: 'Batch 2' };
    expect(computeImportFingerprint(buf, settings)).not.toBe(computeImportFingerprint(buf, otherSettings));
  });

  it('changes when consentStatus changes, even with the same file and label', () => {
    const buf = csv([['jordan@example.com', 'Jordan', 'Lee']]);
    const otherSettings = { ...settings, consentStatus: 'documented' as const };
    expect(computeImportFingerprint(buf, settings)).not.toBe(computeImportFingerprint(buf, otherSettings));
  });
});
