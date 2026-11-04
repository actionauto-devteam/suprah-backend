import mongoose from 'mongoose';
import Organization from '../models/Organization.model';
import CrmLocation from '../models/CrmLocation.model';
import { normalizeLocationKey } from '../utils/locationKey';
import { moneyFigures, sameMoneyFigures } from '../utils/aiMoneyAmounts';
import logger from '../utils/logger';

export type KnowledgeReplyChannel = 'sms' | 'webchat';

export interface KnowledgeAnswer {
  id: string;
  kind: string;
  topic: string;
  title: string;
  question?: string;
  answer: string;
  approvedAmounts?: string[];
}

const MAX_CANDIDATES = 40;
const MAX_ENTRIES_READ = 500;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'can', 'what', 'when', 'where', 'how', 'does', 'did', 'have', 'has', 'with',
  'that', 'this', 'there', 'they', 'any', 'about', 'want', 'need', 'would', 'could', 'just', 'like', 'from', 'will',
  'yes', 'okay', 'thanks', 'thank', 'please', 'hello', 'hey', 'still', 'get', 'got', 'its', 'our', 'out', 'too', 'also',
]);

const TOPIC_HINTS: Record<string, RegExp> = {
  hours: /\b(hours?|open|close[sd]?|closing|today|tomorrow|tonight|sunday|saturday|weekend|holiday)\b/,
  address_directions: /\b(address|located|location|where|directions?|find you|parking)\b/,
  contact: /\b(phone|call|email|number|contact|website)\b/,
  departments: /\b(department|manager|finance office|parts|sales team)\b/,
  test_drives: /\b(test drive|drive it|try it)\b/,
  appointments: /\b(appointment|schedule|book|reserve a time|come in)\b/,
  documents_required: /\b(bring|documents?|license|insurance|paperwork|proof)\b/,
  trade_in_process: /\b(trade|trading|appraisal)\b/,
  financing_process: /\b(financ\w*|loan|credit|down payment|deposit|monthly|apr|rate)\b/,
  delivery_shipping: /\b(deliver\w*|ship\w*|out of state)\b/,
  service: /\b(service|oil|repair|maintenance)\b/,
  warranty: /\b(warrant\w*|guarantee|coverage)\b/,
};

const wordsOf = (text: string): Set<string> =>
  new Set(normalizeLocationKey(text).split(' ').map((word) => word.replace(/s$/, '')).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));

function relevanceScore(entry: any, customerText: string, customerWords: Set<string>): number {
  const entryWords = wordsOf([entry.question, entry.title].filter(Boolean).join(' '));
  let score = 0;
  for (const word of entryWords) if (customerWords.has(word)) score += 1;
  const hint = TOPIC_HINTS[entry.topic];
  if (hint && hint.test(customerText)) score += 2;
  return score;
}

export async function knowledgeRepliesEnabled(organizationId: string): Promise<boolean> {
  if (process.env.AI_KNOWLEDGE_BASE_ENABLED !== 'true') return false;
  if (!mongoose.isValidObjectId(organizationId)) return false;
  const org: any = await Organization.findById(organizationId).select('metadata.aiKnowledgeBaseEnabled metadata.aiKnowledgeRepliesEnabled').lean();
  return org?.metadata?.aiKnowledgeBaseEnabled === true && org?.metadata?.aiKnowledgeRepliesEnabled === true;
}

async function locationIdFor(organizationId: string, raw: unknown): Promise<string | null> {
  const key = normalizeLocationKey(raw);
  if (!key) return null;
  const locations: any[] = await CrmLocation.find({ organizationId, status: 'active' }).select('_id name aliasKeys').lean();
  const match = locations.find((location) => normalizeLocationKey(location.name) === key || (location.aliasKeys || []).includes(key));
  return match ? String(match._id) : null;
}

function approvedFor(entry: any, locationId: string | null): boolean {
  const scope = entry.approvedLocationScope;
  if (!scope) return false;
  const suspended = new Set((entry.approvalSuspendedLocationIds || []).map(String));
  if (scope.scope === 'all') return !locationId || !suspended.has(locationId);
  const ids = (scope.locationIds || []).map(String).filter((id: string) => !suspended.has(id));
  return Boolean(locationId) && ids.includes(locationId as string);
}

export function customerTextOf(transcript: Array<{ from: string; body: string }>): string {
  return transcript.filter((entry) => entry.from === 'customer').slice(-2).map((entry) => String(entry.body || '')).join('\n');
}

export async function loadReplyKnowledge(input: {
  organizationId: string;
  channel: KnowledgeReplyChannel;
  location?: unknown;
  transcript: Array<{ from: string; body: string }>;
}): Promise<KnowledgeAnswer[]> {
  try {
    if (!(await knowledgeRepliesEnabled(input.organizationId))) return [];
    const db = mongoose.connection.db;
    if (!db) return [];
    const entries: any[] = await db.collection('aiknowledgeentries').find({
      organizationId: String(input.organizationId),
      lifecycle: 'active',
      approvedVersion: { $gte: 1 },
      approvalInvalidation: null,
    }).project({ kind: 1, topic: 1, title: 1, question: 1, approvedVersion: 1, approvedLocationScope: 1, approvalSuspendedLocationIds: 1, amountApproval: 1, updatedAt: 1 })
      .sort({ updatedAt: -1 }).limit(MAX_ENTRIES_READ).toArray();
    if (!entries.length) return [];
    const locationId = await locationIdFor(input.organizationId, input.location);
    let eligible = entries.filter((entry) => approvedFor(entry, locationId));
    if (eligible.length > MAX_CANDIDATES) {
      const customerText = customerTextOf(input.transcript).toLowerCase();
      const customerWords = wordsOf(customerText);
      eligible = eligible
        .map((entry, index) => ({ entry, index, score: relevanceScore(entry, customerText, customerWords) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, MAX_CANDIDATES)
        .map((row) => row.entry);
    }
    if (!eligible.length) return [];
    const versions: any[] = await db.collection('aiknowledgeentryversions').find({
      organizationId: String(input.organizationId),
      $or: eligible.map((entry) => ({ entryId: entry._id, version: entry.approvedVersion })),
    }).project({ entryId: 1, version: 1, content: 1 }).toArray();
    const byEntry = new Map(versions.map((row) => [`${row.entryId}:${row.version}`, row.content]));
    const answers: KnowledgeAnswer[] = [];
    for (const entry of eligible) {
      const content = byEntry.get(`${entry._id}:${entry.approvedVersion}`);
      const answer = String(content?.answer || '').trim();
      if (!answer || !(content.channels || []).includes(input.channel)) continue;
      const amounts = moneyFigures(answer);
      if (amounts.length && !sameMoneyFigures(entry.amountApproval?.amounts, amounts)) continue;
      answers.push({
        id: String(entry._id),
        kind: String(content.kind || entry.kind),
        topic: String(content.topic || entry.topic || 'general'),
        title: String(content.title || entry.title || ''),
        ...(content.question ? { question: String(content.question) } : {}),
        answer,
        ...(amounts.length ? { approvedAmounts: amounts } : {}),
      });
    }
    return answers;
  } catch (err: any) {
    logger.warn({ organizationId: input.organizationId, errorName: err?.name }, '[KnowledgeRuntime] Approved answers could not be loaded; replying without them');
    return [];
  }
}
