/**
 * Strips SupraSpace's inline rich-text syntax ({color:#hex}...{/color},
 * **bold**, __underline__, ~~strike~~, `code`, _italic_, *italic*) down to
 * plain text. Mirrors the frontend's messagePreviewText() (see
 * supra-space/page.tsx and ChatPopupManager.tsx) — used anywhere message
 * content is surfaced somewhere that can't render that markup, e.g. push
 * notification bodies and the notification-bell preview, which otherwise
 * show the raw tokens as literal characters.
 */
export function stripMessageFormatting(content: string): string {
  if (!content) return '';
  return content
    .replace(/\r\n?/g, '\n')
    .replace(/\{\s*color\s*:\s*#[0-9a-f]{3,8}\s*\}/gi, '')
    .replace(/\{\s*\/\s*color\s*\}/gi, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[^\w*])_([^_\n]+)_(?!\w)/g, '$1$2')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Truncates to maxLength and appends "..." only when it actually cut something off. */
export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}
