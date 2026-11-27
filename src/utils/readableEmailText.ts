import { htmlToText } from './gmailMessageParser';
import { extractADFFromBody, isADFContent, parseADF } from './adfParser';

const HTML_TAG = /<\/?(?:br|div|p|b|strong|em|i|u|span|table|tbody|thead|tr|td|th|font|a|html|body|head|style|li|ul|ol|h[1-6]|img|center|hr)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
};

const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g;

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = hex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function looksLikeHtml(text: string): boolean {
  return (text.match(HTML_TAG) || []).length >= 2;
}

function money(value: string | undefined): string {
  const amount = Number(String(value || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(amount) && amount > 0 ? `$${amount.toLocaleString('en-US')}` : '';
}

async function adfSummary(text: string): Promise<string | null> {
  const parsed = await parseADF(extractADFFromBody(text) || text).catch(() => null);
  if (!parsed) return null;
  const firstName = parsed.firstName === 'Unknown' ? '' : parsed.firstName;
  const name = [firstName, parsed.lastName].filter(Boolean).join(' ').trim();
  const vehicle = [parsed.vehicle?.year, parsed.vehicle?.make, parsed.vehicle?.model, parsed.vehicle?.trim].filter(Boolean).join(' ');
  const ids = [parsed.vehicle?.stock ? `Stock ${parsed.vehicle.stock}` : '', parsed.vehicle?.vin ? `VIN ${parsed.vehicle.vin}` : ''].filter(Boolean).join(', ');
  const price = money(parsed.vehicle?.price);
  const lines = [
    name ? `Name: ${name}` : '',
    parsed.phone ? `Phone: ${parsed.phone}` : '',
    parsed.email ? `Email: ${parsed.email}` : '',
    vehicle ? `Vehicle: ${vehicle}${ids ? ` (${ids})` : ''}` : '',
    price ? `Price: ${price}` : '',
    parsed.comments ? `Comments: ${parsed.comments.trim()}` : '',
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

export async function readableEmailText(text: string): Promise<string> {
  const value = String(text || '');
  if (!value.trim()) return value;
  if (isADFContent(value)) {
    const summary = await adfSummary(value);
    if (summary) return decodeEntities(summary);
  }
  return decodeEntities(looksLikeHtml(value) ? htmlToText(value) : value);
}
