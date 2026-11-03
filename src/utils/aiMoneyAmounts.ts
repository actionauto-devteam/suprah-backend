const AMOUNT_PATTERN = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|grand)\b)?|\bUSD\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:k|grand|bucks|dollars?|USD)\b|\b\d+(?:\.\d+)?\s?(?:%|percent\b)/gi;
const FINANCE_WORDS = /\bfinanc(?:e|ing)\b|\bloans?\b|\blease[ds]?\b|\bAPR\b|\bdown payment\b|\bmonthly payments?\b|\bcredit approv(?:al|ed)\b|\/\s?mo\b/i;
const TERM_PATTERN = /\b\d[\d,.]*\s?(?:months?|mos?|yrs?|years?|apr)\b|\b(?:apr|rate)\s?(?:of\s)?\d[\d.]*%?/gi;

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim();
const round = (value: number) => Math.round(value * 100) / 100;

function sentences(text: string): string[] {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

function amountKey(raw: string): string | null {
  const text = raw.toLowerCase();
  const digits = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!digits) return null;
  const value = parseFloat(digits[0].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  if (/%|percent/.test(text)) return `pct:${round(value)}`;
  return `usd:${round(/\d\s?(?:k|grand)\b/.test(text) ? value * 1000 : value)}`;
}

export function moneyFigures(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const keep = (value: string) => {
    const label = tidy(value);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    found.push(label);
  };
  for (const sentence of sentences(text)) {
    const taken: Array<[number, number]> = [];
    for (const match of sentence.matchAll(AMOUNT_PATTERN)) {
      const start = match.index ?? 0;
      taken.push([start, start + match[0].length]);
      keep(match[0]);
    }
    if (!FINANCE_WORDS.test(sentence)) continue;
    for (const match of sentence.matchAll(TERM_PATTERN)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (taken.some(([from, to]) => start < to && end > from)) continue;
      keep(match[0]);
    }
  }
  return found;
}

export function moneyKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of String(text || '').matchAll(AMOUNT_PATTERN)) {
    const key = amountKey(match[0]);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

export function sameMoneyFigures(saved: unknown, current: string[]): boolean {
  if (!Array.isArray(saved) || !current.length) return false;
  const normalize = (values: unknown[]) => Array.from(new Set(values.map((value) => tidy(String(value || '')).toLowerCase()).filter(Boolean))).sort();
  const a = normalize(saved);
  const b = normalize(current);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
