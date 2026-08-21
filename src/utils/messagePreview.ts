const DOUBLE_BRACE_CONTROL_TAG = /\{\{\s*(\/?)\s*(color|font|size)(?:\s*:\s*([^{}\n]+?))?\s*\}\}/gi;
const SINGLE_BRACE_CONTROL_TAG = /\{\s*(?:color|font|size)\s*:\s*[^{}\n]+\s*\}|\{\s*\/\s*(?:color|font|size)\s*\}/gi;
const EMPTY_CONTROL_WRAPPER = /\{\s*(color|font|size)\s*:\s*([^{}\n]+?)\s*\}([\s*_~`]*)\{\s*\/\s*\1\s*\}/gi;
const FORMAT_ONLY_LINE = /(^|\n)[ \t]*(?:\*{2,}|_{2,}|~{2,})[ \t]*(?=\n|$)/g;


function repairSingleSidedBoldMarkerLine(line: string): string {
  const visible = line.replace(SINGLE_BRACE_CONTROL_TAG, '').trim();
  if (!visible) return line;
  const markerCount = (visible.match(/\*\*/g) || []).length;
  if (markerCount !== 1) return line;

  if (visible.startsWith('**') && !visible.endsWith('**')) {
    return line.replace(
      /((?:[ \t]*\{\s*\/\s*(?:color|font|size)\s*\})*[ \t]*)$/i,
      '**$1',
    );
  }
  if (visible.endsWith('**') && !visible.startsWith('**')) {
    return line.replace(
      /^(\s*(?:\{\s*(?:color|font|size)\s*:\s*[^{}\n]+\s*\}\s*)*)/i,
      '$1**',
    );
  }
  return line;
}

function repairSingleSidedBoldMarkers(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(repairSingleSidedBoldMarkerLine)
    .join('\n');
}

function normalizeLegacyMessageMarkup(content: string): string {
  let normalized = content.replace(
    DOUBLE_BRACE_CONTROL_TAG,
    (_match, closingSlash: string, rawKind: string, rawValue?: string) => {
      const kind = rawKind.toLowerCase();
      if (closingSlash) return `{/${kind}}`;

      const value = (rawValue || '').trim();
      if (!value) return '';
      if (kind === 'color') {
        return /^#[0-9a-f]{3,8}$/i.test(value)
          ? `{color:${value.toLowerCase()}}`
          : '';
      }
      if (kind === 'font') {
        return /^[a-z-]+$/i.test(value)
          ? `{font:${value.toLowerCase()}}`
          : '';
      }
      if (kind === 'size') {
        return /^\d{1,3}$/.test(value)
          ? `{size:${Number.parseInt(value, 10)}}`
          : '';
      }
      return '';
    },
  );

  let previous = '';
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(EMPTY_CONTROL_WRAPPER, '');
  }

  normalized = normalized.replace(FORMAT_ONLY_LINE, '$1');
  return repairSingleSidedBoldMarkers(normalized);
}

export function stripMessageFormatting(content: string): string {
  if (!content) return '';
  return normalizeLegacyMessageMarkup(content)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(SINGLE_BRACE_CONTROL_TAG, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[^\w*])_([^_\n]+)_(?!\w)/g, '$1$2')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/\*{2,}/g, '')
    .replace(FORMAT_ONLY_LINE, '$1')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Truncates to maxLength and appends "..." only when it actually cut something off. */
export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}