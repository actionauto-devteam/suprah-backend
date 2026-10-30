import { cleanSearchText, escapeSearchRegex, phoneSearchDigits } from './searchText';

const SEARCH_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'source',
  'sourceProvider',
  'vehicle.year',
  'vehicle.make',
  'vehicle.model',
  'vehicle.vin',
  'vehicle.stock',
];
const MAX_SEARCH_LENGTH = 100;
const MAX_SEARCH_WORDS = 6;
const SHORT_WORD_LENGTH = 2;

const inAnyField = (pattern: string) => SEARCH_FIELDS.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } }));

export function buildLeadSearchCondition(raw: unknown): Record<string, unknown> | null {
  const search = cleanSearchText(raw, MAX_SEARCH_LENGTH);
  if (!search) return null;

  const digits = phoneSearchDigits(search);
  if (digits) {
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    return {
      $or: [
        { normalizedPhone: { $regex: national } },
        { phone: { $regex: national.split('').join('\\D*') } },
        ...inAnyField(escapeSearchRegex(search)),
      ],
    };
  }

  const words = search.split(' ').slice(0, MAX_SEARCH_WORDS);
  const patternFor = (word: string) => {
    const escaped = escapeSearchRegex(word);
    return words.length > 1 && word.length <= SHORT_WORD_LENGTH ? `\\b${escaped}` : escaped;
  };
  return { $and: words.map((word) => ({ $or: inAnyField(patternFor(word)) })) };
}
