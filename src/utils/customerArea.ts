import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { contactIdentity } from './contactIdentity';

export const CUSTOMER_AREA_CODES = ['utah', 'utah_435', 'southern_utah', 'out_of_state', 'canada', 'outside_us'] as const;
export type CustomerAreaCode = (typeof CUSTOMER_AREA_CODES)[number];
export type CustomerAreaBasis = 'zip' | 'state' | 'phone';

export interface CustomerArea {
  code: CustomerAreaCode;
  basis: CustomerAreaBasis;
  detail: string;
}

interface Region {
  code: string;
  canada: boolean;
}

const US_STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
  'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI', 'american samoa': 'AS',
  'northern mariana islands': 'MP',
};

const CANADA_PROVINCE_NAMES: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', newfoundland: 'NL', 'nova scotia': 'NS', 'northwest territories': 'NT',
  nunavut: 'NU', ontario: 'ON', 'prince edward island': 'PE', quebec: 'QC', saskatchewan: 'SK', yukon: 'YT',
};

const US_STATE_CODES = new Set(Object.values(US_STATE_NAMES));
const CANADA_PROVINCE_CODES = new Set(Object.values(CANADA_PROVINCE_NAMES));
const REGION_NAMES = [
  ...Object.entries(US_STATE_NAMES).map(([name, code]) => ({ name, code, canada: false })),
  ...Object.entries(CANADA_PROVINCE_NAMES).map(([name, code]) => ({ name, code, canada: true })),
].sort((a, b) => b.name.length - a.name.length);

const MAX_ADDRESS_LENGTH = 300;
const US_COUNTRY_SUFFIX = /[,\s]+(?:u\.?\s?s\.?(?:\s?a\.?)?|united states(?: of america)?)\.?$/i;
const CANADA_COUNTRY_SUFFIX = /(?:^|[,\s]+)canada\.?$/i;
const CANADA_AFTER_COMMA = /,\s*canada\.?$/i;
const CANADA_POSTAL_SUFFIX = /(?:^|[\s,])([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])[ -]?(\d[ABCEGHJ-NPRSTV-Z]\d)$/i;
const US_ZIP_SUFFIX = /(^|[\s,])(\d{5})(?:[-\s]?\d{4})?$/;
const COMMA_SUFFIX = /,\s*$/;
const UNIT_WORD_SUFFIX = /(?:#|\b(?:p\.?\s?o\.?\s?box|box|apt|apartment|unit|suite|ste|lot|bldg|building|space|spc|trlr|trailer|room|rm|hwy|highway|route|rte|rt|no|number)\.?)\s*$/i;
const CITY_WORD_SUFFIX = /(?:^|[\s,])[A-Za-z]{3,}\.?$/;
const STREET_WORD_SUFFIX = /\b(?:north|south|east|west|street|st|road|rd|avenue|ave|drive|dr|lane|ln|way|boulevard|blvd|court|ct|circle|cir|place|pl|parkway|pkwy|trail|trl|terrace|ter|floor|fl|pmb|mile|exit)\.?\s*$/i;
const PLACEHOLDER_ZIP = /^(?:(\d)\1{4}|12345|000\d\d)$/;
const JUNK_SEGMENT = /^(?:[^A-Za-z]*|n\/?a|none|unknown)$/i;
const NOT_A_US_REGION = /(?:^|\s)(?:baja california|british virgin islands)$/;
const WORD_LIKE_CODES = new Set(['OK', 'IN', 'OR', 'ME', 'HI', 'OH', 'ID', 'AS', 'PA', 'LA', 'DE', 'CO', 'AL', 'MA', 'ON']);
const STREET_LIKE_CODES = new Set([...WORD_LIKE_CODES, 'NE', 'CT', 'WY', 'MT', 'WV']);
const CITY_LIKE_REGION_NAMES = new Set(['washington']);
const US_TERRITORY_COUNTRIES = new Set(['PR', 'VI', 'GU', 'AS', 'MP']);
const NON_GEOGRAPHIC_PHONE_TYPES = new Set(['TOLL_FREE', 'PREMIUM_RATE', 'SHARED_COST', 'PERSONAL_NUMBER', 'UAN', 'PAGER', 'VOICEMAIL']);
const WASATCH_FRONT_AREA_CODES = new Set(['801', '385']);

const trimTail = (value: string) => value.replace(/[\s,.;]+$/, '');

function regionForCode(token: string): Region | null {
  const code = token.toUpperCase();
  if (US_STATE_CODES.has(code)) return { code, canada: false };
  if (CANADA_PROVINCE_CODES.has(code)) return { code, canada: true };
  return null;
}

function readRegion(text: string, zipFollows = false): Region | null {
  const segments = text.split(',').map((part) => trimTail(part.trim())).filter(Boolean);
  if (segments.length > 1 && JUNK_SEGMENT.test(segments[segments.length - 1])) segments.pop();
  const segment = segments.pop() || '';
  if (!segment) return null;
  const previous = segments.length ? segments[segments.length - 1] : '';
  const afterCity = Boolean(previous) && !/\d/.test(previous);
  const hasDigit = /\d/.test(segment);

  if (/^[A-Za-z]{2}$/.test(segment)) {
    const region = regionForCode(segment);
    if (!region) return null;
    if (region.code === 'UT' || afterCity || zipFollows) return region;
    const unclearCodes = previous ? STREET_LIKE_CODES : WORD_LIKE_CODES;
    return segment === region.code && !unclearCodes.has(region.code) ? region : null;
  }

  const lower = segment.toLowerCase();
  if (NOT_A_US_REGION.test(lower)) return null;
  for (const region of REGION_NAMES) {
    const exact = lower === region.name;
    if (!exact && !lower.endsWith(` ${region.name}`)) continue;
    if (region.code === 'UT') return { code: 'UT', canada: false };
    if (exact && !afterCity) return null;
    if (!zipFollows && (hasDigit || CITY_LIKE_REGION_NAMES.has(region.name))) return null;
    return { code: region.code, canada: region.canada };
  }

  const token = /\s([A-Za-z]{2})$/.exec(segment)?.[1];
  const region = token ? regionForCode(token) : null;
  if (!token || !region) return null;
  if (region.code === 'UT' || zipFollows) return region;
  return token === region.code && !hasDigit && !STREET_LIKE_CODES.has(region.code) ? region : null;
}

function usableZip(zip: string, before: string, afterComma: boolean, hasRegion: boolean): boolean {
  if (hasRegion) return true;
  if (PLACEHOLDER_ZIP.test(zip)) return false;
  if (!before || afterComma) return true;
  if (UNIT_WORD_SUFFIX.test(before)) return false;
  if (zip.startsWith('84')) return true;
  return CITY_WORD_SUFFIX.test(before) && !/\d/.test(before) && !STREET_WORD_SUFFIX.test(before);
}

export function postalAddressLine(parts: { street?: unknown; city?: unknown; state?: unknown; zip?: unknown } | null | undefined): string {
  if (!parts) return '';
  return [parts.street, parts.city, parts.state, parts.zip]
    .map((part) => String(part ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ')
    .slice(0, MAX_ADDRESS_LENGTH);
}

export function customerAreaFromAddress(address: unknown): CustomerArea | null {
  const cleaned = String(address ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  let text = trimTail(cleaned.slice(-MAX_ADDRESS_LENGTH));
  if (!text) return null;

  let inCanada = false;
  const canada = CANADA_COUNTRY_SUFFIX.exec(text);
  if (canada) {
    const rest = trimTail(text.slice(0, canada.index));
    if (!rest || CANADA_AFTER_COMMA.test(text) || readRegion(rest)?.canada) {
      inCanada = true;
      text = rest;
    }
  } else if (US_COUNTRY_SUFFIX.test(text)) {
    text = trimTail(text.replace(US_COUNTRY_SUFFIX, ''));
  }

  const postal = CANADA_POSTAL_SUFFIX.exec(text);
  if (postal) return { code: 'canada', basis: 'zip', detail: `${postal[1]} ${postal[2]}`.toUpperCase() };

  const zipMatch = US_ZIP_SUFFIX.exec(text);
  const rawBeforeZip = zipMatch ? text.slice(0, zipMatch.index) + zipMatch[1] : text;
  const beforeZip = trimTail(rawBeforeZip);
  const region = readRegion(beforeZip, Boolean(zipMatch) && !PLACEHOLDER_ZIP.test(zipMatch?.[2] || ''));
  const zip = zipMatch && usableZip(zipMatch[2], beforeZip, COMMA_SUFFIX.test(rawBeforeZip), Boolean(region)) ? zipMatch[2] : '';

  if (region?.canada && zip) return null;
  if (zip.startsWith('847')) return { code: 'southern_utah', basis: 'zip', detail: zip };
  if (zip.startsWith('84')) return { code: 'utah', basis: 'zip', detail: zip };
  if (region?.canada || (inCanada && !region)) return { code: 'canada', basis: 'state', detail: region?.code || 'Canada' };
  if (region?.code === 'UT') return { code: 'utah', basis: 'state', detail: 'UT' };
  if (region) return { code: 'out_of_state', basis: 'state', detail: region.code };
  if (zip) return { code: 'out_of_state', basis: 'zip', detail: zip };
  return null;
}

export function customerAreaFromPhone(phone: unknown): CustomerArea | null {
  const normalized = contactIdentity({ phone }).normalizedPhone;
  if (!normalized) return null;
  let parsed: ReturnType<typeof parsePhoneNumberFromString>;
  try {
    parsed = parsePhoneNumberFromString(normalized.split(';')[0]);
  } catch {
    return null;
  }
  if (!parsed || !parsed.isValid() || !parsed.country) return null;
  if (NON_GEOGRAPHIC_PHONE_TYPES.has(String(parsed.getType()))) return null;

  const area = String(parsed.nationalNumber).slice(0, 3);
  if (parsed.country === 'CA') return { code: 'canada', basis: 'phone', detail: area };
  if (parsed.country !== 'US' && !US_TERRITORY_COUNTRIES.has(parsed.country)) {
    return { code: 'outside_us', basis: 'phone', detail: parsed.country };
  }
  if (WASATCH_FRONT_AREA_CODES.has(area)) return { code: 'utah', basis: 'phone', detail: area };
  if (area === '435') return { code: 'utah_435', basis: 'phone', detail: area };
  return { code: 'out_of_state', basis: 'phone', detail: area };
}

export function classifyCustomerArea(input: { address?: unknown; phone?: unknown }): CustomerArea | null {
  return customerAreaFromAddress(input.address) || customerAreaFromPhone(input.phone);
}

export function leadCustomerArea(lead: { address?: unknown; phone?: unknown } | null | undefined): CustomerArea | null {
  if (!lead) return null;
  return classifyCustomerArea({ address: lead.address, phone: lead.phone });
}

export function sameCustomerArea(a: Partial<CustomerArea> | null | undefined, b: Partial<CustomerArea> | null | undefined): boolean {
  if (!a?.code || !b?.code) return !a?.code && !b?.code;
  return a.code === b.code && a.basis === b.basis && String(a.detail || '') === String(b.detail || '');
}

export const CUSTOMER_AREA_FILTER_VALUES = ['utah', 'utah_435', 'southern_utah', 'out_of_state', 'outside', 'none'] as const;
export type CustomerAreaFilter = (typeof CUSTOMER_AREA_FILTER_VALUES)[number];

export function customerAreaFilterCondition(value: unknown): Record<string, unknown> | null {
  const filter = String(value ?? '').trim().toLowerCase();
  if (filter === 'outside') return { 'customerArea.code': { $in: ['canada', 'outside_us'] } };
  if (filter === 'none') return { 'customerArea.code': null };
  if (filter === 'utah' || filter === 'utah_435' || filter === 'southern_utah' || filter === 'out_of_state') {
    return { 'customerArea.code': filter };
  }
  return null;
}
