export const AI_HANDOFF_TOPICS = [
  { key: 'availability', label: 'Vehicle availability' },
  { key: 'pricing', label: 'Price and deals' },
  { key: 'financing', label: 'Financing and credit' },
  { key: 'trade_in', label: 'Trade-in' },
  { key: 'appointment', label: 'Test drive and appointments' },
  { key: 'media', label: 'Photos and videos' },
  { key: 'shipping', label: 'Shipping and delivery' },
  { key: 'person', label: 'Wants a call or a person' },
  { key: 'other', label: 'Other' },
] as const;

export type AiHandoffTopic = (typeof AI_HANDOFF_TOPICS)[number]['key'];

export const AI_HANDOFF_TOPIC_KEYS: AiHandoffTopic[] = AI_HANDOFF_TOPICS.map((topic) => topic.key);

const TOPIC_ALIASES: Record<string, AiHandoffTopic> = {
  availability: 'availability',
  available: 'availability',
  inventory: 'availability',
  stock: 'availability',
  hold: 'availability',
  pricing: 'pricing',
  price: 'pricing',
  deal: 'pricing',
  deals: 'pricing',
  negotiation: 'pricing',
  discount: 'pricing',
  financing: 'financing',
  finance: 'financing',
  credit: 'financing',
  loan: 'financing',
  trade_in: 'trade_in',
  tradein: 'trade_in',
  trade: 'trade_in',
  appointment: 'appointment',
  appointments: 'appointment',
  test_drive: 'appointment',
  testdrive: 'appointment',
  visit: 'appointment',
  media: 'media',
  photo: 'media',
  photos: 'media',
  video: 'media',
  videos: 'media',
  walkaround: 'media',
  walk_around: 'media',
  shipping: 'shipping',
  ship: 'shipping',
  delivery: 'shipping',
  transport: 'shipping',
  person: 'person',
  human: 'person',
  call: 'person',
  callback: 'person',
  other: 'other',
};

const TOPIC_WORDS: Array<[AiHandoffTopic, RegExp]> = [
  ['financing', /\b(financ\w*|credit|loan|lender|apr|down payment|monthly payments?|lease)\b/i],
  ['trade_in', /\b(trade[- ]?ins?|trading in|payoff|appraisal)\b/i],
  ['shipping', /\b(ship\w*|deliver\w*|transport\w*)\b/i],
  ['media', /\b(videos?|walk[- ]?arounds?|photos?|pictures?|pics)\b/i],
  ['appointment', /\b(test[- ]?drives?|appointments?|schedul\w*|come in|stop by|book\w*)\b/i],
  ['pricing', /\b(price\w*|discount\w*|deals?|offers?|negotiat\w*|out[- ]the[- ]door|otd|lowest|best price)\b/i],
  ['availability', /\b(availab\w*|on the lot|still (have|there|for sale|in stock)|in stock|hold (it|the|this)|sold)\b/i],
  ['person', /\b(call (me|back)|callback|phone call|talk to|speak (to|with)|real person|human|manager|representative)\b/i],
];

export function normalizeAiHandoffTopic(raw: unknown): AiHandoffTopic | null {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '');
  return TOPIC_ALIASES[key] || null;
}

export function guessAiHandoffTopic(text: unknown): AiHandoffTopic {
  const value = String(text ?? '');
  for (const [topic, pattern] of TOPIC_WORDS) {
    if (pattern.test(value)) return topic;
  }
  return 'other';
}

export function aiHandoffTopicLabel(topic: AiHandoffTopic | null | undefined): string | null {
  return AI_HANDOFF_TOPICS.find((entry) => entry.key === topic)?.label || null;
}

export function cleanAiHandoffTopicTeams(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const key of AI_HANDOFF_TOPIC_KEYS) {
    const value = String((raw as Record<string, unknown>)[key] ?? '').trim();
    if (/^[a-f0-9]{24}$/i.test(value)) result[key] = value;
  }
  return result;
}

export const AI_HANDOFF_MARKER_TOPIC_LIST = AI_HANDOFF_TOPIC_KEYS.join(', ');
