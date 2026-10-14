import sanitizeHtml from 'sanitize-html';

export const EMAIL_SAFE_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'a', 'blockquote'];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: EMAIL_SAFE_TAGS,
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }, true),
  },
};

const STRIP_ALL_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
};

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (match, entity) => HTML_ENTITY_MAP[entity] ?? match);
}

export function sanitizeEmailHtml(rawHtml: string): string {
  if (!rawHtml) return '';
  return sanitizeHtml(rawHtml, SANITIZE_OPTIONS).trim();
}

export function htmlToPlainText(html: string): string {
  if (!html) return '';
  const withBreaks = html
    .replace(/<\s*(br)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h1|h2|h3|blockquote)\s*>/gi, '\n\n');
  const stripped = sanitizeHtml(withBreaks, STRIP_ALL_OPTIONS);
  return decodeHtmlEntities(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
