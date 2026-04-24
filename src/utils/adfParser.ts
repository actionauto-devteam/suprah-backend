/**
 * ADF (Auto-lead Data Format) Parser Utility
 * 
 * Parses ADF/XML email content from leads@dealerscloud.com
 * and converts it into clean, structured, UI-readable content.
 * Also detects communication channel (SMS vs Email).
 */

import { parseStringPromise } from 'xml2js';
import logger from './logger';

export interface ParsedADFLead {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  vehicle: {
    year: string;
    make: string;
    model: string;
    vin?: string;
    stock?: string;
    trim?: string;
    condition?: string;
    odometer?: string;
    color?: string;
    interiorColor?: string;
    price?: string;
  };
  comments: string;
  source: string;
  provider: string;
  vendor: string;
  requestDate: string;
  /** Clean, human-readable summary of the lead */
  parsedContent: string;
  /** Communication channel: 'email' | 'sms' | 'adf' | 'phone' | 'web' */
  channel: 'email' | 'sms' | 'adf' | 'phone' | 'web';
  /** Raw fields extracted for metadata */
  rawFields: Record<string, string>;
}

/**
 * Detect the communication channel from email content and metadata
 */
export function detectChannel(
  subject: string = '',
  body: string = '',
  from: string = '',
  source: string = ''
): 'email' | 'sms' | 'adf' | 'phone' | 'web' {
  const lowerSubject = subject.toLowerCase();
  const lowerBody = body.toLowerCase();
  const lowerFrom = from.toLowerCase();
  const lowerSource = source.toLowerCase();

  // SMS indicators
  const smsKeywords = [
    'sms', 'text message', 'text lead', 'txt msg',
    'mobile message', 'text inquiry', 'sms lead',
    'text notification', 'texting', 'mms',
  ];
  if (smsKeywords.some(kw => 
    lowerSubject.includes(kw) || lowerBody.includes(kw) || lowerSource.includes(kw)
  )) {
    return 'sms';
  }

  // Phone/call indicators
  const phoneKeywords = [
    'phone call', 'inbound call', 'missed call', 'voicemail',
    'call lead', 'phone inquiry', 'callback',
  ];
  if (phoneKeywords.some(kw => 
    lowerSubject.includes(kw) || lowerBody.includes(kw) || lowerSource.includes(kw)
  )) {
    return 'phone';
  }

  // Web form indicators
  const webKeywords = [
    'web lead', 'website inquiry', 'online form', 'web form',
    'website lead', 'internet lead', 'online inquiry',
  ];
  if (webKeywords.some(kw => 
    lowerSubject.includes(kw) || lowerBody.includes(kw) || lowerSource.includes(kw)
  )) {
    return 'web';
  }

  // ADF indicators
  if (
    lowerBody.includes('<?adf') || lowerBody.includes('<adf>') ||
    lowerBody.includes('<prospect') || lowerFrom.includes('dealerscloud') ||
    lowerSource.includes('adf')
  ) {
    return 'adf';
  }

  return 'email';
}

/**
 * Safely extract a text value from parsed XML nodes.
 * ADF fields can be strings, objects with `_` text, or arrays.
 */
function extractText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node.trim();
  
  if (Array.isArray(node)) {
    return node.length > 0 ? extractText(node[0]) : '';
  }

  if (typeof node === 'object') {
    // xml2js uses '_' for text nodes with attributes
    if (node._ !== undefined && node._ !== null) return String(node._).trim();
    
    // Some other parsers or configurations might use '#text'
    if (node['#text'] !== undefined) return String(node['#text']).trim();

    // If it's a simple object with one property that is a string, return that
    const keys = Object.keys(node);
    if (keys.length === 1 && typeof node[keys[0]] === 'string') {
      return node[keys[0]].trim();
    }
    
    // If it has a 'number' or 'value' field (common for phone/odometer)
    if (node.number !== undefined) return extractText(node.number);
    if (node.value !== undefined) return extractText(node.value);

    // Fallback: search for any string property if it's a small object
    for (const key of keys) {
      if (typeof node[key] === 'string' && !['type', 'time', 'part', 'status'].includes(key)) {
        return node[key].trim();
      }
    }
  }

  const str = String(node).trim();
  return str === '[object Object]' ? '' : str;
}

/**
 * Check if a string contains ADF/XML content
 */
export function isADFContent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return (
    trimmed.includes('<?adf') ||
    trimmed.includes('<adf>') ||
    trimmed.includes('<adf ') ||
    trimmed.includes('<prospect') ||
    (trimmed.includes('<customer') && trimmed.includes('<vehicle'))
  );
}

/**
 * Extract ADF XML from an email body that may contain
 * mixed content (plain text + embedded XML)
 */
export function extractADFFromBody(body: string): string | null {
  if (!body) return null;

  // Try to find ADF XML block within the body
  const adfPatterns = [
    /(<\?adf[\s\S]*?<\/adf>)/i,
    /(<adf[\s\S]*?<\/adf>)/i,
    /(<prospect[\s\S]*?<\/prospect>)/i,
  ];

  for (const pattern of adfPatterns) {
    const match = body.match(pattern);
    if (match) {
      let xml = match[1];
      // Ensure it has the ADF wrapper
      if (!xml.includes('<adf')) {
        xml = `<?adf version="1.0"?>\n<adf>\n${xml}\n</adf>`;
      }
      return xml;
    }
  }

  // If the entire body looks like XML, return it
  const trimmed = body.trim();
  if (trimmed.startsWith('<?') || trimmed.startsWith('<adf') || trimmed.startsWith('<prospect')) {
    return trimmed;
  }

  return null;
}

/**
 * Parse ADF/XML content and return structured lead data
 */
/**
 * Sanitize XML to handle common real-world ADF issues from dealers:
 * - Unescaped ampersands (&)
 * - Unclosed HTML tags (<br>, <hr>, etc.)
 * - HTML entities not valid in XML (&nbsp;, &ldquo;, etc.)
 * - Stray HTML tags inside XML content
 */
function sanitizeXML(xml: string): string {
  let sanitized = xml;

  // Remove HTML doctype if present
  sanitized = sanitized.replace(/<![dD][oO][cC][tT][yY][pP][eE][^>]*>/g, '');

  // Self-close unclosed HTML void tags that break XML parsing
  sanitized = sanitized.replace(/<(br|hr|img|input|meta|link)(\s[^>]*)?(?<!\/)>/gi, '<$1$2/>');

  // Remove stray HTML tags that aren't valid ADF elements
  sanitized = sanitized.replace(/<\/?(html|head|body|div|span|p|table|tr|td|th|thead|tbody|font|b|i|u|em|strong|a|ul|ol|li|style|script|center|h[1-6])(\s[^>]*)?>/gi, ' ');

  // Replace common HTML entities with XML-safe equivalents
  sanitized = sanitized.replace(/&nbsp;/gi, ' ');
  sanitized = sanitized.replace(/&ldquo;/gi, '"');
  sanitized = sanitized.replace(/&rdquo;/gi, '"');
  sanitized = sanitized.replace(/&lsquo;/gi, "'");
  sanitized = sanitized.replace(/&rsquo;/gi, "'");
  sanitized = sanitized.replace(/&mdash;/gi, '-');
  sanitized = sanitized.replace(/&ndash;/gi, '-');
  sanitized = sanitized.replace(/&bull;/gi, '•');
  sanitized = sanitized.replace(/&copy;/gi, '©');
  sanitized = sanitized.replace(/&reg;/gi, '®');
  sanitized = sanitized.replace(/&trade;/gi, '™');
  sanitized = sanitized.replace(/&hellip;/gi, '...');

  // Fix unescaped ampersands (& not followed by amp;, lt;, gt;, quot;, apos;, or #)
  sanitized = sanitized.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');

  // Clean up excessive whitespace
  sanitized = sanitized.replace(/\r\n/g, '\n');

  return sanitized;
}

export async function parseADF(xmlData: string): Promise<ParsedADFLead | null> {
  try {
    // Sanitize the XML to handle real-world malformed ADF from dealers
    const sanitized = sanitizeXML(xmlData);

    const result = await parseStringPromise(sanitized, {
      explicitArray: false,
      ignoreAttrs: false,
      mergeAttrs: true,
      trim: true,
    });

    const prospect = result?.adf?.prospect || result?.prospect;
    if (!prospect) return null;

    const customer = prospect.customer?.contact || prospect.customer;
    const vehicle = prospect.vehicle;
    const vendor = prospect.vendor;
    const provider = prospect.provider;

    // --- Extract name ---
    let firstName = 'Unknown';
    let lastName = '';
    if (customer?.name) {
      if (Array.isArray(customer.name)) {
        firstName = customer.name.find((n: any) => n.part === 'first')?._ ||
                    customer.name.find((n: any) => n.part === 'first') || firstName;
        lastName = customer.name.find((n: any) => n.part === 'last')?._ ||
                   customer.name.find((n: any) => n.part === 'last') || '';
      } else if (customer.name.part === 'full') {
        const parts = extractText(customer.name).split(' ');
        firstName = parts[0] || firstName;
        lastName = parts.slice(1).join(' ');
      } else if (customer.name.part === 'first') {
        firstName = extractText(customer.name);
      } else {
        const fullName = extractText(customer.name);
        const parts = fullName.split(' ');
        firstName = parts[0] || firstName;
        lastName = parts.slice(1).join(' ');
      }
    }

    // --- Extract contact info ---
    let email = '';
    let phone = '';

    if (customer?.email) {
      email = Array.isArray(customer.email)
        ? extractText(customer.email[0])
        : extractText(customer.email);
    }

    if (customer?.phone) {
      if (Array.isArray(customer.phone)) {
        // Prefer 'phone' type, fall back to first
        const preferredPhone = customer.phone.find((p: any) => p.type === 'phone') || customer.phone[0];
        phone = extractText(preferredPhone);
      } else {
        phone = extractText(customer.phone);
      }
    }

    // --- Extract vehicle info ---
    const vehicleInfo = {
      year: extractText(vehicle?.year),
      make: extractText(vehicle?.make),
      model: extractText(vehicle?.model),
      vin: extractText(vehicle?.vin),
      stock: extractText(vehicle?.stock),
      trim: extractText(vehicle?.trim),
      condition: vehicle?.status || extractText(vehicle?.condition) || '',
      odometer: extractText(vehicle?.odometer?._ || vehicle?.odometer),
      color: extractText(vehicle?.colorcombination?.exteriorcolor) ||
             extractText(vehicle?.color),
      interiorColor: extractText(vehicle?.colorcombination?.interiorcolor),
      price: extractText(vehicle?.price?._ || vehicle?.price),
    };

    // --- Extract comments ---
    let comments = '';
    if (prospect.customer?.comments) {
      comments = extractText(prospect.customer.comments);
    } else if (prospect.comments) {
      comments = extractText(prospect.comments);
    }

    // --- Extract source / provider / vendor ---
    const sourceName = extractText(provider?.name || provider?._ || provider) ||
                       extractText(vendor?.name || vendor?._ || vendor) ||
                       'ADF Lead';
    const providerName = extractText(provider?.name || provider?._ || provider) || '';
    const vendorName = extractText(vendor?.vendorname || vendor?.name || vendor?._ || vendor) || '';
    const requestDate = extractText(prospect.requestdate) || new Date().toISOString();

    // --- Build raw fields for metadata ---
    const rawFields: Record<string, string> = {};
    if (customer?.address) {
      const addr = Array.isArray(customer.address) ? customer.address[0] : customer.address;
      rawFields.street = extractText(addr?.street);
      rawFields.city = extractText(addr?.city);
      rawFields.state = extractText(addr?.regioncode || addr?.state);
      rawFields.zip = extractText(addr?.postalcode || addr?.zip);
    }
    if (vehicleInfo.vin) rawFields.vin = vehicleInfo.vin;
    if (vehicleInfo.stock) rawFields.stockNumber = vehicleInfo.stock;

    // --- Build clean, human-readable content ---
    const parsedContent = buildReadableContent({
      firstName, lastName, email, phone,
      vehicle: vehicleInfo, comments,
      source: sourceName, vendor: vendorName,
      requestDate, rawFields,
    });

    return {
      firstName: cleanString(firstName),
      lastName: cleanString(lastName),
      email: cleanString(email),
      phone: cleanString(phone),
      vehicle: vehicleInfo,
      comments: cleanString(comments),
      source: cleanString(sourceName),
      provider: cleanString(providerName),
      vendor: cleanString(vendorName),
      requestDate,
      parsedContent,
      channel: 'adf',
      rawFields,
    };
  } catch (err) {
    logger.error({ err, xmlData }, '[ADF Parser] Failed to parse ADF XML');
    return null;
  }
}

/**
 * Build a clean, human-readable summary from parsed ADF fields
 */
function buildReadableContent(data: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  vehicle: ParsedADFLead['vehicle'];
  comments: string;
  source: string;
  vendor: string;
  requestDate: string;
  rawFields: Record<string, string>;
}): string {
  const lines: string[] = [];
  const v = data.vehicle;

  // Header
  lines.push(`New Lead from ${data.source || 'ADF'}`);
  lines.push('');

  // Contact
  lines.push('— Contact Information —');
  lines.push(`Name: ${data.firstName} ${data.lastName}`.trim());
  if (data.email) lines.push(`Email: ${data.email}`);
  if (data.phone) lines.push(`Phone: ${data.phone}`);

  // Address
  const addrParts = [
    data.rawFields.street,
    data.rawFields.city,
    data.rawFields.state,
    data.rawFields.zip,
  ].filter(Boolean);
  if (addrParts.length) {
    lines.push(`Address: ${addrParts.join(', ')}`);
  }
  lines.push('');

  // Vehicle
  const vehicleDesc = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
  if (vehicleDesc) {
    lines.push('— Vehicle Interest —');
    lines.push(`Vehicle: ${vehicleDesc}`);
    if (v.condition) lines.push(`Condition: ${v.condition}`);
    if (v.vin) lines.push(`VIN: ${v.vin}`);
    if (v.stock) lines.push(`Stock #: ${v.stock}`);
    if (v.color) lines.push(`Exterior: ${v.color}`);
    if (v.interiorColor) lines.push(`Interior: ${v.interiorColor}`);
    if (v.odometer) lines.push(`Odometer: ${v.odometer}`);
    if (v.price) lines.push(`Price: ${v.price}`);
    lines.push('');
  }

  // Comments
  if (data.comments) {
    lines.push('— Customer Comments —');
    lines.push(data.comments);
    lines.push('');
  }

  // Meta
  if (data.vendor || data.requestDate) {
    lines.push('— Lead Details —');
    if (data.vendor) lines.push(`Dealer/Vendor: ${data.vendor}`);
    if (data.requestDate) {
      try {
        const d = new Date(data.requestDate);
        lines.push(`Request Date: ${d.toLocaleString()}`);
      } catch {
        lines.push(`Request Date: ${data.requestDate}`);
      }
    }
  }

  return lines.join('\n');
}

function cleanString(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Attempt to parse an email body: if it contains ADF, parse it;
 * otherwise return the body as-is with channel detection.
 */
export async function parseEmailBody(
  body: string,
  subject: string = '',
  from: string = ''
): Promise<{
  parsedContent: string;
  channel: 'email' | 'sms' | 'adf' | 'phone' | 'web';
  adfData: ParsedADFLead | null;
}> {
  // Check for ADF content
  const adfXml = extractADFFromBody(body);
  if (adfXml) {
    const adfData = await parseADF(adfXml);
    if (adfData) {
      return {
        parsedContent: adfData.parsedContent,
        channel: 'adf',
        adfData,
      };
    }
  }

  // Not ADF — detect channel and return cleaned body
  const channel = detectChannel(subject, body, from);

  // Clean up the body for display
  const cleanedBody = body
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    parsedContent: cleanedBody,
    channel,
    adfData: null,
  };
}