/** Matches @[Display Name](24-hex-user-id) or @[all](all). */
export const MENTION_TOKEN_REGEX = /@\[([^\]\n]{1,80})\]\(([a-fA-F0-9]{24}|all)\)/g;

export interface ExtractedMentions {
  /** De-duplicated user ids mentioned in the content (excludes "all"). */
  userIds: string[];
  /** True when the content contains an @[all](all) token. */
  mentionsAll: boolean;
}

/** Pull all mention targets out of a piece of content. */
export function extractMentions(content: string): ExtractedMentions {
  const userIds = new Set<string>();
  let mentionsAll = false;

  const re = new RegExp(MENTION_TOKEN_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content || '')) !== null) {
    if (match[2] === 'all') mentionsAll = true;
    else userIds.add(match[2]);
  }

  return { userIds: Array.from(userIds), mentionsAll };
}

/**
 * Replace mention tokens with plain "@Name" text — used for notification
 * snippets and for validating the *visible* length of content (tokens inflate
 * the raw string well beyond what the author actually typed).
 */
export function stripMentionTokens(content: string): string {
  return (content || '').replace(
    new RegExp(MENTION_TOKEN_REGEX.source, 'g'),
    (_full, name: string, id: string) => (id === 'all' ? '@Everyone' : `@${name}`),
  );
}

/** Human-readable, single-line snippet for notification rows. */
export function buildSnippet(content: string, max = 140): string {
  const plain = stripMentionTokens(content).replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}