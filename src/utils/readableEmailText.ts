import { htmlToText } from './gmailMessageParser';
import { extractADFFromBody, isADFContent, parseADF } from './adfParser';

const HTML_TAG = /<\/?(?:br|div|p|b|strong|em|i|u|span|table|tbody|thead|tr|td|th|font|a|html|body|head|style|li|ul|ol|h[1-6]|img|center|hr)\b[^>]*>/gi;

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
    if (summary) return summary;
  }
  return looksLikeHtml(value) ? htmlToText(value) : value;
}
