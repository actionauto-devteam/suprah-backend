import sanitizeHtml from 'sanitize-html';

export const EMAIL_SAFE_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'a', 'blockquote', 'img'];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: EMAIL_SAFE_TAGS,
  allowedAttributes: {
    a: ['href', 'target', 'rel', 'style'],
    img: ['src', 'alt', 'style'],
    p: ['style'],
    h1: ['style'],
    h2: ['style'],
    h3: ['style'],
    ul: ['style'],
    ol: ['style'],
    li: ['style'],
    blockquote: ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https'],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    p: sanitizeHtml.simpleTransform('p', { style: 'margin:0 0 12px 0;' }, true),
    h1: sanitizeHtml.simpleTransform('h1', { style: 'margin:16px 0 8px 0;font-size:22px;font-weight:bold;' }, true),
    h2: sanitizeHtml.simpleTransform('h2', { style: 'margin:14px 0 8px 0;font-size:19px;font-weight:bold;' }, true),
    h3: sanitizeHtml.simpleTransform('h3', { style: 'margin:12px 0 6px 0;font-size:16px;font-weight:bold;' }, true),
    ul: sanitizeHtml.simpleTransform('ul', { style: 'margin:0 0 12px 0;padding-left:20px;' }, true),
    ol: sanitizeHtml.simpleTransform('ol', { style: 'margin:0 0 12px 0;padding-left:20px;' }, true),
    li: sanitizeHtml.simpleTransform('li', { style: 'margin:0 0 4px 0;' }, true),
    blockquote: sanitizeHtml.simpleTransform(
      'blockquote',
      { style: 'margin:0 0 12px 0;padding-left:12px;border-left:3px solid #d1d5db;color:#6b7280;' },
      true,
    ),
    a: sanitizeHtml.simpleTransform(
      'a',
      { target: '_blank', rel: 'noopener noreferrer nofollow', style: 'color:#2563eb;text-decoration:underline;' },
      true,
    ),
    img: sanitizeHtml.simpleTransform('img', { style: 'max-width:100%;height:auto;display:block;margin:8px 0;border-radius:4px;' }, true),
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
  const withImages = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const altMatch = tag.match(/alt\s*=\s*"([^"]*)"/i) || tag.match(/alt\s*=\s*'([^']*)'/i);
    const alt = altMatch ? altMatch[1].trim() : '';
    return alt ? `[Image: ${alt}]` : '[Image]';
  });
  const withBreaks = withImages
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
