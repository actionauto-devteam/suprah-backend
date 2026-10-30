const HIDDEN_CHARACTERS = /[­​-‏‪-‮⁠-⁩﻿]/g;
const UNICODE_DASHES = /[‐-―−]/g;

export function escapeSearchRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cleanSearchText(raw: unknown, maxLength: number): string {
  return String(raw ?? '')
    .replace(HIDDEN_CHARACTERS, '')
    .replace(UNICODE_DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

export function phoneSearchDigits(search: string): string | null {
  const digits = search.replace(/\D/g, '');
  const phoneLike = search.replace(/[\s()+.-]/g, '');
  return digits.length >= 4 && digits.length === phoneLike.length ? digits : null;
}
