export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

export function decodeGmailData(data: string): string {
  const normalized = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(ul|ol|table|tr)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collect(part: GmailPart | undefined, plain: string[], html: string[]): void {
  if (!part) return;
  const type = String(part.mimeType || '').toLowerCase();
  const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
  if (!isAttachment && part.body?.data) {
    if (type === 'text/plain') plain.push(decodeGmailData(part.body.data));
    else if (type === 'text/html') html.push(decodeGmailData(part.body.data));
    else if (!type && !part.parts?.length) plain.push(decodeGmailData(part.body.data));
  }
  for (const child of part.parts || []) collect(child, plain, html);
}

export function extractGmailText(message: { payload?: GmailPart } | null | undefined): string {
  const plain: string[] = [];
  const html: string[] = [];
  collect(message?.payload, plain, html);
  const text = plain.map((value) => value.trim()).filter(Boolean).join('\n\n');
  if (text) return text.replace(/\r\n/g, '\n').trim();
  return htmlToText(html.join('\n'));
}

export function gmailHeader(message: { payload?: GmailPart } | null | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return message?.payload?.headers?.find((header) => String(header?.name || '').toLowerCase() === wanted)?.value || '';
}

export function gmailAttachmentNames(message: { payload?: GmailPart } | null | undefined): string[] {
  const names: string[] = [];
  const walk = (part?: GmailPart) => {
    if (!part) return;
    if (part.filename) names.push(part.filename);
    for (const child of part.parts || []) walk(child);
  };
  walk(message?.payload);
  return names;
}

const QUOTE_MARKERS = [
  /^On .{4,200}wrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^_{5,}\s*$/m,
  /^From:\s.+\r?\n(Sent|Date):\s.+$/im,
];

export function stripQuotedReply(text: string): string {
  const source = String(text || '').replace(/\r\n/g, '\n');
  let cut = source.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(source);
    if (match && match.index > 0 && match.index < cut) cut = match.index;
  }
  const kept = source.slice(0, cut).split('\n');
  while (kept.length && /^\s*>/.test(kept[kept.length - 1])) kept.pop();
  const result = kept.join('\n').trim();
  return result || source.trim();
}
