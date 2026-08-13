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
  parsedContent: string;
  channel: 'email' | 'sms' | 'adf' | 'phone' | 'web';
  rawFields: Record<string, string>;
}

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

  const phoneKeywords = [
    'phone call', 'inbound call', 'missed call', 'voicemail',
    'call lead', 'phone inquiry', 'callback',
  ];
  if (phoneKeywords.some(kw => 
    lowerSubject.includes(kw) || lowerBody.includes(kw) || lowerSource.includes(kw)
  )) {
    return 'phone';
  }

  const webKeywords = [
    'web lead', 'website inquiry', 'online form', 'web form',
    'website lead', 'internet lead', 'online inquiry',
  ];
  if (webKeywords.some(kw => 
    lowerSubject.includes(kw) || lowerBody.includes(kw) || lowerSource.includes(kw)
  )) {
    return 'web';
  }

  if (
    lowerBody.includes('<?adf') || lowerBody.includes('<adf>') ||
    lowerBody.includes('<prospect') || lowerFrom.includes('dealerscloud') ||
    lowerSource.includes('adf')
  ) {
    return 'adf';
  }

  return 'email';
}

function extractText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node.trim();
  
  if (Array.isArray(node)) {
    return node.length > 0 ? extractText(node[0]) : '';
  }

  if (typeof node === 'object') {
    if (node._ !== undefined && node._ !== null) return String(node._).trim();
    
    if (node['#text'] !== undefined) return String(node['#text']).trim();

    const keys = Object.keys(node);
    if (keys.length === 1 && typeof node[keys[0]] === 'string') {
      return node[keys[0]].trim();
    }
    
    if (node.number !== undefined) return extractText(node.number);
    if (node.value !== undefined) return extractText(node.value);

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
 * Last-resort deep scan: walk the parsed ADF object looking for any
 * comments/notes/message/remarks node with real text, so a customer's
 * message is never silently dropped just because a provider put it in a
 * non-standard spot. Skips vendor/provider subtrees (their notes are not
 * customer messages).
 */
function deepFindComments(node: any, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 6) return '';
  const COMMENT_KEYS = ['comments', 'comment', 'notes', 'message', 'remarks'];
  const SKIP_KEYS = ['vendor', 'provider'];

  for (const key of Object.keys(node)) {
    const lower = key.toLowerCase();
    if (SKIP_KEYS.includes(lower)) continue;
    if (COMMENT_KEYS.includes(lower)) {
      const text = extractText(node[key]);
      if (text && text.length > 1) return text;
    }
  }
  for (const key of Object.keys(node)) {
    const lower = key.toLowerCase();
    if (SKIP_KEYS.includes(lower)) continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      const found = deepFindComments(child, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

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

export function extractADFFromBody(body: string): string | null {
  if (!body) return null;

  const adfPatterns = [
    /(<\?adf[\s\S]*?<\/adf>)/i,
    /(<adf[\s\S]*?<\/adf>)/i,
    /(<prospect[\s\S]*?<\/prospect>)/i,
  ];

  for (const pattern of adfPatterns) {
    const match = body.match(pattern);
    if (match) {
      let xml = match[1];
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
    /*
     * FIX: <vehicle> may be an ARRAY (multi-vehicle ADF from Autotrader /
     * Cars.com). Previously an array here silently broke every vehicle
     * field AND hid vehicle-level customer comments.
     */
    const vehicles = Array.isArray(prospect.vehicle)
      ? prospect.vehicle
      : prospect.vehicle
        ? [prospect.vehicle]
        : [];
    const vehicle = vehicles[0];
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
    /*
     * FIX: the customer's actual message can live in MANY places depending
     * on the source. Previously only customer-level and prospect-level
     * comments were checked, so messages sent inside <vehicle><comments>
     * (very common: Autotrader, Cars.com, DealersCloud forwards) or other
     * variants were silently dropped — leads displayed with no customer
     * message at all. Now checked, in order of preference:
     *   1. <prospect><customer><comments>          (ADF standard)
     *   2. <prospect><customer><contact><comments> (nested variant)
     *   3. <prospect><comments>                    (prospect-level)
     *   4. <vehicle><comments> on ANY vehicle      (marketplace variant)
     *   5. deep scan for any remaining comments/notes/message node
     */
    let comments = '';
    const commentCandidates: any[] = [
      prospect.customer?.comments,
      prospect.customer?.contact?.comments,
      prospect.comments,
      ...vehicles.map((v: any) => v?.comments),
    ];
    for (const candidate of commentCandidates) {
      const text = extractText(candidate);
      if (text) {
        comments = text;
        break;
      }
    }
    if (!comments) {
      comments = deepFindComments(prospect);
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

/** Decode the HTML entities DealersCloud leaves in plain-text summaries. */
function decodeHtmlEntities(text: string): string {
  return (text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

/**
 * Extract the customer's free-text inquiry from a PLAIN-TEXT lead summary.
 *
 * DealersCloud (and similar aggregators) forward marketplace leads as a
 * single pipe-delimited line. The ADF part of the email — when present —
 * often OMITS the customer's message entirely; the message exists only in
 * this plain-text summary, e.g.:
 *
 *   2026-08-12T02:35:09 2025 JEEP WRANGLER 4XE 1C4RJ... Yahaira Martinez
 *   y@icloud.com 432-232-5816 View Shopper Signals: https://... |
 *   I'm interested in this 2025 Jeep Wrangler 4xe and I'd like to know if
 *   it's still available. (CarGurus IMV: $30,633 / Deal Rating: ...) |
 *   Likelihood to buy: Warm, VIN:..., Stock#:...
 *
 * Strategy: split on pipes, strip trailing "(...metadata...)" parentheticals,
 * and keep the first segment that reads like a human message rather than
 * metadata (no URLs, emails, VINs, or known metadata prefixes).
 */
export function extractPlainTextInquiry(rawBody: string): string {
  if (!rawBody) return '';

  // Convert HTML to text while PRESERVING line structure (labeled sections
  // like "SHOPPER COMMENT:" depend on line/paragraph boundaries).
  const multiline = decodeHtmlEntities(
    rawBody
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\r\n/g, '\n');

  const text = multiline.replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const METADATA_PREFIXES = [
    'view shopper signals', 'likelihood to buy', 'cargurus', 'deal rating',
    'is from shippable', 'delivery cost', 'price + delivery', 'vin:',
    'stock#', 'stock #', 'sales lead', 'lead details', 'contact information',
    'vehicle interest', 'request date', 'dealer/vendor', 'unsubscribe',
    'lead type', 'tracking', 'pixall', 'tcpaoptin',
  ];
  const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;
  const EMAIL_RE = /[^\s]+@[^\s]+\.[^\s]+/;
  const URL_RE = /https?:\/\//i;

  /*
   * PASS 1 — labeled section (AutoTrader "SHOPPER COMMENT:", generic
   * "Comments:"/"Message:" etc.). Works on the MULTILINE text and captures
   * from the label to the next blank line or the next ALL-CAPS section
   * header (e.g. "VEHICLE OF INTEREST:", "TRACKING:"), so it never bleeds
   * into the sections that follow.
   */
  const labelMatch = multiline.match(
    /\b(?:shopper\s+comments?|customer\s+comments?|comments?|customer\s+message|message|inquiry)\s*:\s*/i
  );
  if (labelMatch && labelMatch.index !== undefined) {
    const after = multiline.slice(labelMatch.index + labelMatch[0].length);
    const stop = after.search(/\n\s*\n|\n[A-Z][A-Z0-9 \/#&'.-]{2,}:\s*(?:\n|$)/);
    let candidate = (stop >= 0 ? after.slice(0, stop) : after.slice(0, 600))
      .replace(/\s+/g, ' ')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim();
    if (
      candidate.length >= 10 &&
      candidate.length <= 600 &&
      !URL_RE.test(candidate) &&
      !VIN_RE.test(candidate) &&
      /[a-zA-Z]{3}/.test(candidate)
    ) {
      return candidate;
    }
  }

  // PASS 2 — pipe-delimited summary (DealersCloud/CarGurus format).
  const segments = text.split('|').map((seg) => seg.trim()).filter(Boolean);
  for (const segment of segments) {
    // Remove trailing "(CarGurus IMV: ... )"-style metadata parentheticals.
    const cleaned = segment.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (cleaned.length < 15 || cleaned.length > 600) continue;

    const lower = cleaned.toLowerCase();
    if (METADATA_PREFIXES.some((pfx) => lower.startsWith(pfx))) continue;
    if (URL_RE.test(cleaned) || VIN_RE.test(cleaned)) continue;
    /*
     * FIX: customers often include their own email INSIDE the message
     * ("You can reach me by email at ..."). Only reject an email-bearing
     * segment when it does NOT read like a sentence — otherwise real
     * messages were dropped and the raw summary leaked into the UI.
     */
    const sentenceLike = /[.!?]/.test(cleaned) && cleaned.split(/\s+/).length >= 6;
    if (EMAIL_RE.test(cleaned) && !sentenceLike) continue;
    if (!/[a-zA-Z]{3}/.test(cleaned)) continue;
    if (cleaned.split(' ').length < 4) continue;

    return cleaned;
  }
  return '';
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
  comments: string;
}> {
  // Check for ADF content
  const adfXml = extractADFFromBody(body);
  if (adfXml) {
    const adfData = await parseADF(adfXml);
    if (adfData) {
      /*
       * FIX: aggregators (DealersCloud forwarding CarGurus/Autotrader/etc.)
       * often OMIT the customer's message from the ADF part and carry it
       * only in the plain-text summary of the same email. When the ADF has
       * no comments, recover the message from the surrounding plain text so
       * it is stored on the lead and shown in the conversation card.
       */
      if (!adfData.comments) {
        const plainInquiry = extractPlainTextInquiry(body);
        if (plainInquiry) {
          adfData.comments = plainInquiry;
          if (!adfData.parsedContent.includes(plainInquiry)) {
            adfData.parsedContent = `${adfData.parsedContent}\n\n— Customer Comments —\n${plainInquiry}`;
          }
        }
      }
      return {
        parsedContent: adfData.parsedContent,
        channel: 'adf',
        adfData,
        comments: adfData.comments || '',
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
    comments: extractPlainTextInquiry(body),
  };
}