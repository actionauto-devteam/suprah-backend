import { parse } from 'csv-parse/sync';
import { createHash } from 'crypto';
import MarketingContact, { MarketingContactConsentStatus } from '../models/MarketingContact.model';
import EmailOptOut from '../models/EmailOptOut.model';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';

export const MAX_IMPORT_ROWS = 30000;
const INSERT_BATCH_SIZE = 1000;
const SAMPLE_LIMIT = 10;

export const SEND_ELIGIBLE_CONSENT_STATUSES: MarketingContactConsentStatus[] = ['documented'];

export function isConsentEligibleForSend(consentStatus: MarketingContactConsentStatus): boolean {
  return SEND_ELIGIBLE_CONSENT_STATUSES.includes(consentStatus);
}

export type ImportRowCategory =
  | 'valid_new'
  | 'duplicate_in_file'
  | 'duplicate_existing'
  | 'suppressed'
  | 'invalid_format';

export interface ImportSettings {
  importLabel: string;
  source: string;
  consentStatus: MarketingContactConsentStatus;
  consentNote?: string;
}

interface CategorizedRow {
  rowIndex: number;
  rawEmail: string;
  email: string | null;
  firstName?: string;
  lastName?: string;
  phone?: string;
  category: ImportRowCategory;
}

export interface ImportCounts {
  totalRows: number;
  validNew: number;
  duplicateInFile: number;
  duplicateExisting: number;
  suppressed: number;
  invalidFormat: number;
}

export interface ImportSample {
  rowIndex: number;
  rawEmail: string;
  firstName?: string;
  lastName?: string;
}

export interface ImportSamples {
  validNew: ImportSample[];
  duplicateInFile: ImportSample[];
  duplicateExisting: ImportSample[];
  suppressed: ImportSample[];
  invalidFormat: ImportSample[];
}

export class MarketingContactImportError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function findHeaderKey(row: Record<string, any>, candidates: string[]): string | null {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const match = keys.find((k) => k.trim().toLowerCase() === candidate);
    if (match) return match;
  }
  return null;
}

export function parseMarketingContactCsv(buffer: Buffer): Record<string, any>[] {
  let rows: Record<string, any>[];
  try {
    rows = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err: any) {
    throw new MarketingContactImportError(`Could not parse CSV file: ${err?.message || 'invalid format'}`);
  }

  if (rows.length === 0) {
    throw new MarketingContactImportError('CSV file has no data rows');
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new MarketingContactImportError(
      `CSV has ${rows.length} rows, which exceeds the ${MAX_IMPORT_ROWS}-row import limit`,
    );
  }

  const emailKey = findHeaderKey(rows[0], ['email', 'email address', 'emailaddress']);
  if (!emailKey) {
    throw new MarketingContactImportError('CSV must include an "email" column');
  }

  return rows;
}

export function computeImportFingerprint(buffer: Buffer, settings: ImportSettings): string {
  const hash = createHash('sha256');
  hash.update(buffer);
  hash.update(
    JSON.stringify({
      importLabel: settings.importLabel,
      source: settings.source,
      consentStatus: settings.consentStatus,
      consentNote: settings.consentNote || '',
    }),
  );
  return hash.digest('hex');
}

async function categorizeRows(orgId: string, rawRows: Record<string, any>[]): Promise<CategorizedRow[]> {
  const emailKey = findHeaderKey(rawRows[0], ['email', 'email address', 'emailaddress']);
  const firstNameKey = findHeaderKey(rawRows[0], ['firstname', 'first name', 'first']);
  const lastNameKey = findHeaderKey(rawRows[0], ['lastname', 'last name', 'last']);
  const phoneKey = findHeaderKey(rawRows[0], ['phone', 'phone number', 'phonenumber']);

  const seenInFile = new Set<string>();
  const normalizedCandidates: CategorizedRow[] = rawRows.map((row, index) => {
    const rawEmail = String(row[emailKey!] ?? '').trim();
    const normalized = normalizeIdentityEmail(rawEmail);
    const firstName = firstNameKey ? String(row[firstNameKey] ?? '').trim() || undefined : undefined;
    const lastName = lastNameKey ? String(row[lastNameKey] ?? '').trim() || undefined : undefined;
    const phone = phoneKey ? normalizeIdentityPhone(row[phoneKey]) || undefined : undefined;

    if (!normalized) {
      return { rowIndex: index, rawEmail, email: null, firstName, lastName, phone, category: 'invalid_format' };
    }
    if (seenInFile.has(normalized)) {
      return { rowIndex: index, rawEmail, email: normalized, firstName, lastName, phone, category: 'duplicate_in_file' };
    }
    seenInFile.add(normalized);
    return { rowIndex: index, rawEmail, email: normalized, firstName, lastName, phone, category: 'valid_new' };
  });

  const candidateEmails = Array.from(seenInFile);
  if (candidateEmails.length === 0) {
    return normalizedCandidates;
  }

  const [existingContacts, suppressedContacts] = await Promise.all([
    MarketingContact.find({ organizationId: orgId, email: { $in: candidateEmails } })
      .select('email')
      .lean(),
    EmailOptOut.find({ organizationId: orgId, email: { $in: candidateEmails }, optedOut: true })
      .select('email')
      .lean(),
  ]);

  const existingSet = new Set(existingContacts.map((c: any) => c.email));
  const suppressedSet = new Set(suppressedContacts.map((c: any) => c.email));

  return normalizedCandidates.map((row) => {
    if (row.category !== 'valid_new' || !row.email) return row;
    if (suppressedSet.has(row.email)) return { ...row, category: 'suppressed' };
    if (existingSet.has(row.email)) return { ...row, category: 'duplicate_existing' };
    return row;
  });
}

function summarize(rows: CategorizedRow[]): { counts: ImportCounts; samples: ImportSamples } {
  const counts: ImportCounts = {
    totalRows: rows.length,
    validNew: 0,
    duplicateInFile: 0,
    duplicateExisting: 0,
    suppressed: 0,
    invalidFormat: 0,
  };
  const samples: ImportSamples = {
    validNew: [],
    duplicateInFile: [],
    duplicateExisting: [],
    suppressed: [],
    invalidFormat: [],
  };

  const countKeyFor: Record<ImportRowCategory, keyof ImportCounts> = {
    valid_new: 'validNew',
    duplicate_in_file: 'duplicateInFile',
    duplicate_existing: 'duplicateExisting',
    suppressed: 'suppressed',
    invalid_format: 'invalidFormat',
  };
  const sampleKeyFor: Record<ImportRowCategory, keyof ImportSamples> = {
    valid_new: 'validNew',
    duplicate_in_file: 'duplicateInFile',
    duplicate_existing: 'duplicateExisting',
    suppressed: 'suppressed',
    invalid_format: 'invalidFormat',
  };

  for (const row of rows) {
    const countKey = countKeyFor[row.category];
    counts[countKey] = (counts[countKey] as number) + 1;

    const sampleKey = sampleKeyFor[row.category];
    if (samples[sampleKey].length < SAMPLE_LIMIT) {
      samples[sampleKey].push({
        rowIndex: row.rowIndex,
        rawEmail: row.rawEmail,
        firstName: row.firstName,
        lastName: row.lastName,
      });
    }
  }

  return { counts, samples };
}

export async function previewMarketingContactImport(
  orgId: string,
  buffer: Buffer,
): Promise<{ counts: ImportCounts; samples: ImportSamples }> {
  const rawRows = parseMarketingContactCsv(buffer);
  const categorized = await categorizeRows(orgId, rawRows);
  return summarize(categorized);
}

export interface CommitImportResult {
  counts: ImportCounts;
  imported: number;
  insertFailed: number;
}

export async function commitMarketingContactImport(
  orgId: string,
  importedBy: string,
  buffer: Buffer,
  settings: ImportSettings,
): Promise<CommitImportResult> {
  const rawRows = parseMarketingContactCsv(buffer);
  const categorized = await categorizeRows(orgId, rawRows);
  const { counts } = summarize(categorized);

  const toInsert = categorized.filter((row) => row.category === 'valid_new' && row.email);

  let imported = 0;
  let insertFailed = 0;

  for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
    const batch = toInsert.slice(i, i + INSERT_BATCH_SIZE).map((row) => ({
      organizationId: orgId,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      source: settings.source,
      consentStatus: settings.consentStatus,
      consentNote: settings.consentNote,
      importLabel: settings.importLabel,
      importedBy,
    }));

    try {
      const result = await MarketingContact.insertMany(batch, { ordered: false });
      imported += result.length;
    } catch (err: any) {
      const insertedCount = Array.isArray(err?.insertedDocs) ? err.insertedDocs.length : 0;
      imported += insertedCount;
      insertFailed += batch.length - insertedCount;
    }
  }

  return { counts, imported, insertFailed };
}
