import AiAgentCoachingRule from '../models/AiAgentCoachingRule.model';

const MAX_COACHING_CANDIDATES = 50;
const MAX_RULE_LENGTH = 320;
const MAX_TOTAL_LENGTH = 6000;

export interface AiCoachingCandidate {
  id: string;
  instruction: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const cleanInstruction = (value: unknown) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RULE_LENGTH);

export async function getRelevantAiCoaching(input: {
  organizationId: string;
  channel: 'sms' | 'webchat';
}): Promise<{ notes: string[]; ids: string[]; rules: AiCoachingCandidate[] }> {
  const rules = await AiAgentCoachingRule.find({
    organizationId: input.organizationId,
    status: 'active',
    channel: { $in: ['all', input.channel] },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(MAX_COACHING_CANDIDATES)
    .select('_id instruction createdAt updatedAt')
    .lean();

  const notes: string[] = [];
  const ids: string[] = [];
  const candidates: AiCoachingCandidate[] = [];
  let total = 0;

  for (const rule of rules) {
    const note = cleanInstruction(rule.instruction);
    if (!note) continue;
    if (total + note.length > MAX_TOTAL_LENGTH) break;
    notes.push(note);
    ids.push(String(rule._id));
    candidates.push({
      id: String(rule._id),
      instruction: note,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });
    total += note.length;
  }

  return { notes, ids, rules: candidates };
}

export async function markAiCoachingUsed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await AiAgentCoachingRule.updateMany(
    { _id: { $in: ids } },
    { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
  ).catch(() => undefined);
}
