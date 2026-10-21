import mongoose from 'mongoose';
import { AI_AGENT_DRAFT_COLLECTION, AI_AGENT_DRAFT_REPORTING_INDEXES, AiAgentDraftReportingIndex } from '../constants/aiAgentDraftIndexes';

type StoredIndex = mongoose.mongo.IndexDescriptionInfo;

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));
}

function matches(actual: StoredIndex, expected: AiAgentDraftReportingIndex): boolean {
  return sameKeys(actual.key, expected.key) && !actual.unique && !actual.partialFilterExpression && !actual.sparse
    && actual.expireAfterSeconds === undefined && !actual.hidden;
}

async function readIndexes(collection: string): Promise<StoredIndex[]> {
  if (!mongoose.connection.db || mongoose.connection.readyState !== 1) throw new Error('A connected database is required');
  try {
    return await mongoose.connection.db.collection(collection).listIndexes({ maxTimeMS: 5000 }).toArray();
  } catch (error) {
    if ((error as { code?: number }).code === 26) return [];
    throw error;
  }
}

export async function verifyAiAgentDraftReportingIndexes(collection: string = AI_AGENT_DRAFT_COLLECTION) {
  const actual = await readIndexes(collection);
  const required = AI_AGENT_DRAFT_REPORTING_INDEXES.map((expected) => {
    const match = actual.find((index) => matches(index, expected));
    const nameConflict = actual.find((index) => index.name === expected.name && !matches(index, expected));
    const state = nameConflict ? 'incorrect' : match ? 'present' : 'missing';
    return { name: expected.name, key: expected.key, state, actualName: match?.name };
  });
  return { collection, ready: required.every((index) => index.state === 'present'), required };
}

export async function createAiAgentDraftReportingIndexes(collection: string = AI_AGENT_DRAFT_COLLECTION) {
  const before = await verifyAiAgentDraftReportingIndexes(collection);
  const incorrect = before.required.filter((index) => index.state === 'incorrect');
  if (incorrect.length) throw new Error(`Index name already used with a different definition: ${incorrect.map((index) => index.name).join(', ')}`);
  const created: string[] = [];
  for (const index of before.required.filter((item) => item.state === 'missing')) {
    await mongoose.connection.db!.collection(collection).createIndex(index.key, { name: index.name });
    created.push(index.name);
  }
  return { created, after: await verifyAiAgentDraftReportingIndexes(collection) };
}
